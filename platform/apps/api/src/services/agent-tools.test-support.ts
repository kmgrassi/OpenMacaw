import { beforeEach, vi } from "vitest";

import type * as AgentToolsModule from "./agent-tools.js";
import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClientModule from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import * as agentTools from "./agent-tools.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

export const addToolOverrideToAgent: typeof AgentToolsModule.addToolOverrideToAgent = agentTools.addToolOverrideToAgent;
export const appendToolExamples: typeof AgentToolsModule.appendToolExamples = agentTools.appendToolExamples;
export const applyToolPolicyTemplateToAgent: typeof AgentToolsModule.applyToolPolicyTemplateToAgent =
  agentTools.applyToolPolicyTemplateToAgent;
export const assignToolToAgent: typeof AgentToolsModule.assignToolToAgent = agentTools.assignToolToAgent;
export const createTool: typeof AgentToolsModule.createTool = agentTools.createTool;
export const deleteAgentToolGrant: typeof AgentToolsModule.deleteAgentToolGrant = agentTools.deleteAgentToolGrant;
export const getAgentToolSettings: typeof AgentToolsModule.getAgentToolSettings = agentTools.getAgentToolSettings;
export const getResolvedToolsForAgent: typeof AgentToolsModule.getResolvedToolsForAgent =
  agentTools.getResolvedToolsForAgent;
export const getToolsForAgent: typeof AgentToolsModule.getToolsForAgent = agentTools.getToolsForAgent;
export const listTools: typeof AgentToolsModule.listTools = agentTools.listTools;
export const removeToolOverrideFromAgent: typeof AgentToolsModule.removeToolOverrideFromAgent =
  agentTools.removeToolOverrideFromAgent;
export const replaceAgentToolBundles: typeof AgentToolsModule.replaceAgentToolBundles =
  agentTools.replaceAgentToolBundles;
export const setAgentToolGrant: typeof AgentToolsModule.setAgentToolGrant = agentTools.setAgentToolGrant;
export const unassignToolFromAgent: typeof AgentToolsModule.unassignToolFromAgent = agentTools.unassignToolFromAgent;
export const updateTool: typeof AgentToolsModule.updateTool = agentTools.updateTool;

export const accessToken = "test-token";
export const userId = "11111111-1111-4111-8111-111111111111";
export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const agentId = "33333333-3333-4333-8333-333333333333";
export const toolId = "44444444-4444-4444-8444-444444444444";
export const mockedFindSetupAgentById = vi.mocked(findSetupAgentById);
export const mockedGetServiceRoleSupabase = vi.mocked(getServiceRoleSupabase);
export const mockedAssertWorkspaceMembership = vi.mocked(assertWorkspaceMembership);

type SetupAgent = NonNullable<Awaited<ReturnType<typeof findSetupAgentById>>>;
export type TableRows = Array<Record<string, unknown>>;

export type AgentToolTables = {
  agent: TableRows;
  tool: TableRows;
  agent_tool: TableRows;
  agent_tool_grant: TableRows;
  tool_policy_template: TableRows;
  tool_policy_template_tool: TableRows;
} & Record<string, TableRows>;

export function agent(workspace = workspaceId, toolPolicy: SetupAgent["tool_policy"] = {}): SetupAgent {
  return {
    id: agentId,
    workspace_id: workspace,
    name: "Coding Agent",
    status: "ready",
    type: "coding" as const,
    context: null,
    model_settings: {},
    tool_policy: toolPolicy,
    created_by_user_id: userId,
    updated_at: "2026-04-26T12:00:00.000Z",
  };
}

export function tool(overrides: Record<string, unknown> = {}) {
  return {
    id: toolId,
    workspace_id: null,
    slug: "read_file",
    name: "Read File",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    examples: [],
    function_name: "filesystem_read",
    execution_kind: "filesystem_read",
    runner_kind: "local_relay",
    enabled: true,
    created_by_user_id: null,
    ...overrides,
  };
}

export function createAgentToolTables(): AgentToolTables {
  return {
    agent: [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [] }],
    tool: [tool()],
    agent_tool: [{ id: "assignment-1", agent_id: agentId, tool_id: toolId }],
    agent_tool_grant: [
      {
        id: "grant-1",
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "include",
        source: "migration",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ],
    tool_policy_template: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: null,
        slug: "coding",
        name: "Coding",
        description: "Coding tools",
        system_managed: true,
        enabled: true,
      },
    ],
    tool_policy_template_tool: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: null,
        template_id: "55555555-5555-4555-8555-555555555555",
        tool_id: toolId,
      },
    ],
    local_runtime_machine: [],
    routing_rule: [],
    routing_rule_match: [],
  };
}

export function setupAgentToolsTest() {
  let tables = createAgentToolTables();

  beforeEach(() => {
    vi.restoreAllMocks();
    tables = createAgentToolTables();
    mockedGetServiceRoleSupabase.mockReturnValue(createMockSupabaseClient(tables) as never);
    mockedFindSetupAgentById.mockResolvedValue(agent());
    mockedAssertWorkspaceMembership.mockResolvedValue(undefined);
  });

  return {
    get tables() {
      return tables;
    },
  };
}
