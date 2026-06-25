import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { closeServer, json } from "./http.js";
import type { OrchestratorBundle, SetupE2eHarnessContext } from "./types.js";

export async function startOrchestratorServer({ db }: SetupE2eHarnessContext): Promise<OrchestratorBundle> {
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
