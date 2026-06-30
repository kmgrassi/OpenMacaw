#!/usr/bin/env node
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let sessionId = null;
let sessionOptions = {};
let sdkSessionId = null;
let queryHandle = null;
let outputPump = null;
let activeTurn = null;
let stopped = false;
let promptResolver = null;
const promptQueue = [];
const pendingPermissions = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  write({ id, result: payload });
}

function failure(id, reason, retryable = false) {
  write({ id, error: { reason, retryable } });
}

function event(method, params) {
  write({ method, params });
}

function nextPermissionId() {
  return `permission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sdkOptions() {
  const options = {
    cwd: sessionOptions.cwd,
    model: sessionOptions.model,
    permissionMode: sessionOptions.permissionMode,
    tools: sessionOptions.tools,
    allowedTools: sessionOptions.allowedTools,
    disallowedTools: sessionOptions.disallowedTools,
    maxTurns: sessionOptions.maxTurns,
    canUseTool
  };

  if (sdkSessionId) {
    options.resume = sdkSessionId;
  }

  return options;
}

async function* promptStream() {
  while (!stopped) {
    if (promptQueue.length > 0) {
      yield promptQueue.shift();
      continue;
    }

    await new Promise((resolve) => {
      promptResolver = resolve;
    });
  }
}

function enqueuePrompt(prompt) {
  promptQueue.push({
    type: "user",
    message: {
      role: "user",
      content: prompt
    },
    parent_tool_use_id: null,
    session_id: sdkSessionId || ""
  });

  if (promptResolver) {
    promptResolver();
    promptResolver = null;
  }
}

function ensureQueryStarted() {
  if (queryHandle) return;

  queryHandle = query({ prompt: promptStream(), options: sdkOptions() });
  outputPump = pumpSdkOutput();
}

async function pumpSdkOutput() {
  try {
    for await (const sdkMessage of queryHandle) {
      const nextSessionId = sdkMessage?.session_id || sdkMessage?.sessionId;
      if (nextSessionId) {
        sdkSessionId = nextSessionId;
      }

      event("sdk/message", sdkMessage);

      if (sdkMessage?.type === "assistant" && Array.isArray(sdkMessage.message?.content)) {
        for (const block of sdkMessage.message.content) {
          if (block?.type === "text" && block.text) {
            if (activeTurn) activeTurn.finalResult += block.text;
            event("message/delta", { textDelta: block.text });
          }
        }
      }

      if (sdkMessage?.type === "result") {
        if (sdkMessage.usage) {
          event("usage/updated", sdkMessage.usage);
        }

        if (activeTurn) {
          const finalResult = sdkMessage.result || activeTurn.finalResult;
          const currentSessionId = sdkSessionId || sessionId;
          event("turn/completed", { result: finalResult, sessionId: currentSessionId });
          result(activeTurn.id, { result: finalResult, sessionId: currentSessionId });
          activeTurn = null;
        }
      }
    }
  } catch (error) {
    const reason = error?.message || String(error);
    event("turn/failed", { reason, retryable: false });

    if (activeTurn) {
      failure(activeTurn.id, reason);
      activeTurn = null;
    }
  }
}

function normalizePermissionDecision(decision) {
  if (decision?.behavior === "deny") {
    return {
      behavior: "deny",
      message: decision.message || "Denied by host"
    };
  }

  return {
    behavior: "allow",
    updatedInput: decision?.updatedInput,
    updatedPermissions: decision?.updatedPermissions
  };
}

function canUseTool(toolName, input, options = {}) {
  const requestId = nextPermissionId();

  event("permission/requested", {
    requestId,
    toolName,
    input,
    suggestions: options.suggestions,
    blockedPath: options.blockedPath,
    decisionReason: options.decisionReason,
    title: options.title,
    displayName: options.displayName,
    description: options.description,
    toolUseId: options.toolUseID,
    agentId: options.agentID
  });

  write({
    id: requestId,
    method: "permission/can_use_tool",
    params: {
      requestId,
      toolName,
      input,
      suggestions: options.suggestions,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      toolUseId: options.toolUseID,
      agentId: options.agentID
    }
  });

  return new Promise((resolve, reject) => {
    const abort = () => {
      pendingPermissions.delete(requestId);
      reject(new Error("permission request aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abort();
        return;
      }

      options.signal.addEventListener("abort", abort, { once: true });
    }

    pendingPermissions.set(requestId, {
      resolve: (decision) => {
        if (options.signal) options.signal.removeEventListener("abort", abort);
        const normalized = normalizePermissionDecision(decision);
        event("permission/resolved", { requestId, ...normalized });
        resolve(normalized);
      },
      reject: (error) => {
        if (options.signal) options.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  });
}

async function handle(message) {
  if (message.id && pendingPermissions.has(message.id)) {
    const pending = pendingPermissions.get(message.id);
    pendingPermissions.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error?.reason || message.error?.message || "permission request failed"));
    } else {
      pending.resolve(message.result || {});
    }

    return;
  }

  if (message.method === "session/start") {
    sessionOptions = message.params || {};
    sessionId = `claude-code-${Date.now()}`;
    ensureQueryStarted();
    result(message.id, { sessionId });
    return;
  }

  if (message.method === "session/stop") {
    stopped = true;
    if (promptResolver) promptResolver();
    if (queryHandle?.close) queryHandle.close();
    if (outputPump) await outputPump.catch(() => {});
    result(message.id, { stopped: true });
    process.exit(0);
    return;
  }

  if (message.method === "turn/interrupt") {
    if (queryHandle?.interrupt) {
      await queryHandle.interrupt();
    }

    if (activeTurn) {
      event("turn/interrupted", { sessionId: sdkSessionId || sessionId });
      failure(activeTurn.id, "interrupted", false);
      activeTurn = null;
    }

    result(message.id, { interrupted: true });
    return;
  }

  if (message.method !== "turn/start") {
    failure(message.id, `unsupported method: ${message.method}`);
    return;
  }

  if (activeTurn) {
    failure(message.id, "turn already active", true);
    return;
  }

  try {
    activeTurn = { id: message.id, finalResult: "" };
    enqueuePrompt(message.params?.prompt || "");
  } catch (error) {
    event("turn/failed", { reason: error?.message || String(error), retryable: false });
    activeTurn = null;
    failure(message.id, error?.message || String(error));
  }
}

rl.on("line", async (line) => {
  if (!line.trim()) return;

  try {
    await handle(JSON.parse(line));
  } catch (error) {
    write({ error: { reason: error?.message || String(error), retryable: false } });
  }
});
