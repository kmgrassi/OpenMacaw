import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase, getSupabaseForAccessToken, getUserScopedSupabase } from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getAgentHealth, getSetup, listSetupAuthState } from "./setup.js";
import { DEFAULT_MANAGER_TOOL_SLUGS } from "./tool-bundles.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getSupabaseForAccessToken: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  executeLoggedSupabaseRows: vi.fn(
    async (_options: unknown, query: PromiseLike<{ data: unknown; error: Error | null }>) => {
      const { data, error } = await query;
      if (error) throw error;
      return Array.isArray(data) ? data : data ? [data] : [];
    },
  ),
  executeSupabaseRows: vi.fn(async (_context: string, query: PromiseLike<{ data: unknown; error: Error | null }>) => {
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) ? data : data ? [data] : [];
  }),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "44444444-4444-4444-8444-444444444444";
const codingAgentId = "55555555-5555-4555-8555-555555555555";
const managerAgentId = "66666666-6666-4666-8666-666666666666";
const routerAgentId = "77777777-7777-4777-8777-777777777777";
const managerTemplateId = "88888888-8888-4888-8888-888888888888";

type Row = Record<string, unknown>;

function rowKind(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row).kind : null;
}

function agent(overrides: Partial<Row> & { id: string; type: string | null }): Row {
  const { id, type, ...rest } = overrides;
  return {
    id,
    workspace_id: workspaceId,
    name: type === "planning" ? "Planning Agent" : type === "manager" ? "Manager Agent" : "Coding Agent",
    status: "active",
    type,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: userId,
    updated_at: "2026-04-25T00:00:00.000Z",
    ...rest,
  };
}

function toolId(slug: string) {
  return `tool-${slug.replaceAll(".", "-")}`;
}

function managerToolCatalog() {
  return {
    tool: DEFAULT_MANAGER_TOOL_SLUGS.map((slug) => ({
      id: toolId(slug),
      workspace_id: null,
      slug,
      enabled: true,
    })),
    tool_policy_template: [
      {
        id: managerTemplateId,
        workspace_id: null,
        slug: "manager",
        enabled: true,
      },
    ],
    tool_policy_template_tool: DEFAULT_MANAGER_TOOL_SLUGS.map((slug) => ({
      template_id: managerTemplateId,
      tool_id: toolId(slug),
    })),
    agent_tool_grant: [] as Row[],
  };
}

function workspace(id = workspaceId): Row {
  return {
    id,
    name: "Workspace",
    owner_user_id: userId,
    created_at: "2026-04-25T00:00:00.000Z",
  };
}

