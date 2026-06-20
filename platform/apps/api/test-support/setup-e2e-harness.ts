import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";

export type AgentRow = {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  name: string | null;
  model_settings: unknown;
  tool_policy: unknown;
  type: string | null;
  status: string;
  updated_at: string | null;
};

export type EngineRow = {
  instance_id: string;
  agent_id: string;
  workspace_id: string;
  host: string;
  port: number;
  role: string;
  status: string;
  started_at: string;
  last_health_at: string | null;
  updated_at: string;
  ws_connection_id: string | null;
};

export type SetupAgentPayload = {
  id: string;
  workspaceId: string;
  name: string | null;
  modelSettings: unknown;
  toolPolicy: unknown;
  type: string | null;
  status: string;
  updatedAt: string | null;
};

export type SetupEnginePayload = {
  instanceId: string;
  agentId: string;
  workspaceId: string;
  host: string;
  port: number;
  role: string;
  status: string;
  startedAt: string;
  lastHealthAt: string | null;
  updatedAt: string;
  wsConnectionId: string | null;
};

type SetupTestDatabase = {
  users: Array<Record<string, unknown>>;
  workspaces: Array<Record<string, unknown>>;
  workspaceMembers: Array<Record<string, unknown>>;
  agents: AgentRow[];
  credentials: Array<Record<string, unknown>>;
  routingRules: Array<Record<string, unknown>>;
  routingRuleMatches: Array<Record<string, unknown>>;
  routingRuleFallbacks: Array<Record<string, unknown>>;
  gatewayConfigs: Array<Record<string, unknown>>;
  gatewayConfigVersions: Array<Record<string, unknown>>;
  gatewayConfigStates: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  engineInstances: EngineRow[];
};

type ServerBundle = {
  server: Server;
  close: () => Promise<void>;
};

type LauncherBundle = ServerBundle & {
  wsServer: WebSocketServer;
  port: number;
};

type OrchestratorBundle = ServerBundle & {
  wsServer: WebSocketServer;
  port: number;
};

type SetupE2eHarnessContext = {
  db: SetupTestDatabase;
  authToken: string;
  orchestratorPort: number;
};

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "setup-e2e-kid",
  alg: "RS256",
  use: "sig",
};

export type SetupE2eHarness = {
  apiBaseUrl: string;
  authToken: string;
  db: SetupTestDatabase;
  close: () => Promise<void>;
  findLatestEngine: (agentId: string) => EngineRow | null;
};

export async function createSetupE2eHarness(): Promise<SetupE2eHarness> {
  const db = createTestDatabase();
  const previousEnv = {
    LAUNCHER_BASE_URL: process.env.LAUNCHER_BASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
  };
  const supabaseServer = await startSupabaseServer(db);
  const supabasePort = (supabaseServer.server.address() as AddressInfo).port;

  process.env.SUPABASE_URL = `http://127.0.0.1:${supabasePort}`;
  const authToken = createTestToken();
  process.env.SUPABASE_SERVICE_ROLE_KEY = authToken;

  const context: SetupE2eHarnessContext = {
    db,
    authToken,
    orchestratorPort: 0,
  };

  const orchestratorServer = await startOrchestratorServer(context);
  context.orchestratorPort = orchestratorServer.port;

  const launcherServer = await startLauncherServer(context);
  process.env.LAUNCHER_BASE_URL = `http://127.0.0.1:${launcherServer.port}`;

  const appServer = await startAppServer(launcherServer.port, orchestratorServer.port);
  const apiBaseUrl = `http://127.0.0.1:${(appServer.server.address() as AddressInfo).port}`;

  return {
    apiBaseUrl,
    authToken,
    db,
    close: async () => {
      launcherServer.wsServer.clients.forEach((client) => client.terminate());
      orchestratorServer.wsServer.clients.forEach((client) => client.terminate());
      await Promise.all([
        appServer.close(),
        launcherServer.close(),
        orchestratorServer.close(),
        supabaseServer.close(),
      ]);
      launcherServer.wsServer.close();
      orchestratorServer.wsServer.close();
      restoreEnv(previousEnv);
    },
    findLatestEngine: (agentId: string) => findLatestEngine(db, agentId),
  };
}

