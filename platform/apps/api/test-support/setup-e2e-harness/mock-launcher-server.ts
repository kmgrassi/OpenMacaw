import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { findLatestEngine } from "./database.js";
import { closeServer, json } from "./http.js";
import type { LauncherBundle, SetupE2eHarnessContext } from "./types.js";

export async function startLauncherServer({ db, orchestratorPort }: SetupE2eHarnessContext): Promise<LauncherBundle> {
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
