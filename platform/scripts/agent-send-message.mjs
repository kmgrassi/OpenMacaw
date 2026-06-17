#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import {
  waitForGatewayEvent,
  waitForGatewayHello,
  waitForGatewayResponse,
  waitForSocketOpen,
} from "./lib/gateway-ws.mjs";

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status: "failed",
          finalStatus: "failed",
          agentId: args.agentId,
          workspaceId: args.workspaceId,
          error: message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`agent:send-message failed: ${message}`);
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }

  validateArgs(args);

  const startedAt = new Date();
  const result = {
    status: "running",
    finalStatus: "running",
    agentId: args.agentId,
    workspaceId: args.workspaceId,
    requestId: null,
    messageId: null,
    runId: null,
    sessionKey: args.sessionKey,
    diagnostic: null,
    runtimePreparation: null,
    runtimeObservation: null,
    messagesAfter: null,
    logSummary: null,
    followUpCommand: null,
    startedAt: startedAt.toISOString(),
    completedAt: null,
  };

  printStep("checking agent diagnostic");
  const diagnostic = await fetchDiagnostic(args);
  result.diagnostic = summarizeDiagnostic(diagnostic);
  if (diagnostic.canChat !== true) {
    result.status = "blocked";
    result.finalStatus = "diagnostic_blocked";
    result.completedAt = new Date().toISOString();
    await attachLogs(result);
    finish(result, 1);
    return;
  }

  printStep("preparing runtime");
  result.runtimePreparation = await prepareRuntime(args);

  printStep("connecting to gateway and sending chat turn");
  const gatewayResult = await sendGatewayMessage(args);
  result.requestId = gatewayResult.requestId;
  result.runId = gatewayResult.runId;
  result.runtimeObservation = gatewayResult.observation;

  printStep("polling message history");
  const messagePoll = await pollMessages(args, startedAt);
  result.messageId = messagePoll.userMessageId;
  result.messagesAfter = {
    userMessageVisible: Boolean(messagePoll.userMessageId),
    assistantMessageVisible: Boolean(messagePoll.assistantMessageId),
    assistantMessageId: messagePoll.assistantMessageId,
    totalMessages: messagePoll.totalMessages,
  };

  await attachLogs(result);
  result.completedAt = new Date().toISOString();

  if (gatewayResult.observation.status === "error") {
    result.status = "blocked";
    result.finalStatus = "runtime_blocker";
    finish(result, 1);
    return;
  }

  if (!messagePoll.userMessageId) {
    result.status = "failed";
    result.finalStatus = "message_not_visible";
    finish(result, 1);
    return;
  }

  if (gatewayResult.observation.status !== "completed") {
    result.status = "incomplete";
    result.finalStatus = "runtime_dispatch_incomplete";
    result.followUpCommand = runtimeFollowUpCommand(args);
    finish(result, 1);
    return;
  }

  result.status = "ok";
  result.finalStatus = "completed";
  finish(result, 0);
}

function parseArgs(argv) {
  const parsed = {
    agentId: null,
    workspaceId: null,
    message: null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? "http://127.0.0.1:3100",
    token: process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    sessionKey: null,
    timeoutMs: 60_000,
    pollIntervalMs: 2_000,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--agent-id") {
      parsed.agentId = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--message") {
      parsed.message = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--message=")) {
      parsed.message = arg.slice("--message=".length);
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.token = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--api-token=")) {
      parsed.token = arg.slice("--api-token=".length);
    } else if (arg === "--session-key") {
      parsed.sessionKey = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--session-key=")) {
      parsed.sessionKey = arg.slice("--session-key=".length);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requireValue(arg, value));
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--poll-interval-ms") {
      parsed.pollIntervalMs = Number(requireValue(arg, value));
      index += 1;
    } else if (arg.startsWith("--poll-interval-ms=")) {
      parsed.pollIntervalMs = Number(arg.slice("--poll-interval-ms=".length));
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.agentId = parsed.agentId?.trim() || null;
  parsed.workspaceId = parsed.workspaceId?.trim() || null;
  parsed.message = parsed.message?.trim() || null;
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");
  parsed.token = parsed.token?.trim() || null;
  parsed.sessionKey =
    parsed.sessionKey?.trim() ||
    (parsed.agentId ? `agent:${parsed.agentId}:main` : null);

  return parsed;
}

