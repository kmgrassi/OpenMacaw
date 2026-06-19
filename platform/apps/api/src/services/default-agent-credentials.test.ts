import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateManagerAgentCredentials,
  applyDefaultAgentCredentials,
  configureSetupAgentCredentials,
  listSetupAuthState,
} from "./setup.js";
import { getServiceRoleSupabase, getSupabaseForAccessToken, getUserScopedSupabase } from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { DEFAULT_MANAGER_TOOL_SLUGS } from "./tool-bundles.js";

vi.mock("../supabase-client.js", () => ({
  executeLoggedSupabaseRows: vi.fn(
    async (_options: unknown, query: PromiseLike<{ data: unknown[]; error: unknown }>) => {
      const result = await query;
      if (result.error) throw result.error;
      return result.data;
    },
  ),
  executeSupabaseRows: vi.fn(async (_context: string, query: PromiseLike<{ data: unknown[]; error: unknown }>) => {
    const result = await query;
    if (result.error) throw result.error;
    return result.data;
  }),
  getServiceRoleSupabase: vi.fn(),
  getSupabaseForAccessToken: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "33333333-3333-4333-8333-333333333333";
const codingAgentId = "44444444-4444-4444-8444-444444444444";
const foreignAgentId = "55555555-5555-4555-8555-555555555555";
const managerAgentId = "66666666-6666-4666-8666-666666666666";
const managerTemplateId = "77777777-7777-4777-8777-777777777777";

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
    agent_tool_grant: [] as Array<Record<string, unknown>>,
  };
}

function setupMockDatabase() {
  const db = {
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        owner_user_id: userId,
        created_at: "2026-04-25T00:00:00.000Z",
      },
    ],
    workspace_members: [
      {
        workspace_id: workspaceId,
        user_id: userId,
        role: "owner",
        created_at: "2026-04-25T00:00:00.000Z",
      },
    ],
    agent_default_assignment: [
      {
        workspace_id: workspaceId,
        user_id: userId,
        role: "planning",
        agent_id: planningAgentId,
        provisioning_source: "platform_bootstrap",
        created_at: "2026-04-25T00:00:00.000Z",
        updated_at: "2026-04-25T00:00:00.000Z",
      },
      {
        workspace_id: workspaceId,
        user_id: userId,
        role: "coding",
        agent_id: codingAgentId,
        provisioning_source: "platform_bootstrap",
        created_at: "2026-04-25T00:00:00.000Z",
        updated_at: "2026-04-25T00:00:00.000Z",
      },
    ],
    agent: [
      {
        id: planningAgentId,
        workspace_id: workspaceId,
        name: "Planning Agent",
        status: "active",
        type: "planning",
        model_settings: {},
        tool_policy: {},
        created_by_user_id: userId,
        updated_at: "2026-04-25T00:00:00.000Z",
      },
      {
        id: codingAgentId,
        workspace_id: workspaceId,
        name: "Coding Agent",
        status: "active",
        type: "coding",
        model_settings: {},
        tool_policy: {},
        created_by_user_id: userId,
        updated_at: "2026-04-25T00:00:00.000Z",
      },
    ],
    credential: [] as Array<Record<string, unknown>>,
    credential_alias: [] as Array<Record<string, unknown>>,
    routing_rule: [] as Array<Record<string, unknown>>,
    routing_rule_match: [] as Array<Record<string, unknown>>,
    gateway_config: [] as Array<Record<string, unknown>>,
    gateway_config_versions: [] as Array<Record<string, unknown>>,
    ...managerToolCatalog(),
  };

  const supabaseClient = createMockSupabaseClient(db);
  vi.mocked(getServiceRoleSupabase).mockReturnValue(supabaseClient as never);
  vi.mocked(getSupabaseForAccessToken).mockReturnValue(supabaseClient as never);
  vi.mocked(getUserScopedSupabase).mockReturnValue(supabaseClient as never);

  return db;
}

