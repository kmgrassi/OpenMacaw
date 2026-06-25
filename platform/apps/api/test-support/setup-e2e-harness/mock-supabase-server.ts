import { createServer as createHttpServer } from "node:http";

import { authorize, publicJwk } from "./auth.js";
import {
  closeServer,
  json,
  postgrestJson,
  readBody,
  applyLimit,
  parseEqFilter,
  parseInFilter,
  sortByCreatedAt,
  sortByName,
  sortByPosition,
} from "./http.js";
import type { AgentRow, EngineRow, ServerBundle, SetupTestDatabase } from "./types.js";
import { TEST_USER_ID } from "./types.js";

export async function startSupabaseServer(db: SetupTestDatabase): Promise<ServerBundle> {
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
      const agentId = parseEqFilter(url.searchParams.get("agent_id"));
      const workspaceId = parseEqFilter(url.searchParams.get("workspace_id"));
      const status = parseEqFilter(url.searchParams.get("status"));
      let rows = db.skills;
      if (agentId) rows = rows.filter((skill) => skill.agent_id === agentId);
      if (workspaceId) rows = rows.filter((skill) => skill.workspace_id === workspaceId);
      if (status) rows = rows.filter((skill) => skill.status === status);
      postgrestJson(req, res, 200, applyLimit(sortByName(rows, url), url));
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