function createTestDatabase(): SetupTestDatabase {
  return {
    users: [
      {
        id: TEST_USER_ID,
        auth_id: null,
        email: "seeded@example.com",
        full_name: null,
        first_name: null,
        last_name: null,
        avatar_url: null,
        type: "human",
      },
    ],
    workspaces: [
      {
        id: TEST_WORKSPACE_ID,
        name: "Seeded Workspace",
        owner_user_id: TEST_USER_ID,
        created_at: new Date().toISOString(),
      },
    ],
    workspaceMembers: [
      {
        id: crypto.randomUUID(),
        workspace_id: TEST_WORKSPACE_ID,
        user_id: TEST_USER_ID,
        role: "owner",
        created_at: new Date().toISOString(),
      },
    ],
    agents: [],
    credentials: [],
    routingRules: [],
    routingRuleMatches: [],
    routingRuleFallbacks: [],
    gatewayConfigs: [],
    gatewayConfigVersions: [],
    gatewayConfigStates: [],
    skills: [],
    engineInstances: [],
  };
}

function createTestToken() {
  return jwt.sign({ email: "seeded@example.com", role: "authenticated" }, privateKey, {
    algorithm: "RS256",
    keyid: "setup-e2e-kid",
    issuer: `${process.env.SUPABASE_URL}/auth/v1`,
    audience: "authenticated",
    subject: TEST_USER_ID,
    expiresIn: "5m",
  });
}