describe("applyDefaultAgentCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies one submitted key to both default agents", async () => {
    const db = setupMockDatabase();

    const state = await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "openai",
      label: "OpenAI API Key",
      secret: "sk-test-secret",
      agentIds: [planningAgentId, codingAgentId],
    });

    expect(db.credential).toHaveLength(2);
    expect(db.gateway_config).toHaveLength(2);
    expect(db.gateway_config_versions).toHaveLength(2);
    expect(state.defaultAgents.planning?.configured).toBe(true);
    expect(state.defaultAgents.coding?.configured).toBe(true);
    expect(state.onboarding.required).toBe(false);
    expect(db.agent.find((agent) => agent.id === planningAgentId)?.model_settings).toEqual({
      primary: "openai/gpt-5.2",
    });
    expect(db.agent.find((agent) => agent.id === codingAgentId)?.model_settings).toEqual({
      primary: "openai/gpt-5.1-codex",
    });
    expect(db.agent.find((agent) => agent.id === planningAgentId)?.tool_policy).toMatchObject({
      planning: { destination: "database" },
    });
    expect(db.agent.find((agent) => agent.id === codingAgentId)?.tool_policy).toMatchObject({
      coding: {
        tools: expect.arrayContaining(["repo.read_file", "shell.exec", "apply_patch"]),
        execution_kinds: ["filesystem", "shell"],
      },
    });
    expect(db.gateway_config.map((row) => row.config_json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runners: [expect.objectContaining({ kind: "planner", model: "openai/gpt-5.2" })],
        }),
        expect.objectContaining({
          runners: [expect.objectContaining({ kind: "codex", model: "openai/gpt-5.1-codex" })],
        }),
      ]),
    );
  });

  it("wires a routing_rule per agent pointing at the new credential", async () => {
    // Without this, the per-agent credential row exists but the runtime
    // looks up `routing_rule` to find which credential to use, so the
    // dashboard reports "no credential reference" and gets stuck in a
    // start-loop. See PR fixing onboarding cred → routing-rule binding.
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test-secret",
      agentIds: [planningAgentId, codingAgentId, managerAgentId],
    });

    expect(db.routing_rule).toHaveLength(3);
    // routing_rule rows don't carry agent_id directly; the linkage is
    // encoded in the rule's name (`agent:<agentId>:execution-profile`)
    // and in routing_rule_match rows. Index by name to verify each
    // agent got its own rule.
    const ruleByAgent = new Map(
      db.routing_rule.map((rule) => {
        const match = String(rule.name ?? "").match(/^agent:([^:]+):/);
        return [match?.[1] ?? "", rule] as const;
      }),
    );
    const credentialByAgent = new Map(db.credential.map((row) => [row.agent_id, row]));

    for (const agentId of [planningAgentId, codingAgentId, managerAgentId]) {
      const rule = ruleByAgent.get(agentId);
      const credential = credentialByAgent.get(agentId);
      expect(rule, `expected routing_rule for agent ${agentId}`).toBeDefined();
      expect(credential, `expected credential for agent ${agentId}`).toBeDefined();
      expect(rule).toMatchObject({
        workspace_id: workspaceId,
        provider: "openai",
        credential_id: credential?.id,
        credential_alias: null,
        enabled: true,
      });
    }

    // runner_kind must match what writeGatewayConfigForDefaultAgent
    // writes (onboardingAgentDefaults: planning → planner, coding →
    // codex, manager → llm_tool_runner). resolveExecutionProfile
    // prefers the routing_rule, so any mismatch silently moves the
    // agent onto the wrong runner.
    expect(ruleByAgent.get(planningAgentId)?.runner_kind).toBe("planner");
    expect(ruleByAgent.get(codingAgentId)?.runner_kind).toBe("codex");
    expect(ruleByAgent.get(managerAgentId)?.runner_kind).toBe("llm_tool_runner");
  });

  it("applies one submitted key to planning, coding, and manager agents", async () => {
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    const state = await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test-secret",
      agentIds: [planningAgentId, codingAgentId, managerAgentId],
    });

    expect(db.credential).toHaveLength(3);
    expect(db.gateway_config).toHaveLength(3);
    expect(state.defaultAgents.planning?.configured).toBe(true);
    expect(state.defaultAgents.coding?.configured).toBe(true);
    expect(state.managerAgent.configured).toBe(true);
    expect(state.resolvedAgentId).toBe(planningAgentId);
    expect(db.gateway_config.find((row) => row.scope_id === managerAgentId)?.config_json).toMatchObject({
      runners: {
        manager: {
          kind: "llm_tool_runner",
          provider: "openai",
          model: "openai/gpt-5.2",
        },
      },
    });
  });

  it("can apply credentials to only the planning default", async () => {
    const db = setupMockDatabase();

    const state = await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "anthropic",
      secret: "sk-ant-test",
      agentIds: [planningAgentId],
    });

    expect(db.credential).toHaveLength(1);
    expect(db.gateway_config).toHaveLength(1);
    expect(db.credential[0]).toMatchObject({
      format: "api_key",
      provider: "anthropic",
    });
    expect(db.credential[0]?.key_value).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(db.agent.find((agent) => agent.id === planningAgentId)?.model_settings).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
    expect(state.defaultAgents.planning?.configured).toBe(true);
    expect(state.defaultAgents.coding?.configured).toBe(false);
    expect(state.onboarding.reasons).toContain("coding_missing_credential");
  });

  it("configures manager with orchestration defaults when included in onboarding targets", async () => {
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    const state = await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "openai",
      secret: "sk-test-secret",
      agentIds: [planningAgentId, codingAgentId, managerAgentId],
    });

    expect(db.credential).toHaveLength(3);
    expect(db.gateway_config).toHaveLength(3);
    expect(db.agent.find((agent) => agent.id === managerAgentId)?.model_settings).toEqual({
      primary: "openai/gpt-5.2",
    });
    expect(db.agent.find((agent) => agent.id === managerAgentId)?.tool_policy).toMatchObject({
      manager: {
        tools: DEFAULT_MANAGER_TOOL_SLUGS,
      },
    });
    expect(
      db.agent_tool_grant
        .filter((grant) => grant.agent_id === managerAgentId)
        .map((grant) => grant.tool_id)
        .sort(),
    ).toEqual(DEFAULT_MANAGER_TOOL_SLUGS.map(toolId).sort());
    expect(db.gateway_config.find((row) => row.scope_id === managerAgentId)?.config_json).toMatchObject({
      runners: {
        manager: {
          kind: "llm_tool_runner",
          provider: "openai",
          model: "openai/gpt-5.2",
        },
      },
    });
    expect(state.managerAgent.configured).toBe(true);
  });

  it("rejects unsupported providers when the manager is included in onboarding targets", async () => {
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    await expect(
      applyDefaultAgentCredentials("token", userId, {
        workspaceId,
        provider: "anthropic",
        secret: "sk-ant-test",
        agentIds: [planningAgentId, codingAgentId, managerAgentId],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "manager_provider_not_supported",
    });

    expect(db.credential).toHaveLength(0);
    expect(db.gateway_config).toHaveLength(0);
    expect(db.agent.find((agent) => agent.id === managerAgentId)?.model_settings).toEqual({});
    expect(db.agent.find((agent) => agent.id === managerAgentId)?.tool_policy).toEqual({});
  });

  it("configures a selected incomplete agent without requiring a default assignment", async () => {
    const db = setupMockDatabase();
    const agentId = "66666666-6666-4666-8666-666666666666";
    db.agent.push({
      id: agentId,
      workspace_id: workspaceId,
      name: "Standalone Planning Agent",
      status: "active",
      type: "planning",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    const setup = await configureSetupAgentCredentials("token", userId, {
      agentId,
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test-secret",
    });

    expect(db.credential).toHaveLength(1);
    expect(db.gateway_config).toHaveLength(1);
    expect(setup.agent.id).toBe(agentId);
    expect(setup.requirements).toMatchObject({ configured: true, missing: [] });
  });

  it("preserves existing selected-agent gateway settings while repairing credentials", async () => {
    const db = setupMockDatabase();
    const agentId = "77777777-7777-4777-8777-777777777777";
    db.agent.push({
      id: agentId,
      workspace_id: workspaceId,
      name: "Existing Coding Agent",
      status: "active",
      type: "coding",
      model_settings: { primary: "openai/gpt-5.1-codex" },
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });
    db.gateway_config.push({
      id: "gateway-existing",
      scope_type: "agent",
      scope_id: agentId,
      version: 3,
      config_hash: "existing-hash",
      config_json: {
        tracker: { kind: "github", repository_url: "https://github.com/kmgrassi/example" },
        workflow_template: { id: "repo-maintenance", repository_url: "https://github.com/kmgrassi/example" },
        max_concurrent_agents: 4,
        runners: [{ kind: "codex", model: "openai/gpt-5.1-codex", provider: "openai", effort: "high" }],
      },
      updated_by: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    await configureSetupAgentCredentials("token", userId, {
      agentId,
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test-secret",
    });

    expect(db.gateway_config).toHaveLength(1);
    expect(db.gateway_config[0]?.config_json).toMatchObject({
      tracker: { kind: "github", repository_url: "https://github.com/kmgrassi/example" },
      workflow_template: { id: "repo-maintenance", repository_url: "https://github.com/kmgrassi/example" },
      max_concurrent_agents: 4,
      runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai", effort: "high" }],
    });
    expect(db.gateway_config[0]?.version).toBe(4);
  });

  it("rejects agents that are not assigned defaults for the user workspace", async () => {
    setupMockDatabase();

    await expect(
      applyDefaultAgentCredentials("token", userId, {
        workspaceId,
        provider: "openai",
        model: "openai/gpt-5.2",
        keyName: "OPENAI_API_KEY",
        secret: "sk-test-secret",
        agentIds: [foreignAgentId],
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "default_agent_forbidden",
    });
  });

  it("bootstraps missing workspace and default assignments with upserts", async () => {
    const db = setupMockDatabase();
    db.workspaces.length = 0;
    db.workspace_members.length = 0;
    db.agent_default_assignment.length = 0;
    db.agent.length = 0;

    const state = await listSetupAuthState("token", userId);

    expect(db.workspaces).toEqual([expect.objectContaining({ owner_user_id: userId })]);
    expect(db.workspace_members).toEqual([expect.objectContaining({ user_id: userId, role: "owner" })]);
    expect(db.agent_default_assignment).toEqual([
      expect.objectContaining({ user_id: userId, role: "planning" }),
      expect.objectContaining({ user_id: userId, role: "coding" }),
    ]);
    expect(state.defaultAgents.planning.agentId).toBeTruthy();
    expect(state.defaultAgents.coding.agentId).toBeTruthy();
    expect(state.managerAgent.agentId).toBeTruthy();
    expect(state.managerAgent.missing).toContain("credential");
    expect(db.agent).toContainEqual(expect.objectContaining({ type: "manager", name: "Manager Agent" }));
    expect(db.agent_default_assignment).toEqual([
      expect.objectContaining({ user_id: userId, role: "planning" }),
      expect.objectContaining({ user_id: userId, role: "coding" }),
    ]);
  });

  it("stores a pasted workspace credential and attaches it to the manager routing rule", async () => {
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    const state = await activateManagerAgentCredentials("token", userId, {
      workspaceId,
      agentId: managerAgentId,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.5",
      runnerKind: "llm_tool_runner",
      newCredential: {
        apiKey: "sk-ant-test-secret",
        label: "Manager Anthropic",
      },
      cadenceMs: 60_000,
    });

    expect(db.credential).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        format: "api_key",
        provider: "anthropic",
        key_value: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-test-secret",
          label: "Manager Anthropic",
        }),
      }),
    ]);
    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        name: `agent:${managerAgentId}:execution-profile`,
        runner_kind: "llm_tool_runner",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4.5",
        credential_id: db.credential[0]?.id,
      }),
    ]);
    expect(db.routing_rule_match).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        kind: "agent_id",
        key: "id",
        value: managerAgentId,
      }),
    ]);
    expect(db.gateway_config[0]?.config_json).toMatchObject({
      runners: {
        manager: {
          kind: "llm_tool_runner",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4.5",
          cadence_ms: 60_000,
        },
      },
    });
    expect(state.managerAgent).toMatchObject({
      agentId: managerAgentId,
      configured: true,
      missing: [],
      executionProfile: {
        profile: {
          agentId: managerAgentId,
          runnerKind: "llm_tool_runner",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4.5",
          credentialRef: { type: "credential_id", value: db.credential[0]?.id },
        },
      },
    });
  });

  it("writes the resolved execution_profile (with credential_id) into config_json", async () => {
    // The runtime's launcher reads `gateway_config.config_json.execution_profile`
    // to find the credential id; without this block it falls back to the legacy
    // gateway-config-runner path and cannot resolve an api_key. See
    // apps/orchestrator/lib/symphony_elixir/execution_profile.ex `explicit_profile/1`.
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    await applyDefaultAgentCredentials("token", userId, {
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test-secret",
      agentIds: [planningAgentId, codingAgentId, managerAgentId],
    });

    const planningCredential = db.credential.find((row) => row.agent_id === planningAgentId);
    const codingCredential = db.credential.find((row) => row.agent_id === codingAgentId);
    const managerCredential = db.credential.find((row) => row.agent_id === managerAgentId);
    expect(planningCredential?.id).toBeTruthy();
    expect(codingCredential?.id).toBeTruthy();
    expect(managerCredential?.id).toBeTruthy();

    const planningConfig = db.gateway_config.find((row) => row.scope_id === planningAgentId)?.config_json as
      | Record<string, unknown>
      | undefined;
    const codingConfig = db.gateway_config.find((row) => row.scope_id === codingAgentId)?.config_json as
      | Record<string, unknown>
      | undefined;
    const managerConfig = db.gateway_config.find((row) => row.scope_id === managerAgentId)?.config_json as
      | Record<string, unknown>
      | undefined;

    expect(planningConfig?.execution_profile).toMatchObject({
      runner_kind: "planner",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: planningCredential?.id,
    });
    expect(codingConfig?.execution_profile).toMatchObject({
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: codingCredential?.id,
    });
    expect(managerConfig?.execution_profile).toMatchObject({
      runner_kind: "llm_tool_runner",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: managerCredential?.id,
    });

    // The secret must never be persisted into gateway_config.
    for (const config of [planningConfig, codingConfig, managerConfig]) {
      const block = config?.execution_profile as Record<string, unknown> | undefined;
      expect(block).toBeDefined();
      expect(block).not.toHaveProperty("api_key");
      expect(block).not.toHaveProperty("key_value");
      expect(block).not.toHaveProperty("secret");
    }
  });

  it("reuses an existing workspace credential for manager activation", async () => {
    const db = setupMockDatabase();
    db.agent.push({
      id: managerAgentId,
      workspace_id: workspaceId,
      name: "Manager Agent",
      status: "active",
      type: "manager",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-04-25T00:00:00.000Z",
    });
    db.credential.push({
      id: "credential-existing",
      agent_id: null,
      workspace_id: workspaceId,
      user_id: userId,
      format: "api_key",
      provider: "openai",
      display_name: "openai",
      key_value: {
        OPENAI_API_KEY: "sk-existing",
        key_last4: "ting",
      },
      created_at: "2026-04-25T00:00:00.000Z",
      updated_at: "2026-04-25T00:00:00.000Z",
    });

    const state = await activateManagerAgentCredentials("token", userId, {
      workspaceId,
      agentId: managerAgentId,
      provider: "openai",
      model: "openai/gpt-5.2",
      runnerKind: "llm_tool_runner",
      credentialRef: { type: "credential_id", value: "credential-existing" },
    });

    expect(db.credential).toHaveLength(1);
    expect(db.routing_rule[0]).toMatchObject({
      credential_id: "credential-existing",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
    expect(state.managerAgent.configured).toBe(true);
    expect(state.managerAgent.missing).toEqual([]);
  });
});
