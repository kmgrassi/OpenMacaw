import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAgentLiveIoRoutes } from "./agent-live-io.js";

vi.mock("../services/agent-tools/access.js", () => ({
  assertAgentAccess: vi.fn(),
}));

vi.mock("../services/runtime-target.js", () => ({
  RuntimeTargetError: class RuntimeTargetError extends Error {
    statusCode = 503;
    code = "runtime_not_ready";
    retriable = true;
  },
  resolveRuntimeTargetForAgent: vi.fn(),
}));

const { assertAgentAccess } = vi.mocked(await import("../services/agent-tools/access.js"));
const { resolveRuntimeTargetForAgent } = vi.mocked(await import("../services/runtime-target.js"));

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

describe("agent live I/O routes", () => {
  let apiServer: Server | undefined;
  let runtimeServer: Server | undefined;
  let baseUrl = "";
  let runtimeBaseUrl = "";
  let runtimeRequests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let launcherRequest: ReturnType<typeof vi.fn>;
  let previousServiceRoleKey: string | undefined;

  beforeEach(async () => {
    runtimeRequests = [];
    launcherRequest = vi.fn();
    previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    assertAgentAccess.mockResolvedValue({
      agent: {
        id: agentId,
        name: "Coding Agent",
        workspace_id: workspaceId,
        type: "coding",
        context: null,
        model_settings: {},
        tool_policy: {},
        status: "active",
        created_by_user_id: userId,
        updated_at: "2026-06-25T12:00:00.000Z",
      },
      workspaceId,
    });

    runtimeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "POST" && url.pathname === `/api/v1/agents/${agentId}/input`) {
        const body = await readJson(req);
        runtimeRequests.push({ method: req.method, path: url.pathname, body });
        return json(res, 202, {
          accepted: true,
          agentId,
          workspaceId,
          sessionKey: body.session_key,
          turnId: "turn-1",
        });
      }

      if (req.method === "POST" && url.pathname === `/api/v1/agents/${agentId}/interrupt`) {
        const body = await readJson(req);
        runtimeRequests.push({ method: req.method, path: url.pathname, body });
        return json(res, 202, {
          interrupted: true,
          agentId,
          workspaceId,
          sessionKey: body.session_key,
          turnId: "turn-1",
        });
      }

      if (req.method === "GET" && url.pathname === `/api/v1/agents/${agentId}/stream`) {
        runtimeRequests.push({
          method: req.method,
          path: `${url.pathname}?${url.searchParams.toString()}`,
          body: {},
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(`data: ${JSON.stringify({ type: "text_delta", agentId, workspaceId, payload: { text: "hi" } })}\n\n`);
        res.end();
        return;
      }

      return json(res, 404, { error: { code: "not_found", message: "Not found" } });
    });

    const runtimePort = await listen(runtimeServer);
    runtimeBaseUrl = `http://127.0.0.1:${runtimePort}`;
    resolveRuntimeTargetForAgent.mockResolvedValue({
      agentId,
      workspaceId,
      host: "127.0.0.1",
      port: runtimePort,
      instanceId: "runtime-1",
      startedAt: "2026-06-25T12:00:00.000Z",
      baseUrl: runtimeBaseUrl,
      wsUrl: runtimeBaseUrl.replace(/^http/i, "ws"),
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
    registerAgentLiveIoRoutes(app, launcherRequest, 500);

    apiServer = createServer(app);
    const apiPort = await listen(apiServer);
    baseUrl = `http://127.0.0.1:${apiPort}`;
  });

  afterEach(async () => {
    await closeServer(apiServer);
    await closeServer(runtimeServer);
    if (previousServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey;
    }
    vi.clearAllMocks();
  });

  it("proxies live input with authenticated runtime context", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/input`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        message: "continue with the next step",
        sessionKey: `agent:${agentId}:main`,
        metadata: { source: "test" },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      agentId,
      workspaceId,
      sessionKey: `agent:${agentId}:main`,
    });
    expect(assertAgentAccess).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      workspaceId,
    });
    expect(runtimeRequests).toEqual([
      {
        method: "POST",
        path: `/api/v1/agents/${agentId}/input`,
        body: {
          agent_id: agentId,
          workspace_id: workspaceId,
          user_id: userId,
          message: "continue with the next step",
          session_key: `agent:${agentId}:main`,
          metadata: { source: "test" },
        },
      },
    ]);
  });

  it("proxies live interrupt requests", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/interrupt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        sessionKey: `agent:${agentId}:main`,
        reason: "user stopped the turn",
      }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      interrupted: true,
      agentId,
      workspaceId,
    });
    expect(runtimeRequests[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/agents/${agentId}/interrupt`,
      body: {
        agent_id: agentId,
        workspace_id: workspaceId,
        user_id: userId,
        session_key: `agent:${agentId}:main`,
        reason: "user stopped the turn",
      },
    });
  });

  it("proxies the live event stream as SSE", async () => {
    const response = await fetch(
      `${baseUrl}/api/agents/${agentId}/stream?workspaceId=${workspaceId}&sessionKey=${encodeURIComponent(
        `agent:${agentId}:main`,
      )}`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain('"type":"text_delta"');
    expect(runtimeRequests).toEqual([
      {
        method: "GET",
        path: `/api/v1/agents/${agentId}/stream?workspace_id=${workspaceId}&user_id=${userId}&session_key=agent%3A${agentId}%3Amain`,
        body: {},
      },
    ]);
  });

  it("rejects invalid live input before resolving runtime target", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/input`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, message: "" }),
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(resolveRuntimeTargetForAgent).not.toHaveBeenCalled();
    expect(runtimeRequests).toEqual([]);
  });
});