async function startSupabaseServer(db: SetupTestDatabase): Promise<ServerBundle> {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      json(res, 200, { keys: [publicJwk] });
      return;
    }

    if (!authorize(req)) {
      json(res, 401, { message: "unauthorized" });
      return;
    }

    if (url.pathname === "/auth/v1/user") {
      json(res, 200, { id: TEST_USER_ID, email: "seeded@example.com" });
      return;
    }

    if (url.pathname === "/rest/v1/user" && req.method === "GET") {
      const authId = url.searchParams.get("auth_id")?.replace(/^eq\./, "");
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const authIdIsNull = url.searchParams.get("auth_id") === "is.null";
      const rows = db.users.filter((user) => {
        if (id && authIdIsNull) return user.id === id && user.auth_id === null;
        if (authId) return user.auth_id === authId;
        if (id) return user.id === id;
        return true;
      });
      postgrestJson(req, res, 200, rows);
      return;
    }

    if (url.pathname === "/rest/v1/workspaces" && req.method === "GET") {
      const id = parseEqFilter(url.searchParams.get("id"));
      const ownerUserId = parseEqFilter(url.searchParams.get("owner_user_id"));
      const ids = parseInFilter(url.searchParams.get("id"));
      let rows = db.workspaces;
      if (id) rows = rows.filter((workspace) => workspace.id === id);
      if (ownerUserId) rows = rows.filter((workspace) => workspace.owner_user_id === ownerUserId);
      if (ids) rows = rows.filter((workspace) => ids.includes(String(workspace.id)));
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/workspace_members" && req.method === "GET") {
      const workspaceId = url.searchParams.get("workspace_id")?.replace(/^eq\./, "");
      const userId = url.searchParams.get("user_id")?.replace(/^eq\./, "");
      let rows = db.workspaceMembers;
      if (workspaceId) rows = rows.filter((membership) => membership.workspace_id === workspaceId);
      if (userId) rows = rows.filter((membership) => membership.user_id === userId);
      rows = sortByCreatedAt(rows, url);
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/workspace_members" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const existing = db.workspaceMembers.find(
        (membership) => membership.workspace_id === payload.workspace_id && membership.user_id === payload.user_id,
      );
      if (existing) {
        Object.assign(existing, payload);
        postgrestJson(req, res, 201, [existing]);
        return;
      }
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...payload,
      };
      db.workspaceMembers.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/agent" && req.method === "GET") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const rows = id ? db.agents.filter((agent) => agent.id === id) : db.agents;
      postgrestJson(req, res, 200, rows);
      return;
    }

    if (url.pathname === "/rest/v1/credential" && req.method === "GET") {
      const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
      const rows = agentId ? db.credentials.filter((credential) => credential.agent_id === agentId) : db.credentials;
      postgrestJson(req, res, 200, rows);
      return;
    }

    if (url.pathname === "/rest/v1/skill" && req.method === "GET") {
      const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
      const workspaceId = url.searchParams.get("workspace_id")?.replace(/^eq\./, "");
      const status = url.searchParams.get("status")?.replace(/^eq\./, "");
      let rows = db.skills;
      if (agentId) rows = rows.filter((skill) => skill.agent_id === agentId);
      if (workspaceId) rows = rows.filter((skill) => skill.workspace_id === workspaceId);
      if (status) rows = rows.filter((skill) => skill.status === status);
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/agent" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const now = new Date().toISOString();
      const row: AgentRow = {
        id: crypto.randomUUID(),
        workspace_id: payload.workspace_id,
        created_by_user_id: payload.created_by_user_id ?? null,
        name: payload.name ?? null,
        model_settings: payload.model_settings ?? {},
        tool_policy: payload.tool_policy ?? {},
        type: payload.type ?? null,
        status: payload.status ?? "active",
        updated_at: now,
      };
      db.agents.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/agent" && req.method === "PATCH") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = db.agents.find((agent) => agent.id === id);
      if (!row) {
        json(res, 404, []);
        return;
      }
      Object.assign(row, payload, { updated_at: new Date().toISOString() });
      postgrestJson(req, res, 200, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/credential" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      };
      db.credentials.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule" && req.method === "GET") {
      const workspaceId = url.searchParams.get("workspace_id")?.replace(/^eq\./, "");
      const name = url.searchParams.get("name")?.replace(/^eq\./, "");
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      let rows = db.routingRules;
      if (workspaceId) rows = rows.filter((rule) => rule.workspace_id === workspaceId);
      if (name) rows = rows.filter((rule) => rule.name === name);
      if (id) rows = rows.filter((rule) => rule.id === id);
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      };
      db.routingRules.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule" && req.method === "PATCH") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const workspaceId = url.searchParams.get("workspace_id")?.replace(/^eq\./, "");
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = db.routingRules.find(
        (candidate) => candidate.id === id && (!workspaceId || candidate.workspace_id === workspaceId),
      );
      if (!row) {
        json(res, 404, []);
        return;
      }
      Object.assign(row, payload, { updated_at: new Date().toISOString() });
      postgrestJson(req, res, 200, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule_match" && req.method === "GET") {
      const filters = {
        rule_id: url.searchParams.get("rule_id")?.replace(/^eq\./, ""),
        workspace_id: url.searchParams.get("workspace_id")?.replace(/^eq\./, ""),
        kind: url.searchParams.get("kind")?.replace(/^eq\./, ""),
        key: url.searchParams.get("key")?.replace(/^eq\./, ""),
        value: url.searchParams.get("value")?.replace(/^eq\./, ""),
      };
      let rows = db.routingRuleMatches;
      rows = rows.filter((row) =>
        Object.entries(filters).every(([key, value]) => !value || String(row[key]) === value),
      );
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule_match" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...payload,
      };
      db.routingRuleMatches.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule_match" && req.method === "DELETE") {
      const filters = {
        rule_id: url.searchParams.get("rule_id")?.replace(/^eq\./, ""),
        workspace_id: url.searchParams.get("workspace_id")?.replace(/^eq\./, ""),
        kind: url.searchParams.get("kind")?.replace(/^eq\./, ""),
        key: url.searchParams.get("key")?.replace(/^eq\./, ""),
      };
      for (let index = db.routingRuleMatches.length - 1; index >= 0; index -= 1) {
        const row = db.routingRuleMatches[index];
        const matches = Object.entries(filters).every(([key, value]) => !value || String(row?.[key]) === value);
        if (matches) db.routingRuleMatches.splice(index, 1);
      }
      postgrestJson(req, res, 200, []);
      return;
    }

    if (url.pathname === "/rest/v1/routing_rule_fallback" && req.method === "GET") {
      const workspaceId = parseEqFilter(url.searchParams.get("workspace_id"));
      const ruleIds = parseInFilter(url.searchParams.get("routing_rule_id"));
      let rows = db.routingRuleFallbacks;
      if (workspaceId) rows = rows.filter((fallback) => fallback.workspace_id === workspaceId);
      if (ruleIds) rows = rows.filter((fallback) => ruleIds.includes(String(fallback.routing_rule_id)));
      rows = sortByPosition(rows, url);
      postgrestJson(req, res, 200, applyLimit(rows, url));
      return;
    }

    if (url.pathname === "/rest/v1/credential" && req.method === "DELETE") {
      const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
      if (agentId) {
        for (let index = db.credentials.length - 1; index >= 0; index -= 1) {
          if (db.credentials[index]?.agent_id === agentId) {
            db.credentials.splice(index, 1);
          }
        }
      }
      postgrestJson(req, res, 200, []);
      return;
    }

    if (url.pathname === "/rest/v1/gateway_config" && req.method === "GET") {
      const scopeId = url.searchParams.get("scope_id")?.replace(/^eq\./, "");
      postgrestJson(
        req,
        res,
        200,
        scopeId ? db.gatewayConfigs.filter((row) => row.scope_id === scopeId) : db.gatewayConfigs,
      );
      return;
    }

    if (url.pathname === "/rest/v1/gateway_config" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = {
        id: crypto.randomUUID(),
        updated_at: new Date().toISOString(),
        ...payload,
      };
      db.gatewayConfigs.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/gateway_config" && req.method === "PATCH") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = db.gatewayConfigs.find((candidate) => candidate.id === id);
      if (!row) {
        json(res, 404, []);
        return;
      }
      Object.assign(row, payload, { updated_at: new Date().toISOString() });
      postgrestJson(req, res, 200, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/gateway_config_versions" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...payload,
      };
      db.gatewayConfigVersions.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/gateway_config_state" && req.method === "GET") {
      const scopeId = url.searchParams.get("scope_id")?.replace(/^eq\./, "");
      postgrestJson(
        req,
        res,
        200,
        scopeId ? db.gatewayConfigStates.filter((row) => row.scope_id === scopeId) : db.gatewayConfigStates,
      );
      return;
    }

    if (url.pathname === "/rest/v1/engine_instance" && req.method === "GET") {
      const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
      const rows = agentId ? db.engineInstances.filter((row) => row.agent_id === agentId) : db.engineInstances;
      postgrestJson(
        req,
        res,
        200,
        rows.sort((left, right) => right.started_at.localeCompare(left.started_at)).slice(0, 1),
      );
      return;
    }

    if (url.pathname === "/rest/v1/engine_instance" && req.method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row: EngineRow = {
        instance_id: payload.instance_id,
        agent_id: payload.agent_id,
        workspace_id: payload.workspace_id,
        host: payload.host,
        port: payload.port,
        role: payload.role,
        status: payload.status,
        started_at: payload.started_at,
        last_health_at: payload.last_health_at ?? null,
        updated_at: new Date().toISOString(),
        ws_connection_id: payload.ws_connection_id ?? null,
      };
      db.engineInstances.push(row);
      postgrestJson(req, res, 201, [row]);
      return;
    }

    if (url.pathname === "/rest/v1/engine_instance" && req.method === "PATCH") {
      const instanceId = url.searchParams.get("instance_id")?.replace(/^eq\./, "");
      const payload = JSON.parse((await readBody(req)) || "{}");
      const row = db.engineInstances.find((candidate) => candidate.instance_id === instanceId);
      if (!row) {
        json(res, 404, []);
        return;
      }
      Object.assign(row, payload, { updated_at: new Date().toISOString() });
      postgrestJson(req, res, 200, [row]);
      return;
    }

    json(res, 404, { path: url.pathname });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { close: () => closeServer(server), server };
}

