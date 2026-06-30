#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_USER_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_MESSAGE = "Reply with a short live I/O smoke acknowledgement.";
const DEFAULT_INTERRUPT_MESSAGE = "Start a long response for the live I/O interrupt smoke and keep going until interrupted.";

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const results = [];

  for (const runner of opts.runners) {
    results.push(await runScenario(runner, opts));
  }

  const summary = {
    ok: results.every((result) => result.ok),
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    base_url: opts.baseUrl,
    workspace_id: opts.workspaceId,
    user_id: opts.userId,
    results,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  process.exit(summary.ok ? 0 : 1);
}

async function runScenario(runner, opts) {
  const agentId = opts.agentIds[runner];
  const sessionKey = `${opts.sessionPrefix}:${runner}:${randomUUID()}`;
  const stream = new EventStreamClient(streamUrl(opts, agentId, sessionKey), authHeaders(opts));
  const checks = [];

  try {
    await stream.connect(opts.timeoutMs);
    checks.push(pass("create_stream", { session_key: sessionKey }));

    const input = await postJson(inputUrl(opts, agentId), authHeaders(opts), {
      workspace_id: opts.workspaceId,
      user_id: opts.userId,
      session_key: sessionKey,
      message: opts.message,
      metadata: { smoke: "agent-live-io", runner },
    });

    checks.push(pass("input", { turn_id: input.turnId }));

    const firstTurnEvents = await stream.waitForTurn(input.turnId, opts.timeoutMs);
    checks.push(pass("stream", summarizeEvents(firstTurnEvents)));

    const interrupt = await postJson(inputUrl(opts, agentId), authHeaders(opts), {
      workspace_id: opts.workspaceId,
      user_id: opts.userId,
      session_key: sessionKey,
      message: opts.interruptMessage,
      metadata: { smoke: "agent-live-io-interrupt", runner },
    });

    checks.push(pass("interrupt_input", { turn_id: interrupt.turnId }));
    await stream.waitForEvent((event) => event.type === "turn_started" && event.turnId === interrupt.turnId, opts.timeoutMs);

    const interruptResponse = await postJson(interruptUrl(opts, agentId), authHeaders(opts), {
      workspace_id: opts.workspaceId,
      user_id: opts.userId,
      session_key: sessionKey,
      turn_id: interrupt.turnId,
    });

    checks.push(pass("interrupt", { turn_id: interruptResponse.turnId ?? interrupt.turnId }));

    const interrupted = await stream.waitForEvent(
      (event) => event.type === "turn_interrupted" && event.turnId === interrupt.turnId,
      opts.timeoutMs,
    );

    checks.push(pass("stream_interrupt", { type: interrupted.type, turn_id: interrupted.turnId }));

    return { runner, agent_id: agentId, session_key: sessionKey, ok: true, checks };
  } catch (error) {
    checks.push(fail("scenario", error.message));
    return { runner, agent_id: agentId, session_key: sessionKey, ok: false, checks };
  } finally {
    stream.close();
  }
}

class EventStreamClient {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers;
    this.controller = new AbortController();
    this.events = [];
    this.waiters = [];
    this.connected = false;
    this.buffer = "";
  }

  async connect(timeoutMs) {
    const response = await fetch(this.url, {
      headers: { accept: "text/event-stream", ...this.headers },
      signal: this.controller.signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`stream connect failed with ${response.status}: ${text}`);
    }

    this.connected = true;
    this.readLoop(response.body.getReader());
    await this.waitForConnectedComment(timeoutMs);
  }

  waitForTurn(turnId, timeoutMs) {
    const seen = [];
    return this.waitForEvent((event) => {
      if (event.turnId !== turnId) return false;
      seen.push(event);
      return event.type === "turn_completed" || event.type === "error" || event.type === "turn_interrupted";
    }, timeoutMs).then(() => seen);
  }

  waitForEvent(predicate, timeoutMs) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== waiterRecord);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for stream event`));
      }, timeoutMs);

      const waiterRecord = {
        predicate,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      };

      this.waiters.push(waiterRecord);
    });
  }

  waitForConnectedComment(timeoutMs) {
    if (this.connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for stream connect`)), timeoutMs);
      const interval = setInterval(() => {
        if (this.connected) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 25);
    });
  }

  async readLoop(reader) {
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        this.consume(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.rejectWaiters(error);
      }
    }
  }

  consume(chunk) {
    this.buffer += chunk;

    while (this.buffer.includes("\n\n")) {
      const index = this.buffer.indexOf("\n\n");
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.consumeFrame(frame);
    }
  }

  consumeFrame(frame) {
    if (frame.startsWith(":")) return;

    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5).trim());
      this.events.push(event);

      const waiter = this.waiters.find((candidate) => candidate.predicate(event));
      if (waiter) {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(event);
      }
    }
  }

  rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(Promise.reject(error));
  }

  close() {
    this.controller.abort();
  }
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
  }

  return payload;
}

function authHeaders(opts) {
  return opts.serviceRoleKey ? { authorization: `Bearer ${opts.serviceRoleKey}` } : {};
}

function inputUrl(opts, agentId) {
  return `${opts.baseUrl}/api/v1/agents/${agentId}/input`;
}

function interruptUrl(opts, agentId) {
  return `${opts.baseUrl}/api/v1/agents/${agentId}/interrupt`;
}

function streamUrl(opts, agentId, sessionKey) {
  const url = new URL(`${opts.baseUrl}/api/v1/agents/${agentId}/stream`);
  url.searchParams.set("workspace_id", opts.workspaceId);
  url.searchParams.set("user_id", opts.userId);
  url.searchParams.set("session_key", sessionKey);
  return url.toString();
}