function validateArgs(parsed) {
  const missing = [];
  if (!parsed.agentId) missing.push("--agent-id");
  if (!parsed.workspaceId) missing.push("--workspace-id");
  if (!parsed.message) missing.push("--message");
  if (!parsed.token) missing.push("--api-token or PLATFORM_API_TOKEN");

  if (missing.length > 0) {
    throw new Error(`Missing required ${missing.join(", ")}`);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (!Number.isFinite(parsed.pollIntervalMs) || parsed.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive number");
  }
}

function usage() {
  return `Usage: pnpm run agent:send-message -- [options]

Options:
  --agent-id <id>          Agent to message
  --workspace-id <id>      Workspace context for diagnostics and gateway scope
  --message <text>         User message to send
  --api-base-url <url>     Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>      Supabase access token (or PLATFORM_API_TOKEN)
  --session-key <key>      Gateway session key (default: agent:<agent-id>:main)
  --timeout-ms <number>    Gateway/message polling timeout (default: 60000)
  --poll-interval-ms <n>   Message polling interval (default: 2000)
  --json                   Print machine-readable output
`;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function authHeaders() {
  return { authorization: `Bearer ${args.token}` };
}

async function httpJson(path, options = {}) {
  const url = new URL(path, args.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  const headers = {
    accept: "application/json",
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.auth === false ? {} : authHeaders()),
    ...(options.headers ?? {}),
  };

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const message =
        body?.error?.message ??
        body?.message ??
        text.slice(0, 300) ??
        response.statusText;
      throw new Error(
        `${url.pathname} returned ${response.status}: ${message}`,
      );
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${url.pathname} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchDiagnostic(parsed) {
  const path = new URL(
    `/api/diagnostic/agents/${encodeURIComponent(parsed.agentId)}`,
    parsed.apiBaseUrl,
  );
  path.searchParams.set("workspaceId", parsed.workspaceId);
  return await httpJson(`${path.pathname}${path.search}`, { auth: false });
}

function summarizeDiagnostic(diagnostic) {
  const profile = diagnostic?.executionProfile?.profile ?? null;
  return {
    canChat: diagnostic?.canChat ?? null,
    blockers: Array.isArray(diagnostic?.blockers) ? diagnostic.blockers : [],
    runnerKind:
      profile?.runnerKind ??
      diagnostic?.routing?.selectedRule?.runnerKind ??
      null,
    provider: profile?.provider ?? null,
    executionProfile: {
      resolved: diagnostic?.executionProfile?.resolved ?? null,
      missing: Array.isArray(diagnostic?.executionProfile?.missing)
        ? diagnostic.executionProfile.missing
        : [],
      source: diagnostic?.executionProfile?.source ?? null,
    },
    lastFailure:
      diagnostic?.lastFailure ??
      diagnostic?.health?.lastFailure ??
      diagnostic?.claudeCode?.runtimeBridge?.lastFailure ??
      null,
  };
}

async function prepareRuntime(parsed) {
  const body = await httpJson(
    `/api/agents/${encodeURIComponent(parsed.agentId)}/start`,
    {
      method: "POST",
      body: { workspaceId: parsed.workspaceId },
      timeoutMs: 20_000,
    },
  );

  return {
    readyToConnect: true,
    status: body?.status ?? body?.data?.status ?? null,
    runtimeId: body?.id ?? body?.data?.id ?? null,
    reused: body?.reused ?? body?.data?.reused ?? null,
  };
}

async function sendGatewayMessage(parsed) {
  const ws = await openGatewaySocket(parsed);
  const requestId = `cli-${randomUUID()}`;
  const idempotencyKey = `cli-${randomUUID()}`;
  const observation = {
    status: "dispatching",
    events: [],
    error: null,
  };

  try {
    const responsePromise = waitForResponse(ws, requestId, parsed.timeoutMs);
    const completionPromise = waitForChatCompletion(
      ws,
      observation,
      parsed.timeoutMs,
    );

    ws.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method: "chat.send",
        params: {
          agent_id: parsed.agentId,
          workspace_id: parsed.workspaceId,
          sessionKey: parsed.sessionKey,
          message: parsed.message,
          deliver: false,
          idempotencyKey,
        },
      }),
    );

    const response = await responsePromise;
    const runId = response?.runId ?? idempotencyKey;
    const completion = await completionPromise;

    return {
      requestId,
      runId,
      observation: {
        ...observation,
        status: completion.status,
        error: completion.error,
      },
    };
  } finally {
    ws.close(1000, "agent send-message complete");
  }
}

async function openGatewaySocket(parsed) {
  const url = new URL("/ws", parsed.apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agent_id", parsed.agentId);
  url.searchParams.set("workspace_id", parsed.workspaceId);
  url.searchParams.set("session_key", parsed.sessionKey);

  const ws = new WebSocket(url, ["platform.v1", `bearer.${parsed.token}`]);
  await waitForSocketOpen(ws, { timeoutMs: parsed.timeoutMs });
  await sendGatewayConnect(ws, parsed);
  return ws;
}

async function sendGatewayConnect(ws, parsed) {
  const connectId = `cli-connect-${randomUUID()}`;
  const responsePromise = waitForHelloOrResponse(
    ws,
    connectId,
    parsed.timeoutMs,
  );
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "platform-agent-send-message-cli",
          version: "app-0.1",
          platform: "node",
          mode: "cli",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
        caps: [],
        auth: { token: parsed.token },
        userAgent: `node/${process.version}`,
        locale: "en-US",
      },
    }),
  );
  await responsePromise;
}

function waitForHelloOrResponse(ws, requestId, timeoutMs) {
  return waitForGatewayHello({
    ws,
    requestId,
    timeoutMs,
    parseFrame: parseJson,
  });
}