async function startOrchestratorServer({ db }: SetupE2eHarnessContext): Promise<OrchestratorBundle> {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/state") {
      json(res, 200, { agents: db.agents.map((agent) => ({ id: agent.id, name: agent.name })) });
      return;
    }

    const agentMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
    if (agentMatch && req.method === "GET") {
      const agentId = decodeURIComponent(agentMatch[1] ?? "");
      const agent = db.agents.find((row) => row.id === agentId);
      if (!agent) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, { id: agent.id, name: agent.name, workspace_id: agent.workspace_id });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  const wsServer = new WebSocketServer({ server });
  wsServer.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "hello-ok",
        protocol: 3,
        server: { version: "test", connId: "conn-1" },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    close: () => closeServer(server),
    port: (server.address() as AddressInfo).port,
    server,
    wsServer,
  };
}

async function startLauncherServer({ db, orchestratorPort }: SetupE2eHarnessContext): Promise<LauncherBundle> {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const startMatch = /^\/agents\/([^/]+)\/start$/.exec(url.pathname);
    const getAgentMatch = /^\/agents\/([^/]+)$/.exec(url.pathname);
    const stopMatch = /^\/worker-bridge\/sessions\/([^/]+)$/.exec(url.pathname);

    if (getAgentMatch && req.method === "GET") {
      const agentId = decodeURIComponent(getAgentMatch[1] ?? "");
      const agent = db.agents.find((row) => row.id === agentId);
      if (!agent) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, {
        data: {
          id: agent.id,
          name: agent.name,
          workspace_id: agent.workspace_id,
          project_id: null,
          description: null,
          slug: null,
          status: agent.status,
          type: agent.type,
          session_id: null,
          context: null,
          is_active: true,
          model_settings: agent.model_settings,
          tool_policy: agent.tool_policy,
          has_credentials: db.credentials.some((credential) => credential.agent_id === agentId),
          created_at: null,
          updated_at: agent.updated_at,
        },
      });
      return;
    }

    if (startMatch && req.method === "POST") {
      const agentId = decodeURIComponent(startMatch[1] ?? "");
      const agent = db.agents.find((row) => row.id === agentId);
      const gatewayConfig = db.gatewayConfigs.find((row) => row.scope_id === agentId);
      if (!agent || !gatewayConfig) {
        json(res, 404, { error: "missing_agent" });
        return;
      }

      const now = new Date().toISOString();
      const instanceId = agentId;
      const existing = findLatestEngine(db, agentId);
      if (existing) {
        Object.assign(existing, {
          host: "127.0.0.1",
          port: orchestratorPort,
          status: "running",
          last_health_at: now,
          updated_at: now,
        });
      } else {
        db.engineInstances.push({
          instance_id: instanceId,
          agent_id: agentId,
          workspace_id: agent.workspace_id,
          host: "127.0.0.1",
          port: orchestratorPort,
          role: "orchestrator",
          status: "running",
          started_at: now,
          last_health_at: now,
          updated_at: now,
          ws_connection_id: null,
        });
      }

      db.gatewayConfigStates.splice(0, db.gatewayConfigStates.length, {
        scope_type: "agent",
        scope_id: agentId,
        sync_status: "synced",
        sync_error: null,
        synced_at: now,
        last_applied_hash: gatewayConfig.config_hash,
        last_applied_version: gatewayConfig.version,
        last_apply_status: "ok",
        last_apply_error: null,
        last_apply_at: now,
        broker_instance_id: instanceId,
      });
      json(res, 200, {
        data: {
          id: instanceId,
          port: orchestratorPort,
          config: gatewayConfig.config_json ?? {},
          started_at: now,
          status: "running",
          reused: Boolean(existing),
          agent_id: agentId,
          agent_name: agent.name ?? undefined,
          workspace_id: agent.workspace_id,
        },
      });
      return;
    }

    if (stopMatch && req.method === "DELETE") {
      const instanceId = decodeURIComponent(stopMatch[1] ?? "");
      const engine = db.engineInstances.find((row) => row.instance_id === instanceId);
      if (engine) {
        engine.status = "stopped";
        engine.updated_at = new Date().toISOString();
      }
      json(res, 200, {
        data: engine
          ? {
              id: instanceId,
              kind: "codex",
              command: "codex",
              cwd: "/tmp/workspace",
              status: engine.status,
              started_at: engine.started_at,
              stopped_at: engine.updated_at,
              exit_status: 0,
              env_keys: [],
              credential_keys: [],
              agent_id: engine.agent_id,
              workspace_id: engine.workspace_id,
              credential_id: null,
            }
          : null,
      });
      return;
    }

    if (stopMatch && req.method === "GET") {
      const instanceId = decodeURIComponent(stopMatch[1] ?? "");
      const engine = db.engineInstances.find((row) => row.instance_id === instanceId);
      json(res, 200, {
        data: engine
          ? {
              id: instanceId,
              kind: "codex",
              command: "codex",
              cwd: "/tmp/workspace",
              status: engine.status,
              started_at: engine.started_at,
              stopped_at: engine.status === "stopped" ? engine.updated_at : null,
              exit_status: engine.status === "stopped" ? 0 : null,
              env_keys: [],
              credential_keys: [],
              agent_id: engine.agent_id,
              workspace_id: engine.workspace_id,
              credential_id: null,
            }
          : null,
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "hello-ok",
        protocol: 3,
        server: { version: "launcher-test", connId: "launcher-conn-1" },
      }),
    );
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (/^\/agents\/[^/]+\/runtime\/ws$/.test(url.pathname)) {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    close: () => closeServer(server),
    port: (server.address() as AddressInfo).port,
    server,
    wsServer,
  };
}

