import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createTestToken, restoreEnv } from "./setup-e2e-harness/auth.js";
import { createTestDatabase, findLatestEngine } from "./setup-e2e-harness/database.js";
import { closeServer } from "./setup-e2e-harness/http.js";
import { startLauncherServer } from "./setup-e2e-harness/mock-launcher-server.js";
import { startOrchestratorServer } from "./setup-e2e-harness/mock-orchestrator-server.js";
import { startSupabaseServer } from "./setup-e2e-harness/mock-supabase-server.js";
import type { ServerBundle, SetupE2eHarness, SetupE2eHarnessContext } from "./setup-e2e-harness/types.js";

export {
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  type AgentRow,
  type EngineRow,
  type SetupAgentPayload,
  type SetupE2eHarness,
  type SetupEnginePayload,
} from "./setup-e2e-harness/types.js";

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
