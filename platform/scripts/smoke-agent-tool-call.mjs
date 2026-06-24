#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const requireFromApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const execFileAsync = promisify(execFile);

const DEFAULT_API_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_TOOL = "shell.exec";
const DEFAULT_PATH = "package.json";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 2_000;

const args = parseArgs(process.argv.slice(2));

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status: "failed",
          error: message,
          artifactDir: args.artifactDir ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`smoke:agent-tool-call failed: ${message}`);
    if (args.artifactDir) {
      console.error(`artifacts: ${relative(args.artifactDir)}`);
    }
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  requireArg(args.agentId, "--agent-id");
  requireArg(args.workspaceId, "--workspace-id");
  requireArg(args.token, "--api-token or PLATFORM_API_TOKEN");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = path.join(
    rootDir,
    ".run-artifacts",
    "agent-tool-call",
    timestamp,
  );
  args.artifactDir = artifactDir;
  await mkdir(artifactDir, { recursive: true });

  const requestId = `req-agent-tool-call-${randomUUID()}`;
  const traceId = `trc-agent-tool-call-${randomUUID()}`;
  const sessionKey = args.sessionKey ?? `agent:${args.agentId}:tool-call-smoke`;
  const message = buildPrompt(args);
  const startedAt = new Date();

  const result = {
    status: "running",
    agentId: args.agentId,
    workspaceId: args.workspaceId,
    tool: args.tool,
    path: args.path,
    requestId,
    traceId,
    sessionKey,
    artifactDir,
    startedAt: startedAt.toISOString(),
    runId: null,
    toolCallId: null,
    checks: [],
  };

  await writeJson(path.join(artifactDir, "input.json"), {
    ...result,
    apiBaseUrl: args.apiBaseUrl,
    message,
    token: "[redacted]",
  });

  const toolSettings = await getJson(
    `/api/agents/${encodeURIComponent(args.agentId)}/tools?workspaceId=${encodeURIComponent(args.workspaceId)}`,
    { requestId, traceId },
  );
  await writeJson(path.join(artifactDir, "tool-settings.json"), toolSettings);

  const resolvedTool = findGrantedTool(toolSettings, args.tool);
  result.checks.push({
    name: "tool granted",
    status: "passed",
    summary: `${args.tool} is enabled for the agent`,
    toolId: resolvedTool.id,
  });

  await startAgent({ requestId, traceId });
  result.checks.push({
    name: "runtime start",
    status: "passed",
    summary: "agent runtime start request accepted",
  });

  const framesPath = path.join(artifactDir, "ws-frames.ndjson");
  const framesStream = createWriteStream(framesPath, { flags: "a" });
  let wsResult;
  try {
    wsResult = await runChatOverWebSocket({
      message,
      requestId,
      traceId,
      sessionKey,
      framesStream,
    });
  } finally {
    framesStream.end();
  }

  result.runId = wsResult.runId;
  result.checks.push({
    name: "chat final",
    status: "passed",
    summary: "gateway observed a final assistant message",
    runId: wsResult.runId,
  });

  const dashboardResult = await waitForDashboardToolEvidence({
    requestId,
    traceId,
    startedAt,
    artifactDir,
  });
  result.runId = dashboardResult.runId ?? result.runId;
  result.toolCallId = dashboardResult.toolCallId;
  result.checks.push(...dashboardResult.checks);

  const logResult = await collectAndVerifyLogs({
    artifactDir,
    requestId,
    toolCallId: dashboardResult.toolCallId,
  });
  result.checks.push(logResult.check);

  result.status = "passed";
  result.completedAt = new Date().toISOString();
  await writeJson(path.join(artifactDir, "result.json"), result);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("smoke:agent-tool-call passed");
  console.log(`agent: ${args.agentId}`);
  console.log(`workspace: ${args.workspaceId}`);
  console.log(`tool: ${args.tool}`);
  console.log(`run id: ${result.runId ?? "unknown"}`);
  console.log(`tool call id: ${result.toolCallId ?? "unknown"}`);
  console.log(`request id: ${requestId}`);
  console.log(`artifacts: ${relative(artifactDir)}`);
}

