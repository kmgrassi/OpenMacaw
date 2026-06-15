import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";

type EngineRow = {
  agent_id: string;
  host: string;
  instance_id: string;
  port: number;
  started_at: string;
  status: string;
  workspace_id: string;
};

const defaultAgentId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";
const unauthorizedAgentId = "66666666-6666-4666-8666-666666666666";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const unauthorizedWorkspaceId = "77777777-7777-4777-8777-777777777777";
const sessionKey = `agent:${agentId}:main`;
const userId = "44444444-4444-4444-8444-444444444444";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "integration-kid",
  alg: "RS256",
  use: "sig",
};

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

async function waitForLog(
  logs: Array<Record<string, unknown>>,
  predicate: (entry: Record<string, unknown>) => boolean,
) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const match = logs.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return logs.find(predicate) ?? null;
}

function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("launcher runtime proxy integration", () => {
  let runtimeServer: ReturnType<typeof createServer>;
  let runtimeWss: WebSocketServer;
  let launcherServer: ReturnType<typeof createServer>;
  let launcherRuntimeWss: WebSocketServer;
  let supabaseServer: ReturnType<typeof createServer>;
  let apiServer: ReturnType<typeof createServer>;
  let runtimePort = 0;
  let apiPort = 0;
  let launcherHits = 0;
  let engineRows: EngineRow[] = [];
  let accessToken = "";
  let launcherWsHeaders: IncomingMessage["headers"] | null = null;
  let failAgentLookup = false;

  beforeAll(async () => {
    runtimeServer = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/api/v1/${agentId}`) {
        return json(res, 200, { agentId, proxied: true, source: "runtime" });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/refresh") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
        }
        return json(res, 200, {
          ok: true,
          echoed: raw ? JSON.parse(raw) : {},
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/health") {
        return json(res, 200, { ok: true, runtime: "healthy" });
      }

      return json(res, 404, { error: "not_found" });
    });
    runtimeWss = new WebSocketServer({ server: runtimeServer, path: "/ws" });
    runtimeWss.on("connection", (socket, request) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      socket.send(
        JSON.stringify({
          type: "hello-ok",
          protocol: 3,
          server: {
            version: "stub-runtime",
            connId: "conn-1",
          },
          scope: {
            agent_id: url.searchParams.get("agent_id"),
            workspace_id: url.searchParams.get("workspace_id"),
            session_key: url.searchParams.get("session_key"),
            user_id: url.searchParams.get("user_id"),
          },
        }),
      );
    });
    runtimePort = await listen(runtimeServer);

    launcherServer = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "launcher" });
      }
      if (req.method === "GET" && url.pathname === `/agents/${agentId}`) {
        launcherHits += 1;
        engineRows = [
          {
            agent_id: agentId,
            host: "127.0.0.1",
            instance_id: "instance-fresh",
            port: runtimePort,
            started_at: "2026-04-22T12:00:01.000Z",
            status: "running",
            workspace_id: workspaceId,
          },
        ];
        return json(res, 200, {
          data: {
            id: agentId,
            name: "Proxy Agent",
            workspace_id: workspaceId,
            project_id: null,
            description: null,
            slug: null,
            status: "active",
            type: "coding",
            session_id: null,
            context: null,
            is_active: true,
            model_settings: { primary: "openai/gpt-5.2" },
            tool_policy: {},
            has_credentials: true,
            created_at: "2026-04-22T12:00:00.000Z",
            updated_at: "2026-04-22T12:00:00.000Z",
          },
        });
      }
      if (req.method === "GET" && url.pathname === `/agents/${agentId}/runtime/api/v1/health`) {
        const response = await fetch(`http://127.0.0.1:${runtimePort}/api/v1/health`);
        const body = await response.json();
        return json(res, response.status, body);
      }
      if (req.method === "POST" && url.pathname === `/agents/${agentId}/start`) {
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not_found" });
    });
    launcherRuntimeWss = new WebSocketServer({ server: launcherServer, path: `/agents/${agentId}/runtime/ws` });
    launcherRuntimeWss.on("connection", (socket, request) => {
      launcherWsHeaders = request.headers;
      const url = new URL(request.url || "/", "http://127.0.0.1");
      socket.send(
        JSON.stringify({
          type: "hello-ok",
          protocol: 3,
          server: {
            version: "stub-launcher-runtime",
            connId: "conn-1",
          },
          scope: {
            agent_id: url.searchParams.get("agent_id"),
            workspace_id: url.searchParams.get("workspace_id"),
            session_key: url.searchParams.get("session_key"),
            user_id: url.searchParams.get("user_id"),
          },
        }),
      );
      socket.on("message", (message, isBinary) => {
        socket.send(message, { binary: isBinary });
      });
    });
    const launcherPort = await listen(launcherServer);
    process.env.LAUNCHER_BASE_URL = `http://127.0.0.1:${launcherPort}`;

    supabaseServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") {
        return json(res, 200, { keys: [publicJwk] });
      }

      const authHeader = req.headers.authorization || "";
      if (!authHeader) {
        return json(res, 401, { error: "missing_auth" });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/engine_instance") {
        const agentFilter = url.searchParams.get("agent_id")?.replace(/^eq\./, "") || "";
        const filtered = agentFilter ? engineRows.filter((row) => agentFilter === row.agent_id) : engineRows;
        const ordered = [...filtered].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
        const limit = Number(url.searchParams.get("limit") || "0");
        if (String(req.headers.accept).includes("application/vnd.pgrst.object+json")) {
          return json(res, 200, ordered[0] ?? null);
        }
        return json(res, 200, limit > 0 ? ordered.slice(0, limit) : ordered);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        if (failAgentLookup) {
          return json(res, 400, {
            code: "PGRST000",
            message: "agent table unavailable",
            details: null,
            hint: null,
          });
        }
        const rows = [
          {
            id: defaultAgentId,
            name: "Default Agent",
            status: "active",
            type: "coding",
            workspace_id: workspaceId,
            model_settings: { primary: "openai/gpt-5.2" },
            tool_policy: {},
            created_by_user_id: userId,
            updated_at: "2026-04-22T12:00:00.000Z",
          },
          {
            id: agentId,
            name: "Proxy Agent",
            status: "active",
            type: "coding",
            workspace_id: workspaceId,
            model_settings: { primary: "openai/gpt-5.2" },
            tool_policy: {},
            created_by_user_id: userId,
            updated_at: "2026-04-22T12:00:00.000Z",
          },
          {
            id: unauthorizedAgentId,
            name: "Other Workspace Agent",
            status: "active",
            type: "coding",
            workspace_id: unauthorizedWorkspaceId,
            model_settings: { primary: "openai/gpt-5.2" },
            tool_policy: {},
            created_by_user_id: userId,
            updated_at: "2026-04-22T12:00:00.000Z",
          },
        ];
        const idFilter = url.searchParams.get("id")?.replace(/^eq\./, "") || "";
        const filtered = idFilter ? rows.filter((row) => row.id === idFilter) : rows;
        return json(res, 200, filtered);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/user") {
        return json(res, 200, {
          id: userId,
          auth_id: userId,
          email: "user@example.com",
          full_name: null,
          first_name: null,
          last_name: null,
          avatar_url: null,
          type: "member",
        });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/credential") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule_match") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/session_thread") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        const requestedWorkspaceId = url.searchParams.get("workspace_id")?.replace(/^eq\./, "") || "";
        const requestedUserId = url.searchParams.get("user_id")?.replace(/^eq\./, "") || "";
        if (requestedWorkspaceId === workspaceId && requestedUserId === userId) {
          return json(res, 200, [{ workspace_id: workspaceId }]);
        }
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/workspaces") {
        return json(res, 200, []);
      }

      return json(res, 404, { error: "not_found" });
    });
    const supabasePort = await listen(supabaseServer);

    process.env.SUPABASE_URL = `http://127.0.0.1:${supabasePort}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    accessToken = jwt.sign(
      {
        email: "user@example.com",
        role: "authenticated",
      },
      privateKey,
      {
        algorithm: "RS256",
        keyid: "integration-kid",
        issuer: `${process.env.SUPABASE_URL}/auth/v1`,
        audience: "authenticated",
        subject: userId,
        expiresIn: "5m",
      },
    );
    vi.resetModules();

    const { createApp } = await import("./app.js");
    const { attachOrchestratorWebSocketProxy } = await import("./ws/orchestrator-proxy.js");
    const { createUpstreamRequester } = await import("./services/upstream.js");

    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: `http://127.0.0.1:${launcherPort}`,
      orchestratorRequestTimeoutMs: 500,
      launcherRequestTimeoutMs: 500,
      corsOrigins: "http://127.0.0.1:5173",
      wsUpgradePath: "/ws",
      wsConnectTimeoutMs: 500,
      workItemDefaultWorkspaceId: null,
      githubWebhookSecret: null,
      githubRepoWorkspaceMap: {},
      linearWebhookSecret: null,
      linearApiKey: null,
      linearProjectWorkspaceMap: {},
      linearTeamWorkspaceMap: {},
    });
    apiServer = createServer(app);
    attachOrchestratorWebSocketProxy(
      apiServer,
      { wsUpgradePath: "/ws", wsConnectTimeoutMs: 500 },
      createUpstreamRequester(`http://127.0.0.1:${launcherPort}`, 500),
    );
    apiPort = await listen(apiServer);
  }, 30_000);

  afterAll(async () => {
    runtimeWss.close();
    launcherRuntimeWss.close();
    await closeServer(runtimeServer);
    await closeServer(launcherServer);
    await closeServer(supabaseServer);
    await closeServer(apiServer);
  });

  it("proxies HTTP and websocket traffic to the resolved runtime", async () => {
    const capturedLogs: Array<Record<string, unknown>> = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      const line = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      try {
        capturedLogs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON writes from the test runner.
      }
      return true;
    });

    engineRows = [
      {
        agent_id: agentId,
        host: "127.0.0.1",
        instance_id: "instance-1",
        port: runtimePort,
        started_at: "2026-04-22T12:00:00.000Z",
        status: "running",
        workspace_id: workspaceId,
      },
    ];
    launcherHits = 0;
    launcherWsHeaders = null;

    try {
      const agentResponse = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${agentId}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(agentResponse.status).toBe(200);
      await expect(agentResponse.json()).resolves.toMatchObject({
        data: {
          id: agentId,
          workspace_id: workspaceId,
        },
      });
      launcherHits = 0;

      const healthResponse = await fetch(`http://127.0.0.1:${apiPort}/health`);
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toMatchObject({
        ok: true,
        runtimeTarget: null,
        orchestratorHealth: {
          error: {
            code: "runtime_unscoped",
          },
        },
      });

      const scopedHealthResponse = await fetch(`http://127.0.0.1:${apiPort}/health?agentId=${agentId}`);
      const scopedHealthBody = await scopedHealthResponse.json();
      expect(scopedHealthResponse.status).toBe(200);
      expect(scopedHealthBody).toMatchObject({
        ok: true,
        runtimeTarget: {
          agentId: agentId,
          port: runtimePort,
        },
        orchestratorHealth: {
          ok: true,
          runtime: "healthy",
        },
      });

      const ws = new WebSocket(
        `ws://127.0.0.1:${apiPort}/ws?agent_id=${agentId}&workspace_id=${workspaceId}&session_key=${sessionKey}`,
        ["platform.v1", `bearer.${accessToken}`],
        {
          headers: {
            "x-trace-id": "trc-ws-integration",
            "x-request-id": "req-ws-integration",
          },
        },
      );
      const message = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        ws.once("error", reject);
      });
      ws.send("client-ping");
      const echo = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        ws.once("error", reject);
      });
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close(1000, "done");
      await closed;
      await waitForLog(
        capturedLogs,
        (entry) => entry.event === "gateway_ws_closed" && entry.connection_side === "client",
      );

      expect(JSON.parse(message)).toMatchObject({
        type: "hello-ok",
        protocol: 3,
        scope: {
          agent_id: agentId,
          workspace_id: workspaceId,
          session_key: sessionKey,
          user_id: userId,
        },
      });
      expect(echo).toBe("client-ping");
      expect(launcherHits).toBe(0);

      expect(launcherWsHeaders).toMatchObject({
        authorization: "Bearer service-role-key",
        "x-trace-id": "trc-ws-integration",
        "x-request-id": "req-ws-integration",
      });

      const wsLogs = capturedLogs.filter((entry) => typeof entry.event === "string" && entry.connection_id);
      const connectionIds = new Set(wsLogs.map((entry) => entry.connection_id));
      expect(connectionIds.size).toBe(1);
      const upgradeLog = wsLogs.find((entry) => entry.event === "gateway_ws_upgrade_started");
      expect(upgradeLog).toMatchObject({
        trace_id: "trc-ws-integration",
        request_id: "req-ws-integration",
        agent_id: agentId,
      });
      expect(String(upgradeLog?.url)).not.toContain(accessToken);
      expect(wsLogs).toContainEqual(
        expect.objectContaining({
          event: "gateway_ws_upstream_connect_started",
          upstream_url_category: "engine_instance",
          upstream_path: `/agents/${agentId}/runtime/ws`,
        }),
      );
      expect(wsLogs).toContainEqual(
        expect.objectContaining({
          event: "gateway_ws_opened",
          connection_side: "upstream",
          handshake_duration_ms: expect.any(Number),
        }),
      );
      expect(wsLogs).toContainEqual(
        expect.objectContaining({
          event: "gateway_ws_closed",
          connection_side: "client",
          close_code: 1000,
          downstream_message_count: 2,
          upstream_message_count: 1,
        }),
      );
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("rejects websocket upgrades without a bearer subprotocol", async () => {
    const capturedLogs: Array<Record<string, unknown>> = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      const line = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      try {
        capturedLogs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON writes from the test runner.
      }
      return true;
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws?agent_id=${agentId}&workspace_id=${workspaceId}&session_key=${sessionKey}`,
    );

    try {
      await new Promise<void>((resolve) => {
        ws.once("unexpected-response", (_request, response) => {
          expect(response.statusCode).toBe(401);
          resolve();
        });
      });
      expect(capturedLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "gateway_ws_missing_token",
            auth_result: "missing_token",
            agent_id: agentId,
          }),
        ]),
      );
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("accepts bearer-only websocket subprotocols", async () => {
    engineRows = [
      {
        agent_id: agentId,
        host: "127.0.0.1",
        instance_id: "instance-bearer-only",
        port: runtimePort,
        started_at: "2026-04-22T12:00:03.000Z",
        status: "running",
        workspace_id: workspaceId,
      },
    ];

    const ws = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws?agent_id=${agentId}&workspace_id=${workspaceId}&session_key=${sessionKey}`,
      [`bearer.${accessToken}`],
    );
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    try {
      const message = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(String(data)));
        ws.once("error", reject);
        ws.once("unexpected-response", (_request, response) =>
          reject(new Error(`unexpected status ${response.statusCode}`)),
        );
      });

      expect(JSON.parse(message)).toMatchObject({
        type: "hello-ok",
        scope: {
          agent_id: agentId,
          workspace_id: workspaceId,
          user_id: userId,
        },
      });
    } finally {
      ws.close(1000, "done");
      await closed;
    }
  });

  it("rejects websocket upgrades for agents outside the caller workspace", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws?agent_id=${unauthorizedAgentId}&workspace_id=${unauthorizedWorkspaceId}&session_key=agent:${unauthorizedAgentId}:main`,
      ["platform.v1", `bearer.${accessToken}`],
    );

    const failure = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
      ws.once("open", () => reject(new Error("websocket unexpectedly opened")));
      ws.once("error", reject);
      ws.once("unexpected-response", (_request, response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body });
        });
      });
    });

    expect(failure.statusCode).toBe(403);
    expect(JSON.parse(failure.body)).toMatchObject({
      error: {
        code: "workspace_forbidden",
        message: "User is not authorized for the target workspace",
      },
    });
  });

  it("maps websocket agent lookup failures to upgrade errors", async () => {
    failAgentLookup = true;
    const ws = new WebSocket(
      `ws://127.0.0.1:${apiPort}/ws?agent_id=${agentId}&workspace_id=${workspaceId}&session_key=${sessionKey}`,
      ["platform.v1", `bearer.${accessToken}`],
    );

    try {
      const failure = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
        ws.once("open", () => reject(new Error("websocket unexpectedly opened")));
        ws.once("error", reject);
        ws.once("unexpected-response", (_request, response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({ statusCode: response.statusCode, body });
          });
        });
      });

      expect(failure.statusCode).toBe(503);
      expect(JSON.parse(failure.body)).toMatchObject({
        error: {
          code: "agent_lookup_failed",
          message: "Could not resolve authorized agent",
        },
      });
    } finally {
      failAgentLookup = false;
    }
  });

  it("refreshes launcher state when the stored runtime port is stale", async () => {
    engineRows = [
      {
        agent_id: agentId,
        host: "127.0.0.1",
        instance_id: "instance-stale",
        port: 9,
        started_at: "2026-04-22T11:59:59.000Z",
        status: "running",
        workspace_id: workspaceId,
      },
    ];
    launcherHits = 0;

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${agentId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: agentId,
        workspace_id: workspaceId,
      },
    });
    expect(launcherHits).toBeGreaterThan(0);
  });

  it("returns launcher agent state while the runtime is still starting", async () => {
    engineRows = [
      {
        agent_id: agentId,
        host: "127.0.0.1",
        instance_id: "instance-starting",
        port: runtimePort,
        started_at: "2026-04-22T12:00:02.000Z",
        status: "starting",
        workspace_id: workspaceId,
      },
    ];
    launcherHits = 0;

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${agentId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: agentId,
        workspace_id: workspaceId,
      },
    });
    expect(launcherHits).toBeGreaterThan(0);
  });
});