async function startAppServer(launcherPort: number, orchestratorPort: number): Promise<ServerBundle> {
  const { createApp } = await import("../src/app.js");
  const { attachOrchestratorWebSocketProxy } = await import("../src/ws/orchestrator-proxy.js");
  const { createUpstreamRequester } = await import("../src/services/upstream.js");

  const app = createApp({
    port: 0,
    host: "127.0.0.1",
    orchestratorBaseUrl: `http://127.0.0.1:${orchestratorPort}`,
    orchestratorWsUrl: `ws://127.0.0.1:${orchestratorPort}`,
    launcherBaseUrl: `http://127.0.0.1:${launcherPort}`,
    orchestratorRequestTimeoutMs: 5_000,
    launcherRequestTimeoutMs: 5_000,
    corsOrigins: "*",
    wsUpgradePath: "/ws",
    wsConnectTimeoutMs: 5_000,
    workItemDefaultWorkspaceId: null,
    githubWebhookSecret: null,
    githubRepoWorkspaceMap: {},
    linearWebhookSecret: null,
    linearApiKey: null,
    linearProjectWorkspaceMap: {},
    linearTeamWorkspaceMap: {},
  });

  const server = createHttpServer(app);
  attachOrchestratorWebSocketProxy(
    server,
    {
      wsUpgradePath: "/ws",
      wsConnectTimeoutMs: 5_000,
    },
    createUpstreamRequester(`http://127.0.0.1:${launcherPort}`, 5_000),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { close: () => closeServer(server), server };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function postgrestJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const accept = req.headers.accept ?? "";
  const wantsObject = typeof accept === "string" && accept.includes("application/vnd.pgrst.object+json");
  json(res, status, wantsObject && Array.isArray(body) ? (body[0] ?? null) : body);
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => resolve(text));
  });
}

function applyLimit<T>(rows: T[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? "");
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

function parseInFilter(value: string | null) {
  if (!value?.startsWith("in.(") || !value.endsWith(")")) return null;
  return value
    .slice(4, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEqFilter(value: string | null) {
  if (!value?.startsWith("eq.")) return null;
  return value.slice(3);
}

function sortByCreatedAt<T extends Record<string, unknown>>(rows: T[], url: URL) {
  if (url.searchParams.get("order") !== "created_at.asc") return rows;
  return [...rows].sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
}

function sortByPosition<T extends Record<string, unknown>>(rows: T[], url: URL) {
  if (url.searchParams.get("order") !== "position.asc") return rows;
  return [...rows].sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
}

function restoreEnv(previousEnv: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function authorize(req: IncomingMessage) {
  return req.headers.authorization === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
}

function findLatestEngine(db: SetupTestDatabase, agentId: string) {
  return (
    db.engineInstances
      .filter((row) => row.agent_id === agentId)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))[0] ?? null
  );
}

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
