import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const managerAgentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "44444444-4444-4444-8444-444444444444";

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

function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("agent proxy auth", () => {
  let backendServer: ReturnType<typeof createServer> | undefined;
  let apiServer: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await closeServer(apiServer);
    await closeServer(backendServer);
    apiServer = undefined;
    backendServer = undefined;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.LAUNCHER_BASE_URL;
    vi.resetModules();
  });

  it("allows HS256 Supabase tokens on client-facing agent routes", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      audience: "authenticated",
      expiresIn: "5m",
    });

    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === `Bearer ${token}`) {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        return json(res, 200, [
          {
            id: agentId,
            name: "Proxy Agent",
            status: "active",
            type: "coding",
            workspace_id: workspaceId,
            model_settings: { primary: "openai/gpt-5.2" },
            tool_policy: {},
            created_by_user_id: userId,
            updated_at: "2026-04-24T12:00:00.000Z",
          },
        ]);
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
        return json(res, 200, [
          {
            id: "credential-1",
            agent_id: agentId,
            workspace_id: workspaceId,
            user_id: userId,
            format: "api_key",
            provider: "openai",
            display_name: "OpenAI",
            key_value: { OPENAI_API_KEY: "sk-test", key_last4: "test" },
            updated_at: "2026-04-24T12:00:00.000Z",
          },
        ]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/skill") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule_match") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/credential_alias") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/gateway_config") {
        return json(res, 200, [
          {
            id: "55555555-5555-4555-8555-555555555555",
            scope_id: agentId,
            version: 1,
            config_hash: "hash-1",
            config_json: {
              tracker: { kind: "memory" },
              runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }],
            },
          },
        ]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/routing_rule_match") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        return json(res, 200, [{ workspace_id: workspaceId }]);
      }

      // stored-agent-management reads session_thread to derive the
      // last-known model per agent (separate from the messages handler).
      if (req.method === "GET" && url.pathname === "/rest/v1/session_thread") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/message") {
        return json(res, 200, [
          {
            id: "message-1",
            role: "assistant",
            content: "hello",
            created_at: "2026-04-24T12:00:00.000Z",
            metadata: {},
            run_id: null,
            session_id: null,
            user_id: null,
            agent_id: agentId,
            workspace_id: workspaceId,
            message_type: "chat",
          },
        ]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/engine_instance") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === `/agents/${agentId}/runtime/api/v1/health`) {
        expect(req.headers.authorization).toBe("Bearer service-role-key");
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === `/agents/${agentId}/runtime/api/v1/state`) {
        expect(req.headers.authorization).toBe("Bearer service-role-key");
        return json(res, 200, { agents: [{ id: agentId, workspace_id: workspaceId }] });
      }

      if (req.method === "POST" && url.pathname === `/agents/${agentId}/start`) {
        return json(res, 202, {
          data: {
            id: "orch-1",
            port: 4101,
            config: {},
            started_at: "2026-04-24T12:00:00.000Z",
            status: "running",
            reused: false,
            agent_id: agentId,
            workspace_id: workspaceId,
          },
        });
      }

      return json(res, 404, { error: "not_found", path: url.pathname });
    });
    const backendPort = await listen(backendServer);
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    process.env.SUPABASE_URL = backendBaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.LAUNCHER_BASE_URL = backendBaseUrl;

    vi.resetModules();
    const { createApp } = await import("../app.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: backendBaseUrl,
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
    const apiPort = await listen(apiServer);

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agents: [{ id: agentId, workspace_id: workspaceId }],
    });

    const startResponse = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${agentId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(startResponse.status).toBe(202);
    await expect(startResponse.json()).resolves.toMatchObject({
      data: { id: "orch-1", agent_id: agentId, status: "running" },
    });

    const messagesResponse = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${agentId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(messagesResponse.status).toBe(200);
    await expect(messagesResponse.json()).resolves.toMatchObject({
      messages: [{ role: "assistant", content: "hello" }],
    });
  }, 30_000);

  it("serves manager transcript messages from Supabase without a runtime target", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      audience: "authenticated",
      expiresIn: "5m",
    });

    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === `Bearer ${token}`) {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        return json(res, 200, {
          id: managerAgentId,
          type: "manager",
          workspace_id: workspaceId,
        });
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

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        return json(res, 200, [{ workspace_id: workspaceId }]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/message") {
        // Autonomous manager scheduler messages are written by the runtime
        // with user_id = null. Workspace members must still see them.
        return json(res, 200, [
          {
            id: "message-1",
            role: "assistant",
            content: "Reviewed one due task.",
            created_at: "2026-04-30T12:00:00.000Z",
            metadata: { source: "manager_scheduler" },
            run_id: "run-1",
            session_id: "session-manager-1",
            user_id: null,
            agent_id: managerAgentId,
            workspace_id: workspaceId,
            message_type: "chat",
            tool_call: [
              {
                id: "tool-call-1",
                tool_id: null,
                input: JSON.stringify({
                  call_id: "call-1",
                  tool_name: "work_items.list",
                  input: { arguments: { state: "due" } },
                }),
                output: JSON.stringify({
                  status: "ok",
                  output: { result: { count: 1 } },
                }),
                created_at: "2026-04-30T12:00:01.000Z",
              },
            ],
          },
          {
            id: "message-0",
            role: "user",
            content: "What tasks are due?",
            created_at: "2026-04-30T11:59:59.000Z",
            metadata: {},
            run_id: "run-1",
            session_id: "session-manager-1",
            user_id: userId,
            agent_id: managerAgentId,
            workspace_id: workspaceId,
            message_type: "chat",
            tool_call: [],
          },
        ]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent_tool_call_event") {
        expect(url.searchParams.get("run_id")).toBe("in.(run-1)");
        return json(res, 200, [
          {
            id: "event-tool-call-1",
            run_id: "run-1",
            correlation_id: "call-1",
            tool_slug: "work_items.list",
            status: "ok",
            arguments: { state: "due" },
            result: { result: { count: 1 }, success: true },
            output_summary: "1 due item",
            error_code: null,
            error_message: null,
            created_at: "2026-04-30T12:00:02.000Z",
            sequence: 0,
          },
        ]);
      }

      if (req.method === "GET" && url.pathname === `/agents/${managerAgentId}/runtime/api/v1/messages`) {
        return json(res, 500, { error: "should_not_proxy_manager_messages" });
      }

      return json(res, 404, { error: "not_found", path: url.pathname });
    });

    const backendPort = await listen(backendServer);
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    process.env.SUPABASE_URL = backendBaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.LAUNCHER_BASE_URL = backendBaseUrl;

    vi.resetModules();
    const { createApp } = await import("../app.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: backendBaseUrl,
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
    const apiPort = await listen(apiServer);

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "Reviewed one due task.",
          metadata: { source: "manager_scheduler" },
          toolCalls: [
            {
              id: "event-tool-call-1",
              toolId: null,
              input: JSON.stringify({
                call_id: "call-1",
                tool_name: "work_items.list",
                input: { arguments: { state: "due" } },
              }),
              output: JSON.stringify({
                status: "ok",
                output: { result: { count: 1 }, success: true },
                output_summary: "1 due item",
              }),
              createdAt: "2026-04-30T12:00:02.000Z",
            },
          ],
          userId: null,
        },
        {
          id: "message-0",
          role: "user",
          content: "What tasks are due?",
          toolCalls: [],
          userId,
        },
      ],
    });
  });

  it("returns 403 when manager transcript requester is outside the workspace", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      audience: "authenticated",
      expiresIn: "5m",
    });

    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === `Bearer ${token}`) {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
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

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        return json(res, 200, {
          id: managerAgentId,
          type: "manager",
          workspace_id: workspaceId,
        });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/workspaces") {
        return json(res, 200, []);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/message") {
        return json(res, 500, { error: "should_not_query_messages_without_workspace_access" });
      }

      return json(res, 404, { error: "not_found", path: url.pathname });
    });

    const backendPort = await listen(backendServer);
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    process.env.SUPABASE_URL = backendBaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.LAUNCHER_BASE_URL = backendBaseUrl;

    vi.resetModules();
    const { createApp } = await import("../app.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: backendBaseUrl,
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
    const apiPort = await listen(apiServer);

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "forbidden",
        message: "Authenticated user is not authorized for the requested workspace",
      },
    });
  });

  it("returns mixed autonomous and user-authored manager messages to a workspace member", async () => {
    const otherUserId = "55555555-5555-4555-8555-555555555555";
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      audience: "authenticated",
      expiresIn: "5m",
    });

    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === `Bearer ${token}`) {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        return json(res, 200, {
          id: managerAgentId,
          type: "manager",
          workspace_id: workspaceId,
        });
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

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        return json(res, 200, [{ workspace_id: workspaceId }]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/message") {
        // Workspace-membership gating must surface every manager message
        // regardless of who wrote it: autonomous runtime ticks (user_id null)
        // and human follow-ups from any workspace member.
        return json(res, 200, [
          {
            id: "message-autonomous",
            role: "assistant",
            content: "Manager checked 2 due tasks.",
            created_at: "2026-04-30T12:00:00.000Z",
            metadata: { source: "manager_scheduler", kind: "due_tasks", work_item_ids: ["wi-1", "wi-2"] },
            run_id: "run-autonomous",
            session_id: "session-manager-1",
            user_id: null,
            agent_id: managerAgentId,
            workspace_id: workspaceId,
            message_type: "chat",
          },
          {
            id: "message-other-user",
            role: "user",
            content: "Why did the manager skip wi-3?",
            created_at: "2026-04-30T12:05:00.000Z",
            metadata: {},
            run_id: null,
            session_id: "session-manager-1",
            user_id: otherUserId,
            agent_id: managerAgentId,
            workspace_id: workspaceId,
            message_type: "chat",
          },
        ]);
      }

      return json(res, 404, { error: "not_found", path: url.pathname });
    });

    const backendPort = await listen(backendServer);
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    process.env.SUPABASE_URL = backendBaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.LAUNCHER_BASE_URL = backendBaseUrl;

    vi.resetModules();
    const { createApp } = await import("../app.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: backendBaseUrl,
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
    const apiPort = await listen(apiServer);

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: Array<{ id: string; userId: string | null }> };
    expect(body.messages.map((m) => ({ id: m.id, userId: m.userId }))).toEqual([
      { id: "message-autonomous", userId: null },
      { id: "message-other-user", userId: otherUserId },
    ]);
  });

  it("uses a stable keyset cursor for older manager transcript pages", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      audience: "authenticated",
      expiresIn: "5m",
    });
    const latestRows = Array.from({ length: 21 }, (_, index) => {
      const messageNumber = 30 - index;
      return {
        id: `message-${String(messageNumber).padStart(2, "0")}`,
        role: "assistant",
        content: `message ${messageNumber}`,
        created_at: `2026-04-30T12:${String(messageNumber).padStart(2, "0")}:00.000Z`,
        metadata: {},
        run_id: null,
        session_id: "session-manager-1",
        user_id: null,
        agent_id: managerAgentId,
        workspace_id: workspaceId,
        message_type: "chat",
      };
    });
    const olderRow = {
      ...latestRows[20],
      id: "message-older",
      content: "older message",
      created_at: "2026-04-30T12:00:00.000Z",
    };
    const messageQueryParams: string[] = [];

    backendServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === `Bearer ${token}`) {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/agent") {
        return json(res, 200, {
          id: managerAgentId,
          type: "manager",
          workspace_id: workspaceId,
        });
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

      if (req.method === "GET" && url.pathname === "/rest/v1/workspace_members") {
        return json(res, 200, [{ workspace_id: workspaceId }]);
      }

      if (req.method === "GET" && url.pathname === "/rest/v1/message") {
        messageQueryParams.push(url.searchParams.toString());
        const createdAtFilter = url.searchParams.get("created_at");
        if (!createdAtFilter) {
          return json(res, 200, latestRows);
        }
        if (createdAtFilter.startsWith("eq.")) {
          return json(res, 200, []);
        }
        if (createdAtFilter.startsWith("lt.")) {
          return json(res, 200, [olderRow]);
        }
      }

      return json(res, 404, { error: "not_found", path: url.pathname });
    });

    const backendPort = await listen(backendServer);
    const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    process.env.SUPABASE_URL = backendBaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.LAUNCHER_BASE_URL = backendBaseUrl;

    vi.resetModules();
    const { createApp } = await import("../app.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: "http://127.0.0.1:4000",
      orchestratorWsUrl: "ws://127.0.0.1:4000",
      launcherBaseUrl: backendBaseUrl,
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
    const apiPort = await listen(apiServer);

    const invalidCursorResponse = await fetch(
      `http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages?before=not-a-cursor`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(invalidCursorResponse.status).toBe(400);
    await expect(invalidCursorResponse.json()).resolves.toMatchObject({
      error: {
        code: "invalid_cursor",
        message: "Message pagination cursor is invalid",
      },
    });

    const firstResponse = await fetch(`http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      messages: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(firstBody.messages).toHaveLength(20);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(firstBody.pageInfo.nextCursor).toEqual(expect.any(String));

    const olderResponse = await fetch(
      `http://127.0.0.1:${apiPort}/api/agents/${managerAgentId}/messages?before=${encodeURIComponent(
        firstBody.pageInfo.nextCursor ?? "",
      )}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(olderResponse.status).toBe(200);
    await expect(olderResponse.json()).resolves.toMatchObject({
      messages: [{ id: "message-older" }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(messageQueryParams[1]).toContain("created_at=eq.");
    expect(messageQueryParams[1]).toContain("id=lt.message-11");
    expect(messageQueryParams[2]).toContain("created_at=lt.");
  });
});