function summarizeEvents(events) {
  return {
    event_types: events.map((event) => event.type),
    text_delta_count: events.filter((event) => event.type === "text_delta").length,
    tool_activity_count: events.filter((event) => event.type === "tool_activity").length,
  };
}

function pass(name, proof = {}) {
  return { name, status: "passed", proof };
}

function fail(name, error) {
  return { name, status: "failed", error };
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.RUNTIME_BASE_URL || process.env.ORCHESTRATOR_URL || DEFAULT_BASE_URL,
    workspaceId: process.env.RUNTIME_WORKSPACE_ID || "",
    userId: process.env.RUNTIME_USER_ID || DEFAULT_USER_ID,
    agentIds: {
      codex: process.env.RUNTIME_CODEX_AGENT_ID || process.env.RUNTIME_AGENT_ID || "",
      claude_code: process.env.RUNTIME_CLAUDE_AGENT_ID || "",
    },
    runners: ["codex", "claude_code"],
    serviceRoleKey: (process.env.LAUNCHER_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    sessionPrefix: process.env.RUNTIME_SESSION_PREFIX || "agent-live-io-smoke",
    message: process.env.RUNTIME_AGENT_LIVE_IO_MESSAGE || DEFAULT_MESSAGE,
    interruptMessage: process.env.RUNTIME_AGENT_LIVE_IO_INTERRUPT_MESSAGE || DEFAULT_INTERRUPT_MESSAGE,
    timeoutMs: numberFromEnv("RUNTIME_AGENT_LIVE_IO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--base-url" && next) {
      opts.baseUrl = next;
      index += 1;
    } else if (arg === "--workspace-id" && next) {
      opts.workspaceId = next;
      index += 1;
    } else if (arg === "--user-id" && next) {
      opts.userId = next;
      index += 1;
    } else if (arg === "--codex-agent-id" && next) {
      opts.agentIds.codex = next;
      index += 1;
    } else if (arg === "--claude-agent-id" && next) {
      opts.agentIds.claude_code = next;
      index += 1;
    } else if (arg === "--agent-id" && next) {
      opts.agentIds.codex = next;
      index += 1;
    } else if (arg === "--runner" && next) {
      opts.runners = parseRunners(next);
      index += 1;
    } else if (arg === "--session-prefix" && next) {
      opts.sessionPrefix = next;
      index += 1;
    } else if (arg === "--message" && next) {
      opts.message = next;
      index += 1;
    } else if (arg === "--interrupt-message" && next) {
      opts.interruptMessage = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      opts.timeoutMs = parsePositiveInt(next, "--timeout-ms");
      index += 1;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  validateOpts(opts);
  return opts;
}

function parseRunners(value) {
  if (value === "both") return ["codex", "claude_code"];
  return value.split(",").map((runner) => {
    if (runner === "claude") return "claude_code";
    if (runner === "codex" || runner === "claude_code") return runner;
    throw new Error(`unsupported runner: ${runner}`);
  });
}

function validateOpts(opts) {
  if (!opts.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY or LAUNCHER_SUPABASE_SERVICE_KEY is required");
  if (!opts.workspaceId) throw new Error("--workspace-id or RUNTIME_WORKSPACE_ID is required");

  for (const runner of opts.runners) {
    if (!opts.agentIds[runner]) {
      const flag = runner === "codex" ? "--codex-agent-id" : "--claude-agent-id";
      throw new Error(`${flag} is required when runner=${runner}`);
    }
  }
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return parsePositiveInt(value, name);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm run smoke:agent-live-io -- [options]

Options:
  --base-url <url>             Orchestrator URL. Default: ${DEFAULT_BASE_URL}
  --workspace-id <uuid>        Workspace id.
  --user-id <uuid>             User id. Default: ${DEFAULT_USER_ID}
  --codex-agent-id <uuid>      Codex-backed coding agent id.
  --claude-agent-id <uuid>     Claude Code-backed coding agent id.
  --runner <name>              codex, claude, claude_code, or both. Default: both
  --session-prefix <prefix>    Session key prefix.
  --message <text>             Message for the stream completion check.
  --interrupt-message <text>   Message for the interrupt check.
  --timeout-ms <ms>            Per-step timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --json                       Print machine-readable JSON.

Environment:
  SUPABASE_SERVICE_ROLE_KEY or LAUNCHER_SUPABASE_SERVICE_KEY, RUNTIME_BASE_URL,
  ORCHESTRATOR_URL, RUNTIME_WORKSPACE_ID, RUNTIME_USER_ID, RUNTIME_CODEX_AGENT_ID,
  RUNTIME_CLAUDE_AGENT_ID, RUNTIME_AGENT_LIVE_IO_TIMEOUT_MS`);
}

function printSummary(summary) {
  console.log(`[agent-live-io-smoke] ${summary.ok ? "passed" : "failed"}`);
  console.log(`[agent-live-io-smoke] base_url=${summary.base_url}`);

  for (const result of summary.results) {
    console.log(`[agent-live-io-smoke] ${result.ok ? "passed" : "failed"} ${result.runner} agent=${result.agent_id}`);

    for (const check of result.checks) {
      const proof = check.proof ? ` ${JSON.stringify(check.proof)}` : "";
      const error = check.error ? ` error=${check.error}` : "";
      console.log(`[agent-live-io-smoke]   ${check.status} ${check.name}${proof}${error}`);
    }
  }
}

main().catch((error) => {
  console.error(`[agent-live-io-smoke] failed: ${error.message}`);
  process.exit(1);
});