function setupSupabaseMock(input?: {
  workspaces?: Row[];
  memberships?: Row[];
  agents?: Row[];
  assignments?: Row[];
  credentialAgentIds?: string[];
  scopedCredentials?: Row[];
  gatewayConfigAgentIds?: string[];
  scheduledTasks?: Row[];
  workspaceSettings?: Row[];
}) {
  const state = {
    workspaces: [...(input?.workspaces ?? [])],
    memberships: [...(input?.memberships ?? [])],
    agents: [...(input?.agents ?? [])],
    assignments: [...(input?.assignments ?? [])],
    credentialAgentIds: new Set(input?.credentialAgentIds ?? []),
    scopedCredentials: input?.scopedCredentials ? [...input.scopedCredentials] : null,
    gatewayConfigAgentIds: new Set(input?.gatewayConfigAgentIds ?? []),
    scheduledTasks: [...(input?.scheduledTasks ?? [])],
    workspaceSettings: [...(input?.workspaceSettings ?? [])],
    agentToolGrants: [] as Row[],
  };
  const managerCatalog = managerToolCatalog();

  const supabaseTables = {
    workspaces: state.workspaces,
    workspace_members: state.memberships,
    agent: state.agents,
    agent_default_assignment: state.assignments,
    credential:
      state.scopedCredentials ??
      [...state.credentialAgentIds].map((id) => ({
        id: `${id}:credential`,
        agent_id: id,
        format: "api_key",
        provider: "openai",
        display_name: "openai",
        key_value: { OPENAI_API_KEY: "sk-test", key_last4: "test" },
        workspace_id: workspaceId,
        user_id: userId,
        updated_at: "2026-04-25T00:00:00.000Z",
      })),
    gateway_config: [...state.gatewayConfigAgentIds].map((id) => ({
      id: `${id}:gateway-config`,
      scope_type: "agent",
      scope_id: id,
      version: 1,
      config_hash: "hash",
      config_json: { runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }] },
      updated_at: "2026-04-25T00:00:00.000Z",
      updated_by: userId,
    })),
    scheduled_task: state.scheduledTasks,
    workspace_settings: state.workspaceSettings,
    tool: managerCatalog.tool,
    tool_policy_template: managerCatalog.tool_policy_template,
    tool_policy_template_tool: managerCatalog.tool_policy_template_tool,
    agent_tool_grant: state.agentToolGrants,
  };
  const supabaseClient = createMockSupabaseClient(supabaseTables);
  vi.mocked(getServiceRoleSupabase).mockReturnValue(supabaseClient as never);
  vi.mocked(getSupabaseForAccessToken).mockReturnValue(supabaseClient as never);
  vi.mocked(getUserScopedSupabase).mockReturnValue(supabaseClient as never);

  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("default-agent auth bootstrap", () => {
  it("creates a workspace, default agents, manager agent, router agent, and assignments without duplicating on repeat calls", async () => {
    const state = setupSupabaseMock();

    const first = await listSetupAuthState("access-token", userId);
    const second = await listSetupAuthState("access-token", userId);
    const createdPlanningAgent = state.agents.find((row) => row.type === "planning");
    const createdCodingAgent = state.agents.find((row) => row.type === "coding");
    const createdManagerAgent = state.agents.find((row) => row.type === "manager");
    const createdRouterAgent = state.agents.find((row) => row.type === "router");
    const routerTask = state.scheduledTasks.find((row) => rowKind(row.metadata) === "router_optimization");

    expect(first.workspaceId).toBe(state.workspaces[0]?.id);
    expect(first.defaultAgents.planning?.agentId).toBe(createdPlanningAgent?.id);
    expect(first.defaultAgents.coding?.agentId).toBe(createdCodingAgent?.id);
    expect(first.managerAgent.agentId).toBe(createdManagerAgent?.id);
    expect(first.agents.find((row) => row.id === createdRouterAgent?.id)?.type).toBe("router");
    expect(first.managerAgent).toMatchObject({
      configured: false,
      missing: ["credential", "gateway_config", "runner"],
    });
    expect(first.resolvedAgentId).toBe(createdPlanningAgent?.id);
    expect(first.onboarding).toEqual({
      required: true,
      blocking: true,
      reasons: [
        "planning_missing_credential",
        "planning_missing_model",
        "planning_missing_gateway_config",
        "planning_missing_runner",
        "coding_missing_credential",
        "coding_missing_model",
        "coding_missing_gateway_config",
        "coding_missing_runner",
      ],
    });
    expect(second.defaultAgents.coding?.agentId).toBe(createdCodingAgent?.id);
    expect(second.managerAgent.agentId).toBe(createdManagerAgent?.id);
    expect(state.agents).toHaveLength(4);
    expect(state.assignments).toHaveLength(2);
    expect(state.assignments.map((row) => row.role)).toEqual(["planning", "coding"]);
    expect(state.workspaces[0]?.id).toBe("workspaces-1");
    expect(state.workspaces[0]?.id).not.toBe(userId);
    expect(state.agents.map((row) => row.id)).toHaveLength(4);
    expect(state.agentToolGrants.map((grant) => grant.tool_id).sort()).toEqual(
      DEFAULT_MANAGER_TOOL_SLUGS.map(toolId).sort(),
    );
    expect(state.scheduledTasks).toHaveLength(1);
    expect(routerTask).toMatchObject({
      workspace_id: state.workspaces[0]?.id,
      agent_id: createdRouterAgent?.id,
      title: "Router optimization",
      enabled: true,
      schedule: { kind: "every", interval: 12, unit: "hour" },
      delivery: {
        kind: "scheduled_agent_message",
        sessionStrategy: "scheduled_task",
        metadata: { kind: "router_optimization" },
      },
      metadata: { kind: "router_optimization" },
    });
  });

  it("preserves user-edited router optimization task instructions on repeat bootstrap", async () => {
    const state = setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [agent({ id: routerAgentId, type: "router", name: "Router Agent" })],
      scheduledTasks: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          agent_id: routerAgentId,
          source_work_item_id: null,
          created_by_user_id: userId,
          title: "Router optimization",
          instructions: "Prefer local models only after checking reliability.",
          enabled: true,
          schedule: { kind: "every", interval: 6, unit: "hour" },
          timezone: "Etc/UTC",
          next_run_at: "2026-04-25T12:00:00.000Z",
          last_run_at: null,
          last_run_status: null,
          last_error: null,
          delivery: { kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" },
          metadata: { kind: "router_optimization" },
          created_at: "2026-04-25T00:00:00.000Z",
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ],
    });

    await listSetupAuthState("access-token", userId);
    await listSetupAuthState("access-token", userId);

    expect(state.scheduledTasks).toHaveLength(1);
    expect(state.scheduledTasks[0]).toMatchObject({
      instructions: "Prefer local models only after checking reliability.",
      schedule: { kind: "every", interval: 6, unit: "hour" },
      metadata: { kind: "router_optimization" },
    });
  });

  it("seeds learning sidecar scheduled tasks for learning-enabled workspaces", async () => {
    const state = setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      workspaceSettings: [{ workspace_id: workspaceId, learning_enabled: true }],
    });

    await listSetupAuthState("access-token", userId);
    await listSetupAuthState("access-token", userId);

    const createdPlanningAgent = state.agents.find((row) => row.type === "planning");
    const createdManagerAgent = state.agents.find((row) => row.type === "manager");
    const distillationTask = state.scheduledTasks.find((row) => rowKind(row.delivery) === "learning_distillation");
    const operabilityTask = state.scheduledTasks.find(
      (row) => rowKind(row.metadata) === "learning_operability_remediation",
    );

    expect(state.scheduledTasks).toHaveLength(3);
    expect(distillationTask).toMatchObject({
      workspace_id: workspaceId,
      agent_id: createdManagerAgent?.id,
      title: "Nightly learning distillation",
      enabled: true,
      delivery: { kind: "learning_distillation", windowDays: 7 },
      metadata: { kind: "learning_distillation", source: "workspace_learning_sidecar_seed" },
    });
    expect(operabilityTask).toMatchObject({
      workspace_id: workspaceId,
      agent_id: createdPlanningAgent?.id,
      title: "Learning operability remediation",
      enabled: true,
      instructions: expect.stringContaining(
        `/api/workspaces/${workspaceId}/learning/operability-remediation?threshold=2&limit=20`,
      ),
      delivery: {
        kind: "scheduled_agent_message",
        sessionStrategy: "scheduled_task",
        metadata: { kind: "learning_operability_remediation" },
      },
      metadata: { kind: "learning_operability_remediation", source: "workspace_learning_sidecar_seed" },
    });
  });

  it("resolves a configured existing agent before incomplete bootstrapped defaults", async () => {
    const existingAgentId = "77777777-7777-4777-8777-777777777777";
    setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [
        agent({ id: existingAgentId, type: "coding", model_settings: { primary: "openai/gpt-5.2" } }),
        agent({ id: codingAgentId, type: "coding" }),
      ],
      assignments: [
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "coding",
          agent_id: codingAgentId,
          provisioning_source: "platform_bootstrap",
        },
      ],
      credentialAgentIds: [existingAgentId],
      gatewayConfigAgentIds: [existingAgentId],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.defaultAgents.coding.agentId).toBe(codingAgentId);
    expect(authState.defaultAgents.coding.configured).toBe(false);
    expect(authState.managerAgent.agentId).toBeTruthy();
    expect(authState.resolvedAgentId).toBe(existingAgentId);
    expect(authState.onboarding.blocking).toBe(false);
  });

  it("uses the database-generated workspace id to bootstrap one agent per role", async () => {
    const state = setupSupabaseMock();

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.workspaceId).toBe(state.workspaces[0]?.id);
    expect(authState.defaultAgents.planning?.agentId).toBe(state.agents.find((row) => row.type === "planning")?.id);
    expect(authState.defaultAgents.coding?.agentId).toBe(state.agents.find((row) => row.type === "coding")?.id);
    expect(authState.managerAgent.agentId).toBe(state.agents.find((row) => row.type === "manager")?.id);
    expect(new Set(state.workspaces.map((row) => row.id)).size).toBe(1);
    expect(new Set(state.agents.map((row) => row.id)).size).toBe(4);
    expect(state.assignments).toHaveLength(2);
    expect(state.scheduledTasks).toHaveLength(1);
  });

  it("claims existing matching planning, coding, and manager agents instead of creating duplicates", async () => {
    const state = setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [
        agent({ id: planningAgentId, type: "planning" }),
        agent({ id: codingAgentId, type: "coding" }),
        agent({ id: managerAgentId, type: "manager", model_settings: {} }),
        agent({ id: routerAgentId, type: "router" }),
        agent({ id: "99999999-9999-4999-8999-999999999999", type: "legacy-type" }),
      ],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.defaultAgents.planning?.agentId).toBe(planningAgentId);
    expect(authState.defaultAgents.coding?.agentId).toBe(codingAgentId);
    expect(authState.managerAgent.agentId).toBe(managerAgentId);
    expect(authState.managerAgent.missing).toEqual(["credential", "gateway_config", "runner"]);
    expect(authState.agents.find((row) => row.id === routerAgentId)?.type).toBe("router");
    expect(authState.agents.find((row) => row.id === "99999999-9999-4999-8999-999999999999")?.type).toBe("coding");
    expect(state.assignments).toMatchObject([
      { role: "planning", agent_id: planningAgentId, provisioning_source: "claimed_existing" },
      { role: "coding", agent_id: codingAgentId, provisioning_source: "claimed_existing" },
    ]);
    expect(state.assignments).toHaveLength(2);
    expect(state.agents).toHaveLength(5);
    expect(state.scheduledTasks).toHaveLength(1);
  });

  it("creates only the missing default when one assignment already exists", async () => {
    const state = setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [agent({ id: planningAgentId, type: "planning" })],
      assignments: [
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "planning",
          agent_id: planningAgentId,
          provisioning_source: "created_default",
        },
      ],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.defaultAgents.planning?.agentId).toBe(planningAgentId);
    expect(authState.defaultAgents.coding?.agentId).toBe(state.agents.find((row) => row.type === "coding")?.id);
    expect(authState.managerAgent.agentId).toBe(state.agents.find((row) => row.type === "manager")?.id);
    expect(state.agents.map((row) => row.id)).toEqual([
      planningAgentId,
      authState.defaultAgents.coding?.agentId,
      authState.managerAgent.agentId,
      state.agents.find((row) => row.type === "router")?.id,
    ]);
    expect(state.scheduledTasks).toHaveLength(1);
  });

  it("does not resolve the manager agent as the login-selected chat agent", async () => {
    setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [
        agent({
          id: managerAgentId,
          type: "manager",
          model_settings: { primary: "openai/gpt-5.2" },
        }),
      ],
      credentialAgentIds: [managerAgentId],
      gatewayConfigAgentIds: [managerAgentId],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.managerAgent).toMatchObject({
      agentId: managerAgentId,
      configured: true,
      missing: [],
    });
    expect(authState.resolvedAgentId).toBe(authState.defaultAgents.planning.agentId);
  });

  it("prefers the configured planning default as the resolved agent", async () => {
    setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [
        agent({ id: planningAgentId, type: "planning", model_settings: { primary: "openai/gpt-5.2" } }),
        agent({ id: codingAgentId, type: "coding", model_settings: { primary: "openai/gpt-5.2" } }),
      ],
      assignments: [
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "planning",
          agent_id: planningAgentId,
          provisioning_source: "claimed_existing",
        },
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "coding",
          agent_id: codingAgentId,
          provisioning_source: "claimed_existing",
        },
      ],
      credentialAgentIds: [planningAgentId, codingAgentId],
      gatewayConfigAgentIds: [planningAgentId, codingAgentId],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.resolvedAgentId).toBe(planningAgentId);
    expect(authState.defaultAgents.planning).toMatchObject({
      agentId: planningAgentId,
      configured: true,
      missing: [],
    });
    expect(authState.defaultAgents.coding).toMatchObject({
      agentId: codingAgentId,
      configured: true,
      missing: [],
    });
    expect(authState.defaultAgents.coding.executionProfile?.source).toMatchObject({
      legacyGatewayConfigUsed: true,
    });
    expect(authState.onboarding.reasons).toEqual([]);
  });

  it("detects configured agents from scoped provider credentials without agent_id", async () => {
    setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [
        agent({ id: planningAgentId, type: "planning" }),
        agent({ id: codingAgentId, type: "coding", model_settings: { primary: "openai/gpt-5.2" } }),
      ],
      assignments: [
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "planning",
          agent_id: planningAgentId,
          provisioning_source: "claimed_existing",
        },
        {
          workspace_id: workspaceId,
          user_id: userId,
          role: "coding",
          agent_id: codingAgentId,
          provisioning_source: "claimed_existing",
        },
      ],
      scopedCredentials: [
        { id: "credential-id", format: "api_key", provider: "openai", user_id: userId, workspace_id: null },
      ],
      gatewayConfigAgentIds: [codingAgentId],
    });

    const authState = await listSetupAuthState("access-token", userId);

    expect(authState.defaultAgents.coding).toMatchObject({
      agentId: codingAgentId,
      configured: true,
      missing: [],
    });
    expect(authState.onboarding.reasons).not.toContain("coding_missing_credential");
  });

  it("returns setup state for an incomplete default agent without requiring gateway_config", async () => {
    setupSupabaseMock({
      workspaces: [workspace()],
      memberships: [
        { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: "2026-04-25T00:00:00.000Z" },
      ],
      agents: [agent({ id: planningAgentId, type: "planning" })],
    });

    const setup = await getSetup("access-token", userId, planningAgentId);

    expect(setup.agent.id).toBe(planningAgentId);
    expect(setup.agent.type).toBe("planning");
    expect(setup.gatewayConfig).toBeNull();
    expect(setup.gatewayConfigState).toBeNull();
    expect(setup.engine).toBeNull();
    expect(setup.requirements).toMatchObject({
      configured: false,
      missing: ["credential", "model", "gateway_config", "runner"],
      checklist: [
        { step: "agent_exists", status: "pass", label: "Agent created" },
        {
          step: "routing_rule",
          status: "fail",
          label: "Routing rule required",
          action: "configure_routing",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
        {
          step: "provider_configured",
          status: "fail",
          label: "Provider required",
          action: "select_model",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
        {
          step: "model_selected",
          status: "fail",
          label: "Model required",
          action: "select_model",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
        {
          step: "credential_configured",
          status: "fail",
          label: "API key required",
          action: "add_credential",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
        {
          step: "gateway_config",
          status: "fail",
          label: "Gateway config missing",
          action: "configure_runtime",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
        {
          step: "runner_configured",
          status: "fail",
          label: "Runtime not configured",
          action: "configure_runtime",
          actionUrl: `/settings/agents/${planningAgentId}`,
        },
      ],
    });
    expect(setup.requirements.executionProfile?.source).toMatchObject({
      fallbackUsed: true,
    });
  });

  it("summarizes current agent health with a source-layer failure", async () => {
    const healthAgent = agent({
      id: planningAgentId,
      type: "planning",
      model_settings: { primary: "openai/gpt-5.2" },
    });
    const supabaseClient = createMockSupabaseClient({
      agent: [healthAgent],
      gateway_config: [
        {
          id: `${planningAgentId}:gateway-config`,
          scope_type: "agent",
          scope_id: planningAgentId,
          version: 1,
          config_hash: "hash",
          config_json: { runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }] },
          updated_at: "2026-04-25T00:00:00.000Z",
          updated_by: userId,
        },
      ],
      credential: [
        {
          id: "credential-id",
          agent_id: null,
          format: "api_key",
          provider: "openai",
          display_name: "openai",
          key_value: { OPENAI_API_KEY: "sk-test", key_last4: "test" },
          workspace_id: workspaceId,
          user_id: userId,
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ],
      gateway_config_state: [
        {
          scope_type: "agent",
          scope_id: planningAgentId,
          sync_status: "failed",
          sync_error: "gateway config rejected",
          synced_at: "2026-04-25T00:02:00.000Z",
          last_applied_hash: null,
          last_applied_version: null,
          last_apply_status: null,
          last_apply_error: null,
          last_apply_at: null,
          broker_instance_id: null,
        },
      ],
      engine_instance: [
        {
          instance_id: "engine-id",
          agent_id: planningAgentId,
          workspace_id: workspaceId,
          host: "127.0.0.1",
          port: 4100,
          role: "unified",
          status: "running",
          started_at: "2026-04-25T00:00:00.000Z",
          last_health_at: "2026-04-25T00:03:00.000Z",
          updated_at: "2026-04-25T00:03:00.000Z",
          ws_connection_id: null,
        },
      ],
      broker_run: [],
      broker_task: [],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(supabaseClient as never);
    vi.mocked(getSupabaseForAccessToken).mockReturnValue(supabaseClient as never);
    vi.mocked(getUserScopedSupabase).mockReturnValue(supabaseClient as never);

    const health = await getAgentHealth("access-token", userId, planningAgentId, {
      getHealth: async () => ({ ok: true, service: "launcher" }),
    } as Parameters<typeof getAgentHealth>[3]);

    expect(health.status).toBe("degraded");
    expect(health.config.configured).toBe(true);
    expect(health.launcher.reachable).toBe(true);
    expect(health.runtime.lastHeartbeatAt).toBe("2026-04-25T00:03:00.000Z");
    expect(health.lastFailure).toMatchObject({
      sourceLayer: "gateway",
      code: "gateway_sync_failed",
      message: "gateway config rejected",
    });
  });

  it("does not degrade health for benign run terminal reasons", async () => {
    const healthAgent = agent({
      id: planningAgentId,
      type: "planning",
      model_settings: { primary: "openai/gpt-5.2" },
    });
    const supabaseClient = createMockSupabaseClient({
      agent: [healthAgent],
      gateway_config: [
        {
          id: `${planningAgentId}:gateway-config`,
          scope_type: "agent",
          scope_id: planningAgentId,
          version: 1,
          config_hash: "hash",
          config_json: { runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }] },
          updated_at: "2026-04-25T00:00:00.000Z",
          updated_by: userId,
        },
      ],
      credential: [
        {
          id: "credential-id",
          agent_id: null,
          format: "api_key",
          provider: "openai",
          display_name: "openai",
          key_value: { OPENAI_API_KEY: "sk-test", key_last4: "test" },
          workspace_id: workspaceId,
          user_id: userId,
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ],
      gateway_config_state: [
        {
          scope_type: "agent",
          scope_id: planningAgentId,
          sync_status: "synced",
          sync_error: null,
          synced_at: "2026-04-25T00:02:00.000Z",
          last_applied_hash: "hash",
          last_applied_version: 1,
          last_apply_status: "applied",
          last_apply_error: null,
          last_apply_at: "2026-04-25T00:02:00.000Z",
          broker_instance_id: "engine-id",
        },
      ],
      engine_instance: [
        {
          instance_id: "engine-id",
          agent_id: planningAgentId,
          workspace_id: workspaceId,
          host: "127.0.0.1",
          port: 4100,
          role: "unified",
          status: "running",
          started_at: "2026-04-25T00:00:00.000Z",
          last_health_at: "2026-04-25T00:03:00.000Z",
          updated_at: "2026-04-25T00:03:00.000Z",
          ws_connection_id: null,
        },
      ],
      broker_run: [
        {
          run_id: "run-id",
          agent_id: planningAgentId,
          status: "cancelled",
          error: null,
          terminal_reason: "user_cancelled",
          updated_at: "2026-04-25T00:04:00.000Z",
          completed_at: "2026-04-25T00:04:00.000Z",
        },
      ],
      broker_task: [],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(supabaseClient as never);
    vi.mocked(getSupabaseForAccessToken).mockReturnValue(supabaseClient as never);
    vi.mocked(getUserScopedSupabase).mockReturnValue(supabaseClient as never);

    const health = await getAgentHealth("access-token", userId, planningAgentId, {
      getHealth: async () => ({ ok: true, service: "launcher" }),
    } as Parameters<typeof getAgentHealth>[3]);

    expect(health.status).toBe("healthy");
    expect(health.lastFailure).toBeNull();
  });
});
