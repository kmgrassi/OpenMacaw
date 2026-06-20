import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredAgent } from "../../../../contracts/agents.js";
import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { ensureGatewayConfigExists } from "./ensure-gateway-config.js";
import {
  ensureStoredAgentDefaultRouting,
  resolveLocalModelRoutingRule,
  resolveRoutingRuleModelForProvider,
  syncCredentialIntoRoutingRuleForAgent,
  syncModelIntoRoutingRuleForAgent,
} from "./stored-agent-routing.js";
import { getAgentCredentialReferenceRule, upsertAgentCredentialReferenceRule } from "../repositories/routing-rules.js";
import { listStoredAgentsFromSupabase } from "./stored-agent-management.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { SCHEDULED_TASK_TOOL_SLUGS } from "./tool-bundles.js";

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: vi.fn(async (_context: string, query: PromiseLike<{ data: unknown[]; error: unknown }>) => {
    const result = await query;
    if (result.error) throw result.error;
    return result.data;
  }),
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

vi.mock("../services/stored-agent-management.js", () => ({
  listStoredAgentsFromSupabase: vi.fn(),
}));

vi.mock("./execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("../repositories/routing-rules.js", () => ({
  credentialRefFromRoutingRule: (rule: { credential_alias?: string | null; credential_id?: string | null } | null) => {
    if (rule?.credential_alias) return { type: "alias", value: rule.credential_alias };
    if (rule?.credential_id) return { type: "credential_id", value: rule.credential_id };
    return null;
  },
  getAgentCredentialReferenceRule: vi.fn(),
  getRoutingRuleLocalEndpointUrl: vi.fn(async () => null),
  upsertAgentCredentialReferenceRule: vi.fn(),
}));

vi.mock("./ensure-gateway-config.js", () => ({
  ensureGatewayConfigExists: vi.fn(),
}));

vi.mock("../repositories/agents.js", () => ({
  createStoredAgentGatewayConfigVersion: vi.fn(),
  createWorkspaceGatewayConfig: vi.fn(),
  getWorkspaceGatewayConfig: vi.fn(async () => null),
  updateStoredAgentGatewayConfig: vi.fn(),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";

function defaultCodingAgent(): StoredAgent {
  return {
    id: agentId,
    name: "Coding agent",
    workspaceId,
    agentType: "coding",
    model: "openai/gpt-5.2",
    provider: "openai",
    context: null,
    runnerKind: "codex",
    hasCredentials: false,
    isResolved: true,
    planningDestination: null,
    customTarget: null,
  };
}

function executionProfile(routingRuleId: string | null): ExecutionProfileResolution {
  return {
    agent: {
      agentId,
      workspaceId,
      role: "coding",
    },
    profile: routingRuleId
      ? {
          agentId,
          workspaceId,
          role: "coding",
          runnerKind: "codex",
          provider: "openai",
          model: "openai/gpt-5.2",
          credentialRef: null,
          fallbacks: [],
          modelTierFloor: "any",
          toolProfile: "coding",
          capabilities: {
            streaming: true,
            toolCalls: true,
            workspaceWrite: true,
            structuredOutput: true,
            interrupt: true,
          },
        }
      : null,
    missing: [],
    source: {
      routingRuleId,
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

describe("ensureStoredAgentDefaultRouting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("repairs default tool grants without requiring a unique conflict constraint", async () => {
    const toolSlugs = [
      "repo.read_file",
      "repo.list",
      "repo.search",
      "repo.read_symbols",
      "plan.create",
      "task.create",
      "task.update",
      "plans.read",
      "plan.read",
      "plan.delete",
      ...SCHEDULED_TASK_TOOL_SLUGS,
    ];
    const db = {
      tool: toolSlugs.map((slug) => ({
        id: slug,
        workspace_id: null,
        slug,
        enabled: true,
      })),
      tool_policy_template: [
        {
          id: "template-coding",
          workspace_id: null,
          slug: "coding",
          enabled: true,
        },
      ],
      tool_policy_template_tool: toolSlugs.map((slug) => ({
        template_id: "template-coding",
        tool_id: slug,
      })),
      agent_tool: [] as Array<Record<string, unknown>>,
      agent_tool_grant: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([defaultCodingAgent()]);
    vi.mocked(resolveExecutionProfile).mockResolvedValueOnce(executionProfile("rule-1"));

    await expect(
      ensureStoredAgentDefaultRouting({
        agentId,
        accessToken: "token-1",
        userId,
      }),
    ).resolves.toMatchObject({
      changed: true,
      agent: { id: agentId, workspaceId },
      resolution: { source: { routingRuleId: "rule-1" } },
    });

    expect(db.agent_tool).toHaveLength(0);
    expect(db.agent_tool_grant).toHaveLength(15);
    expect(db.agent_tool_grant.map((row) => row.tool_id).sort()).toEqual([
      "plan.create",
      "plan.delete",
      "plan.read",
      "plans.read",
      "repo.list",
      "repo.read_file",
      "repo.read_symbols",
      "repo.search",
      "scheduled_task.create",
      "scheduled_task.delete",
      "scheduled_task.list",
      "scheduled_task.read",
      "scheduled_task.update",
      "task.create",
      "task.update",
    ]);
    expect(db.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: agentId,
          workspace_id: workspaceId,
          mode: "include",
          source: "template",
          source_tool_template_id: "template-coding",
          created_by_user_id: userId,
        }),
      ]),
    );
    expect(getAgentCredentialReferenceRule).not.toHaveBeenCalled();
    expect(upsertAgentCredentialReferenceRule).not.toHaveBeenCalled();
    expect(ensureGatewayConfigExists).not.toHaveBeenCalled();
  });

  it("falls back to an explicit local endpoint url when stored endpoint metadata is missing", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen",
          runner_kind: "local_relay",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
          updated_at: "2026-05-05T00:00:00.000Z",
        },
      ],
      routing_rule_match: [
        {
          id: "match-machine-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    await expect(
      resolveLocalModelRoutingRule({
        workspaceId,
        localModelId: "local-rule-1",
        localEndpointUrl: "http://127.0.0.1:11434/v1",
      }),
    ).resolves.toMatchObject({
      id: "local-rule-1",
      model: "qwen2.5-coder:latest",
      provider: "openai_compatible",
      endpointUrl: "http://127.0.0.1:11434/v1",
    });
  });

  it("returns a null endpoint when the local model has no endpoint metadata and no fallback url", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-2",
          workspace_id: workspaceId,
          name: "local:qwen",
          runner_kind: "local_relay",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
          updated_at: "2026-05-05T00:00:00.000Z",
        },
      ],
      routing_rule_match: [
        {
          id: "match-machine-2",
          workspace_id: workspaceId,
          rule_id: "local-rule-2",
          kind: "local_machine",
          key: "id",
          value: "machine-2",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    await expect(
      resolveLocalModelRoutingRule({
        workspaceId,
        localModelId: "local-rule-2",
        localEndpointUrl: null,
      }),
    ).resolves.toMatchObject({
      id: "local-rule-2",
      model: "qwen2.5-coder:latest",
      provider: "openai_compatible",
      endpointUrl: null,
    });
  });
});

describe("syncCredentialIntoRoutingRuleForAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("upserts a routing rule pointing at the saved credential for a coding agent", async () => {
    vi.mocked(upsertAgentCredentialReferenceRule).mockResolvedValue({
      id: "rule-1",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "cred-new",
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    });

    const rule = await syncCredentialIntoRoutingRuleForAgent({
      agent: {
        id: agentId,
        workspaceId,
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
      },
      credentialId: "cred-new",
      provider: "openai",
      userId,
    });

    expect(upsertAgentCredentialReferenceRule).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      runnerKind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credentialRef: { type: "credential_id", value: "cred-new" },
    });
    expect(rule.id).toBe("rule-1");
  });

  it("uses the manager runner_kind for manager agents", async () => {
    vi.mocked(upsertAgentCredentialReferenceRule).mockResolvedValue({
      id: "rule-mgr",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "llm_tool_runner",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "cred-mgr",
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    });

    // The manager branch additionally writes the workspace-scoped
    // gateway_config; stub the create path so the assertion below
    // covers the routing-rule call.
    const agentsRepo = await import("../repositories/agents.js");
    vi.mocked(agentsRepo.createWorkspaceGatewayConfig).mockResolvedValue({
      id: "gw-config-1",
      scope_id: workspaceId,
      version: 1,
      config_hash: "h",
      config_json: {},
    });

    await syncCredentialIntoRoutingRuleForAgent({
      agent: {
        id: agentId,
        workspaceId,
        agentType: "manager",
        model: "openai/gpt-5.2",
        provider: "openai",
      },
      credentialId: "cred-mgr",
      provider: "openai",
      userId,
    });

    expect(upsertAgentCredentialReferenceRule).toHaveBeenCalledWith(
      expect.objectContaining({ runnerKind: "llm_tool_runner" }),
    );
  });

  it("overwrites an existing rule's credential_id when a new credential is saved", async () => {
    // Simulating the bug the user hit: routing_rule existed pointing at
    // an old credential; saving a new credential should now redirect
    // the rule to the new credential, not leave the old one in place.
    vi.mocked(upsertAgentCredentialReferenceRule).mockResolvedValue({
      id: "rule-existing",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "cred-fresh",
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    });

    const rule = await syncCredentialIntoRoutingRuleForAgent({
      agent: {
        id: agentId,
        workspaceId,
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
      },
      credentialId: "cred-fresh",
      provider: "openai",
      userId,
    });

    expect(rule.credential_id).toBe("cred-fresh");
  });

  it("rewrites the rule's model to a provider default when the agent's current model is incompatible", async () => {
    // User chats with a coding agent on local_model_coding ("qwen3-coder:30b"),
    // then connects ChatGPT (provider=openai_codex). The routing rule must
    // not keep model=qwen3-coder:30b — that combo would never resolve.
    vi.mocked(upsertAgentCredentialReferenceRule).mockImplementation(async (input) => ({
      id: "rule-1",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex" as const,
      provider: input.provider,
      model: input.model,
      credential_id:
        input.credentialRef && input.credentialRef.type === "credential_id" ? input.credentialRef.value : null,
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    }));

    await syncCredentialIntoRoutingRuleForAgent({
      agent: {
        id: agentId,
        workspaceId,
        agentType: "coding",
        model: "qwen3-coder:30b",
        provider: "local",
      },
      credentialId: "cred-oauth",
      provider: "openai_codex",
      userId,
    });

    const call = vi.mocked(upsertAgentCredentialReferenceRule).mock.calls[0]?.[0];
    expect(call?.provider).toBe("openai_codex");
    // The model has to belong to openai_codex; the catalog default is the
    // first openai_codex entry. We assert the prefix rather than the exact
    // id so a future catalog change doesn't break the test.
    expect(call?.model?.startsWith("openai_codex/")).toBe(true);
  });

  it("preserves the agent's model when it already matches the target provider", async () => {
    vi.mocked(upsertAgentCredentialReferenceRule).mockImplementation(async (input) => ({
      id: "rule-1",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex" as const,
      provider: input.provider,
      model: input.model,
      credential_id:
        input.credentialRef && input.credentialRef.type === "credential_id" ? input.credentialRef.value : null,
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    }));

    await syncCredentialIntoRoutingRuleForAgent({
      agent: {
        id: agentId,
        workspaceId,
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
      },
      credentialId: "cred-2",
      provider: "openai",
      userId,
    });

    const call = vi.mocked(upsertAgentCredentialReferenceRule).mock.calls[0]?.[0];
    expect(call?.model).toBe("openai/gpt-5.2");
  });
});