function waitForResponse(ws, requestId, timeoutMs) {
  return waitForGatewayResponse({
    ws,
    requestId,
    timeoutMs,
    parseFrame: parseJson,
  });
}

function waitForChatCompletion(ws, observation, timeoutMs) {
  return waitForGatewayEvent({
    ws,
    timeoutMs,
    parseFrame: parseJson,
    fallbackResult: () => ({ status: "dispatch_started", error: null }),
    onFrameResult: (frame) => {
      if (frame?.type !== "event") return;
      const payload = frame.payload ?? {};
      observation.events.push({
        event: frame.event ?? null,
        state: payload.state ?? null,
        runId: payload.runId ?? null,
        errorCode: payload.errorCode ?? null,
      });

      if (frame.event !== "chat") return;
      if (payload.state === "final") {
        return { status: "completed", error: null };
      }
      if (payload.state === "error") {
        return {
          status: "error",
          error: {
            code: payload.errorCode ?? null,
            message: payload.errorMessage ?? "runtime reported an error",
          },
        };
      }
      if (payload.state === "aborted") {
        return {
          status: "error",
          error: { code: "aborted", message: "runtime aborted the chat turn" },
        };
      }
      return undefined;
    },
  });
}

async function pollMessages(parsed, startedAt) {
  const deadline = Date.now() + parsed.timeoutMs;
  let lastMessages = [];
  let lastAssistantMessage = null;

  while (Date.now() < deadline) {
    const body = await httpJson(
      `/api/agents/${encodeURIComponent(parsed.agentId)}/messages?limit=50`,
      { timeoutMs: 10_000 },
    );
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    lastMessages = messages;
    const userMessage = messages.find(
      (message) =>
        message?.role === "user" &&
        message?.content === parsed.message &&
        isAtOrAfter(message, startedAt),
    );
    const assistantMessage = messages.find(
      (message) =>
        message?.role === "assistant" && isAtOrAfter(message, startedAt),
    );
    lastAssistantMessage = assistantMessage ?? lastAssistantMessage;

    if (userMessage) {
      return {
        userMessageId: userMessage.id ?? null,
        assistantMessageId:
          assistantMessage?.id ?? lastAssistantMessage?.id ?? null,
        totalMessages: messages.length,
      };
    }

    await delay(parsed.pollIntervalMs);
  }

  return {
    userMessageId: null,
    assistantMessageId: lastAssistantMessage?.id ?? null,
    totalMessages: lastMessages.length,
  };
}

function isAtOrAfter(message, startedAt) {
  const createdAt =
    typeof message?.createdAt === "number"
      ? message.createdAt
      : typeof message?.timestamp === "number"
        ? message.timestamp
        : typeof message?.created_at === "string"
          ? Date.parse(message.created_at)
          : NaN;
  return (
    !Number.isFinite(createdAt) || createdAt >= startedAt.getTime() - 2_000
  );
}

async function attachLogs(result) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "scripts/logs-summary.mjs",
        "--json",
        "--since",
        "10m",
        "--agent-id",
        args.agentId,
        "--workspace-id",
        args.workspaceId,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const parsed = parseJson(stdout);
    result.logSummary = parsed
      ? {
          status: parsed.status ?? null,
          totalRecords: parsed.summary?.totalRecords ?? null,
          warningOrErrorRecords: parsed.summary?.warningOrErrorRecords ?? null,
          highlights: parsed.highlights ?? [],
        }
      : null;
  } catch (error) {
    result.logSummary = {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runtimeFollowUpCommand(parsed) {
  return [
    "pnpm run smoke:gateway --",
    `--agent-id ${shellQuote(parsed.agentId)}`,
    `--workspace-id ${shellQuote(parsed.workspaceId)}`,
    `--message ${shellQuote(parsed.message)}`,
  ].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function finish(result, exitCode) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result);
  }
  process.exitCode = exitCode;
}

function printTextResult(result) {
  console.log(`agent:send-message: ${result.finalStatus}`);
  console.log(`agent: ${result.agentId}`);
  console.log(`workspace: ${result.workspaceId}`);
  if (result.requestId) console.log(`request: ${result.requestId}`);
  if (result.messageId) console.log(`message: ${result.messageId}`);
  if (result.runId) console.log(`run: ${result.runId}`);
  if (result.diagnostic?.blockers?.length) {
    console.log(`blockers: ${result.diagnostic.blockers.join(", ")}`);
  }
  if (result.runtimeObservation?.error) {
    const error = result.runtimeObservation.error;
    console.log(`runtime error: ${error.code ?? "unknown"} ${error.message}`);
  }
  if (result.logSummary) {
    console.log(
      `logs: ${result.logSummary.status} records=${result.logSummary.totalRecords ?? "unknown"} failures=${result.logSummary.warningOrErrorRecords ?? "unknown"}`,
    );
  }
  if (result.followUpCommand) {
    console.log(`runtime follow-up: ${result.followUpCommand}`);
  }
}

function printStep(message) {
  if (!args.json) {
    console.log(`- ${message}`);
  }
}
