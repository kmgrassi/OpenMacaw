import { TEST_USER_ID, TEST_WORKSPACE_ID, type SetupTestDatabase } from "./types.js";

export function createTestDatabase(): SetupTestDatabase {
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

export function findLatestEngine(db: SetupTestDatabase, agentId: string) {
  return (
    db.engineInstances
      .filter((row) => row.agent_id === agentId)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))[0] ?? null
  );
}