function parseArgs(argv) {
  const parsed = {
    agentId: null,
    workspaceId: null,
    tool: DEFAULT_TOOL,
    path: DEFAULT_PATH,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    token: process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    sessionKey: null,
    json: false,
    help: false,
    artifactDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--agent-id") {
      parsed.agentId = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--tool") {
      parsed.tool = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--tool=")) {
      parsed.tool = arg.slice("--tool=".length);
    } else if (arg === "--path") {
      parsed.path = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--path=")) {
      parsed.path = arg.slice("--path=".length);
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.token = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--api-token=")) {
      parsed.token = arg.slice("--api-token=".length);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requireValue(arg, argv[++index]));
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--poll-ms") {
      parsed.pollMs = Number(requireValue(arg, argv[++index]));
    } else if (arg.startsWith("--poll-ms=")) {
      parsed.pollMs = Number(arg.slice("--poll-ms=".length));
    } else if (arg === "--session-key") {
      parsed.sessionKey = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--session-key=")) {
      parsed.sessionKey = arg.slice("--session-key=".length);
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
  parsed.tool = parsed.tool.trim() || DEFAULT_TOOL;
  parsed.path = parsed.path.trim() || DEFAULT_PATH;
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (!Number.isFinite(parsed.pollMs) || parsed.pollMs <= 0) {
    throw new Error("--poll-ms must be a positive number");
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm run smoke:agent-tool-call -- [options]

Options:
  --agent-id <id>       Agent to exercise
  --workspace-id <id>   Workspace context
  --tool <slug>         Expected tool slug (default: shell.exec)
  --path <path>         Harmless file path to ask shell.exec to read (default: package.json)
  --api-base-url <url>  Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>   Supabase bearer token (or PLATFORM_API_TOKEN/API_AUTH_TOKEN)
  --timeout-ms <ms>     Overall wait timeout (default: 90000)
  --poll-ms <ms>        Dashboard polling interval (default: 2000)
  --session-key <key>   Override gateway session key
  --json                Print machine-readable output
`);
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireArg(value, flag) {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
}

function buildPrompt(input) {
  if (input.tool === "shell.exec") {
    return [
      `Use shell.exec to run this exact command from /workspace: sed -n 1,20p ${input.path}.`,
      "Do not answer from memory.",
      "After the tool result is available, respond with a short confirmation that the file was read.",
    ].join(" ");
  }

  return [
    `Use the ${input.tool} tool to read ${input.path}.`,
    "Do not answer from memory.",
    "After the tool result is available, respond with a short confirmation that the file was read.",
  ].join(" ");
}

function authHeaders({ requestId, traceId } = {}) {
  return {
    authorization: `Bearer ${args.token}`,
    accept: "application/json",
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...(traceId ? { "x-trace-id": traceId } : {}),
  };
}

async function getJson(pathname, context = {}) {
  return requestJson(pathname, { method: "GET", ...context });
}

async function requestJson(pathname, options) {
  const response = await fetch(`${args.apiBaseUrl}${pathname}`, {
    method: options.method,
    headers: {
      ...authHeaders(options),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = text ? parseJson(text) : null;

  if (!response.ok) {
    throw new Error(
      `${options.method} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  return body;
}

async function startAgent(context) {
  await requestJson(`/api/agents/${encodeURIComponent(args.agentId)}/start`, {
    method: "POST",
    ...context,
  });
}

function findGrantedTool(settings, toolSlug) {
  const resolvedTools = Array.isArray(settings?.resolvedTools)
    ? settings.resolvedTools
    : [];
  const match = resolvedTools.find(
    (tool) => tool?.slug === toolSlug && tool.enabled && tool.enabledForAgent,
  );

  if (!match) {
    const available = resolvedTools
      .filter((tool) => tool?.enabledForAgent)
      .map((tool) => tool.slug)
      .filter(Boolean)
      .sort();
    throw new Error(
      `${toolSlug} is not granted/enabled for agent ${args.agentId}. Granted tools: ${available.join(", ") || "none"}`,
    );
  }

  return match;
}

async function runChatOverWebSocket(input) {
  const WebSocket = loadWebSocket();
  const wsUrl = new URL(args.apiBaseUrl.replace(/^http/i, "ws"));
  wsUrl.pathname = "/ws";
  wsUrl.searchParams.set("agent_id", args.agentId);
  wsUrl.searchParams.set("workspace_id", args.workspaceId);
  wsUrl.searchParams.set("session_key", input.sessionKey);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      String(wsUrl),
      ["platform.v1", `bearer.${args.token}`],
      {
        headers: {
          "x-request-id": input.requestId,
          "x-trace-id": input.traceId,
        },
      },
    );

    let settled = false;
    let runId = null;
    let chatSent = false;

    const timer = setTimeout(() => {
      fail(
        new Error(
          `timed out waiting for final assistant message after ${args.timeoutMs}ms`,
        ),
      );
    }, args.timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close(1000, "smoke complete");
      resolve(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(error);
    }

    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "agent-tool-call-smoke",
              version: "0.1",
              platform: "node",
              mode: "debug",
            },
            role: "operator",
            scopes: ["operator.admin"],
            caps: [],
            userAgent: "agent-tool-call-smoke",
            locale: "en-US",
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      const receivedAt = new Date().toISOString();
      const text = raw.toString();
      input.framesStream.write(
        `${JSON.stringify({ receivedAt, frame: parseJson(text) ?? text })}\n`,
      );

      const frame = parseJson(text);
      if (!frame || typeof frame !== "object") return;

      if (frame.type === "hello-ok" || frame.type === "res") {
        if (frame.type === "res" && frame.id === "chat-1" && frame.result) {
          runId = stringValue(frame.result.runId) ?? runId;
        }
        if (
          !chatSent &&
          (frame.type === "hello-ok" || frame.id === "connect-1")
        ) {
          chatSent = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: "chat-1",
              method: "chat.send",
              params: {
                agent_id: args.agentId,
                workspace_id: args.workspaceId,
                sessionKey: input.sessionKey,
                message: input.message,
                deliver: false,
                idempotencyKey: input.requestId,
              },
            }),
          );
        }
        return;
      }

      if (frame.type === "err") {
        fail(
          new Error(`gateway error: ${JSON.stringify(frame.error ?? frame)}`),
        );
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        const payload = asRecord(frame.payload);
        runId =
          stringValue(payload?.runId) ?? stringValue(payload?.run_id) ?? runId;

        if (payload?.state === "error") {
          fail(
            new Error(
              `chat error: ${stringValue(payload.errorMessage) ?? stringValue(payload.error) ?? "unknown"}`,
            ),
          );
          return;
        }

        if (payload?.state === "final") {
          const finalText = extractText(payload.message);
          if (!finalText.trim()) {
            fail(new Error("final assistant message was empty"));
            return;
          }
          finish({ runId, finalText });
        }
      }
    });

    ws.once("unexpected-response", (_request, response) => {
      fail(new Error(`websocket upgrade failed (${response.statusCode})`));
    });
    ws.once("error", (error) => fail(error));
  });
}

