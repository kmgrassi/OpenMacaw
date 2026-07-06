#!/usr/bin/env node
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let sessionId = null;
let sessionOptions = {};

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

function toolPermissionParams(toolName, input, options) {
  return {
    tool: toolName,
    toolName,
    toolUseId: options?.toolUseID || options?.toolUseId || options?.tool_use_id,
    input,
    permissionMode: options?.permissionMode,
    decision: "allow",
    source: "can_use_tool"
  };
}

function sdkOptions(prompt) {
  const options = {
    prompt,
    options: {
      cwd: sessionOptions.cwd,
      model: sessionOptions.model,
      permissionMode: sessionOptions.permissionMode,
      tools: sessionOptions.tools,
      allowedTools: sessionOptions.allowedTools,
      disallowedTools: sessionOptions.disallowedTools,
      maxTurns: sessionOptions.maxTurns
    }
  };

  options.options.canUseTool = async (toolName, input, toolOptions) => {
    event("tool/can_use_tool", toolPermissionParams(toolName, input, toolOptions));
    return { behavior: "allow" };
  };

  if (sessionOptions.sdkSessionId) {
    options.options.resume = sessionOptions.sdkSessionId;
  }

  return options;
}

async function handle(message) {
  if (message.method === "session/start") {
    sessionOptions = message.params || {};
    sessionId = `claude-code-${Date.now()}`;
    result(message.id, { sessionId });
    return;
  }

  if (message.method === "session/stop") {
    result(message.id, { stopped: true });
    process.exit(0);
    return;
  }

  if (message.method !== "turn/start") {
    failure(message.id, `unsupported method: ${message.method}`);
    return;
  }

  let finalResult = "";

  try {
    for await (const sdkMessage of query(sdkOptions(message.params?.prompt || ""))) {
      const sdkSessionId = sdkMessage?.session_id || sdkMessage?.sessionId;
      if (sdkSessionId) {
        sessionOptions.sdkSessionId = sdkSessionId;
      }

      event("sdk/message", sdkMessage);

      if (sdkMessage?.type === "assistant" && Array.isArray(sdkMessage.message?.content)) {
        for (const block of sdkMessage.message.content) {
          if (block?.type === "text" && block.text) {
            finalResult += block.text;
            event("message/delta", { textDelta: block.text });
          }
        }
      }

      if (sdkMessage?.type === "result") {
        if (sdkMessage.usage) {
          event("usage/updated", sdkMessage.usage);
        }

        finalResult = sdkMessage.result || finalResult;
      }
    }

    const currentSessionId = sessionOptions.sdkSessionId || sessionId;
    event("turn/completed", { result: finalResult, sessionId: currentSessionId });
    result(message.id, { result: finalResult, sessionId: currentSessionId });
  } catch (error) {
    event("turn/failed", { reason: error?.message || String(error), retryable: false });
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