describe("resolveRoutingRuleModelForProvider", () => {
  it("keeps the current model when it matches the provider prefix", () => {
    expect(resolveRoutingRuleModelForProvider("openai/gpt-5.2", "openai")).toBe("openai/gpt-5.2");
  });

  it("returns a catalog default when the current model is for a different provider", () => {
    const result = resolveRoutingRuleModelForProvider("qwen3-coder:30b", "openai_codex");
    expect(result?.startsWith("openai_codex/")).toBe(true);
  });

  it("returns the current model when the provider has no catalog entry", () => {
    expect(resolveRoutingRuleModelForProvider("custom/foo", "unknown_provider")).toBe("custom/foo");
  });
});

describe("syncModelIntoRoutingRuleForAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no existing routing rule exists", async () => {
    vi.mocked(getAgentCredentialReferenceRule).mockResolvedValue(null);

    const rule = await syncModelIntoRoutingRuleForAgent({
      agent: { id: agentId, workspaceId, agentType: "coding" },
      newModel: "openai/gpt-5.5",
      userId,
    });

    expect(rule).toBeNull();
    expect(upsertAgentCredentialReferenceRule).not.toHaveBeenCalled();
  });

  it("keeps the existing credential reference when updating the model", async () => {
    vi.mocked(getAgentCredentialReferenceRule).mockResolvedValue({
      id: "rule-existing",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "cred-keep",
      credential_alias: null,
      updated_at: "2026-05-13T11:00:00.000Z",
    });
    vi.mocked(upsertAgentCredentialReferenceRule).mockImplementation(async (input) => ({
      id: "rule-existing",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex" as const,
      provider: input.provider,
      model: input.model,
      credential_id:
        input.credentialRef && input.credentialRef.type === "credential_id" ? input.credentialRef.value : null,
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    }));

    await syncModelIntoRoutingRuleForAgent({
      agent: { id: agentId, workspaceId, agentType: "coding" },
      newModel: "openai/gpt-5.5",
      userId,
    });

    const call = vi.mocked(upsertAgentCredentialReferenceRule).mock.calls[0]?.[0];
    expect(call?.model).toBe("openai/gpt-5.5");
    expect(call?.provider).toBe("openai");
    expect(call?.credentialRef).toEqual({ type: "credential_id", value: "cred-keep" });
  });

  it("rewrites the rule's provider when the new model belongs to a different provider", async () => {
    vi.mocked(getAgentCredentialReferenceRule).mockResolvedValue({
      id: "rule-existing",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credential_id: "cred-keep",
      credential_alias: null,
      updated_at: "2026-05-13T11:00:00.000Z",
    });
    vi.mocked(upsertAgentCredentialReferenceRule).mockImplementation(async (input) => ({
      id: "rule-existing",
      workspace_id: workspaceId,
      name: `agent:${agentId}`,
      runner_kind: "codex" as const,
      provider: input.provider,
      model: input.model,
      credential_id:
        input.credentialRef && input.credentialRef.type === "credential_id" ? input.credentialRef.value : null,
      credential_alias: null,
      updated_at: "2026-05-13T12:00:00.000Z",
    }));

    await syncModelIntoRoutingRuleForAgent({
      agent: { id: agentId, workspaceId, agentType: "coding" },
      newModel: "anthropic/claude-sonnet-4-6",
      userId,
    });

    const call = vi.mocked(upsertAgentCredentialReferenceRule).mock.calls[0]?.[0];
    expect(call?.provider).toBe("anthropic");
    expect(call?.model).toBe("anthropic/claude-sonnet-4-6");
  });
});
