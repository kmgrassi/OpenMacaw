import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateDefaultAgentAssignment } from "./setup.js";
import { createSetupAgent, findSetupAgentById, listSetupAgentRows } from "../repositories/agents.js";
import { getServiceRoleSupabase, getUserScopedSupabase } from "../supabase-client.js";
import type * as SupabaseClient from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";

vi.mock("../repositories/agents.js", () => ({
  createSetupAgent: vi.fn(),
  findSetupAgentById: vi.fn(),
  listSetupAgentRows: vi.fn(),
  updateSetupAgent: vi.fn(),
}));

vi.mock("../repositories/credentials.js", () => ({
  createAgentCredential: vi.fn(),
}));

vi.mock("../supabase-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseClient>()),
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

vi.mock("./credentials/agent-scope.js", () => ({
  countCredentialsForAgent: vi.fn().mockResolvedValue(1),
  hasCredentialForAgent: vi.fn().mockResolvedValue(true),
}));

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CODING_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PLANNING_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ONE_ID = "11111111-1111-4111-8111-111111111111";
const USER_TWO_ID = "55555555-5555-4555-8555-555555555555";

type Role = "coding" | "planning";

function agent(id: string, type: Role) {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    name: `${type} agent`,
    status: "active",
    type,
    context: null,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: USER_ONE_ID,
    updated_at: "2026-04-25T00:00:00.000Z",
  };
}

const agentsById = new Map<string, ReturnType<typeof agent>>();

describe("default agent assignment updates", () => {
  let assignmentByUserRole: Map<string, { user_id: string; role: Role; agent_id: string }>;

  beforeEach(() => {
    assignmentByUserRole = new Map();
    agentsById.clear();
    agentsById.set(CODING_AGENT_ID, agent(CODING_AGENT_ID, "coding"));
    agentsById.set(PLANNING_AGENT_ID, agent(PLANNING_AGENT_ID, "planning"));
    vi.mocked(createSetupAgent).mockReset();
    vi.mocked(findSetupAgentById).mockReset();
    vi.mocked(listSetupAgentRows).mockReset();
    const supabase = createMockSupabaseClient({
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: "Workspace",
          owner_user_id: USER_ONE_ID,
          created_at: "2026-04-25T00:00:00.000Z",
        },
      ],
      workspace_members: [
        { workspace_id: WORKSPACE_ID, user_id: USER_ONE_ID, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
        { workspace_id: WORKSPACE_ID, user_id: USER_TWO_ID, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agent_default_assignment: [],
      agent: Array.from(agentsById.values()),
      gateway_config: [],
      gateway_config_state: [],
      engine_instance: [],
      scheduled_task: [],
    });
    vi.mocked(getUserScopedSupabase).mockReturnValue(supabase as never);
    vi.mocked(getServiceRoleSupabase).mockReturnValue(supabase as never);

    vi.mocked(createSetupAgent).mockImplementation(async (input) =>
      agent(input.type === "planning" ? PLANNING_AGENT_ID : CODING_AGENT_ID, input.type as Role),
    );
    vi.mocked(findSetupAgentById).mockImplementation(async (_accessToken, agentId) => agentsById.get(agentId) ?? null);
    vi.mocked(listSetupAgentRows).mockResolvedValue([
      agent(CODING_AGENT_ID, "coding"),
      agent(PLANNING_AGENT_ID, "planning"),
    ]);
  });

  it("stores the selected default per user and workspace", async () => {
    const userOneState = await updateDefaultAgentAssignment("token-one", USER_ONE_ID, {
      workspaceId: WORKSPACE_ID,
      role: "coding",
      agentId: CODING_AGENT_ID,
    });
    const userTwoState = await updateDefaultAgentAssignment("token-two", USER_TWO_ID, {
      workspaceId: WORKSPACE_ID,
      role: "planning",
      agentId: PLANNING_AGENT_ID,
    });

    expect(userOneState.defaultAgents.coding.agentId).toBe(CODING_AGENT_ID);
    expect(userTwoState.defaultAgents.planning.agentId).toBe(PLANNING_AGENT_ID);
  });

  it("rejects agents that do not match the requested default role", async () => {
    await expect(
      updateDefaultAgentAssignment("token", USER_ONE_ID, {
        workspaceId: WORKSPACE_ID,
        role: "planning",
        agentId: CODING_AGENT_ID,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "default_role_mismatch",
    });
    expect(assignmentByUserRole).toHaveLength(0);
  });
});