function loadWebSocket() {
  try {
    return requireFromApi("ws").WebSocket;
  } catch (error) {
    throw new Error(
      `Could not load the ws package from apps/api. Run pnpm install from the repo root before running this smoke. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function waitForDashboardToolEvidence(input) {
  const snapshotsPath = path.join(
    input.artifactDir,
    "dashboard-snapshots.ndjson",
  );
  const snapshots = createWriteStream(snapshotsPath, { flags: "a" });
  const deadline = Date.now() + args.timeoutMs;
  let lastSnapshot = null;

  try {
    while (Date.now() < deadline) {
      const dashboard = await getJson(
        `/api/agent-dashboard/${encodeURIComponent(args.agentId)}?workspaceId=${encodeURIComponent(args.workspaceId)}`,
        { requestId: input.requestId, traceId: input.traceId },
      );
      lastSnapshot = dashboard;
      snapshots.write(
        `${JSON.stringify({ observedAt: new Date().toISOString(), dashboard })}\n`,
      );

      const evidence = findToolEvidence(dashboard, args.tool, input.startedAt);
      if (
        evidence.assistantToolCall &&
        evidence.toolResult &&
        evidence.finalAssistant
      ) {
        return {
          runId: evidence.runId,
          toolCallId: evidence.toolCallId,
          checks: [
            {
              name: "assistant tool call",
              status: "passed",
              summary: `${args.tool} assistant tool-call event is visible on the platform dashboard`,
              toolCallId: evidence.toolCallId,
            },
            {
              name: "tool result",
              status: "passed",
              summary: `${args.tool} tool-result event is visible on the platform dashboard`,
              toolCallId: evidence.toolCallId,
            },
            {
              name: "final assistant",
              status: "passed",
              summary:
                "final assistant response event is visible on the platform dashboard",
              runId: evidence.runId,
            },
          ],
        };
      }

      await delay(args.pollMs);
    }
  } finally {
    snapshots.end();
  }

  await writeJson(
    path.join(input.artifactDir, "last-dashboard.json"),
    lastSnapshot,
  );
  const evidence = findToolEvidence(lastSnapshot, args.tool, input.startedAt);
  throw new Error(
    [
      `did not observe complete ${args.tool} tool-call loop on the platform dashboard`,
      `assistantToolCall=${Boolean(evidence.assistantToolCall)}`,
      `toolResult=${Boolean(evidence.toolResult)}`,
      `finalAssistant=${Boolean(evidence.finalAssistant)}`,
    ].join(" "),
  );
}

function findToolEvidence(dashboard, toolSlug, startedAt) {
  const tasks = Array.isArray(dashboard?.tasks) ? dashboard.tasks : [];
  const allEvents = tasks.flatMap((task) =>
    Array.isArray(task?.toolEvents) ? task.toolEvents : [],
  );
  const recentEvents = allEvents.filter((event) => {
    const createdAt = Date.parse(event?.createdAt ?? "");
    return (
      !Number.isFinite(createdAt) || createdAt >= startedAt.getTime() - 5_000
    );
  });
  const toolEvents = recentEvents.filter(
    (event) => event?.toolSlug === toolSlug,
  );
  const assistantToolCall = toolEvents.find(
    (event) => event.messageKind === "assistant_tool_call",
  );
  const toolResult = toolEvents.find(
    (event) =>
      event.messageKind === "tool_result" || event.eventType === "tool_result",
  );
  const finalAssistant =
    recentEvents.find(
      (event) => event.messageKind === "final_assistant_response",
    ) ??
    recentEvents.find(
      (event) => event.eventType === "final_assistant_response",
    );
  const runId =
    stringValue(finalAssistant?.runId) ??
    stringValue(toolResult?.runId) ??
    stringValue(assistantToolCall?.runId) ??
    stringValue(dashboard?.latestRun?.runId);
  const toolCallId =
    stringValue(toolResult?.toolCallId) ??
    stringValue(assistantToolCall?.toolCallId) ??
    null;

  return {
    assistantToolCall,
    toolResult,
    finalAssistant,
    runId,
    toolCallId,
  };
}

async function collectAndVerifyLogs(input) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(rootDir, "scripts", "logs-summary.mjs"),
      "--since",
      "10m",
      "--agent-id",
      args.agentId,
      "--workspace-id",
      args.workspaceId,
      "--json",
      "--verbose",
    ],
    {
      cwd: rootDir,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const logs = parseJson(stdout);
  await writeFile(path.join(input.artifactDir, "logs-summary.json"), stdout);

  const serialized = JSON.stringify(logs);
  const hasRequestId = serialized.includes(input.requestId);
  const hasToolCallId = input.toolCallId
    ? serialized.includes(input.toolCallId)
    : false;

  if (!hasRequestId && !hasToolCallId) {
    throw new Error(
      `logs:summary did not include request id ${input.requestId}${
        input.toolCallId ? ` or tool call id ${input.toolCallId}` : ""
      }`,
    );
  }

  return {
    check: {
      name: "log correlation",
      status: "passed",
      summary: hasToolCallId
        ? "logs:summary includes the observed tool call id"
        : "logs:summary includes the smoke request id",
      requestId: input.requestId,
      toolCallId: input.toolCallId,
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractText(message) {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(extractText).join("\n");
  if (message && typeof message === "object") {
    if ("content" in message) return extractText(message.content);
    if ("text" in message) return extractText(message.text);
  }
  return "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(filePath, value) {
  await writeFile(`${filePath}`, `${JSON.stringify(value, null, 2)}\n`);
}

function relative(filePath) {
  return path.relative(rootDir, filePath) || ".";
}
