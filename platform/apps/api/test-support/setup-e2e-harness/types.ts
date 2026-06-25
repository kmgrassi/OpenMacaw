import type { Server } from "node:http";

import type { WebSocketServer } from "ws";

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

export type SetupTestDatabase = {
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

export type ServerBundle = {
  server: Server;
  close: () => Promise<void>;
};

export type LauncherBundle = ServerBundle & {
  wsServer: WebSocketServer;
  port: number;
};

export type OrchestratorBundle = ServerBundle & {
  wsServer: WebSocketServer;
  port: number;
};

export type SetupE2eHarnessContext = {
  db: SetupTestDatabase;
  authToken: string;
  orchestratorPort: number;
};

export type SetupE2eHarness = {
  apiBaseUrl: string;
  authToken: string;
  db: SetupTestDatabase;
  close: () => Promise<void>;
  findLatestEngine: (agentId: string) => EngineRow | null;
};

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
