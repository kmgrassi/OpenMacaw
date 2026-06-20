import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredAgent } from "../../../../contracts/agents.js";
import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { syncAgentGatewayConfigForExecutionProfile } from "../services/agent-gateway-config-sync.js";
import { ensureDefaultAgentToolsForAgent } from "../services/default-agent-tools.js";
import { resolveExecutionProfile } from "../services/execution-profile-resolver.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { getAgentCredentialReferenceRule, upsertAgentCredentialReferenceRule } from "../repositories/routing-rules.js";
import { ensureStoredAgentDefaultRouting } from "./stored-agents.js";

vi.mock("../services/stored-agent-management.js", () => ({
  createStoredAgentFromApi: vi.fn(),
  deleteStoredAgentFromApi: vi.fn(),
  isStoredAgentRuntimeSelectable: vi.fn(),
  listStoredAgentsFromSupabase: vi.fn(),
  updateStoredAgentFromApi: vi.fn(),
}));

vi.mock("../services/saved-credentials.js", () => ({
  listSavedCredentialsForAgentFromSupabase: vi.fn(),
  listSavedModelProviderCredentialsForWorkspaceFromSupabase: vi.fn(),
  saveInlineCredentialForAgentInSupabase: vi.fn(),
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

vi.mock("../repositories/agents.js", () => ({
  createStoredAgentGatewayConfigVersion: vi.fn(),
  createWorkspaceGatewayConfig: vi.fn(),
  getWorkspaceGatewayConfig: vi.fn(),
  updateStoredAgentGatewayConfig: vi.fn(),
}));

vi.mock("../repositories/credentials.js", () => ({
  getCredentialRowByIdForWorkspace: vi.fn(),
  isValidCredentialAlias: vi.fn(),
  listCredentialAliases: vi.fn(),
  normalizeCredentialAlias: (value: string) => value.trim().toLowerCase(),
  resolveCredentialAlias: vi.fn(),
  upsertCredentialAlias: vi.fn(),
}));

vi.mock("../services/agent-gateway-config-sync.js", () => ({
  syncAgentGatewayConfigForExecutionProfile: vi.fn(),
}));

vi.mock("../services/default-agent-tools.js", () => ({
  ensureDefaultAgentToolsForAgent: vi.fn(),
}));

vi.mock("../services/execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

const agent: StoredAgent = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Coding agent",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  agentType: "coding",
  model: "gpt-5",
  provider: "openai",
  context: null,
  runnerKind: "codex",
  hasCredentials: false,
  isResolved: true,
  planningDestination: null,
  customTarget: null,
};

function resolution(routingRuleId: string | null, missing: ExecutionProfileResolution["missing"] = []) {
  return {
    agent: {
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      role: "coding",
    },
    profile: routingRuleId
      ? {
          agentId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          role: "coding",
          runnerKind: "codex",
          provider: "openai",
          model: "gpt-5",
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
    missing,
    source: {
      routingRuleId,
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  } satisfies ExecutionProfileResolution;
}

describe("stored agent default routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([agent]);
    vi.mocked(ensureDefaultAgentToolsForAgent).mockResolvedValue({
      changed: false,
      assignedToolSlugs: [],
      missingToolSlugs: [],
    });
    vi.mocked(syncAgentGatewayConfigForExecutionProfile).mockResolvedValue({
      changed: true,
      resolution: resolution("rule-1"),
    });
  });

  it("repairs an existing named rule when no routing rule matched", async () => {
    const existingRule = {
      id: "rule-1",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      name: "agent:33333333-3333-4333-8333-333333333333:execution-profile",
      runner_kind: "codex" as const,
      provider: "openai",
      model: "gpt-5",
      credential_id: null,
      credential_alias: "default-openai",
      updated_at: "2026-04-29T12:00:00.000Z",
    };
    vi.mocked(resolveExecutionProfile)
      .mockResolvedValueOnce(resolution(null, ["route"]))
      .mockResolvedValueOnce(resolution("rule-1"));
    vi.mocked(getAgentCredentialReferenceRule).mockResolvedValue(existingRule);
    vi.mocked(upsertAgentCredentialReferenceRule).mockResolvedValue(existingRule);

    await expect(
      ensureStoredAgentDefaultRouting({
        agentId: "33333333-3333-4333-8333-333333333333",
        accessToken: "token-1",
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ changed: true, resolution: { source: { routingRuleId: "rule-1" } } });

    expect(upsertAgentCredentialReferenceRule).toHaveBeenCalledWith({
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5",
      credentialRef: { type: "alias", value: "default-openai" },
    });
    expect(syncAgentGatewayConfigForExecutionProfile).toHaveBeenCalledWith({
      accessToken: "token-1",
      userId: "user-1",
      agentId: "33333333-3333-4333-8333-333333333333",
    });
    expect(ensureDefaultAgentToolsForAgent).toHaveBeenCalledWith({
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      agentType: "coding",
      toolProfile: "coding",
      runnerKind: undefined,
      userId: "user-1",
    });
  });

  it("repairs default tool assignments even when routing is already configured", async () => {
    vi.mocked(resolveExecutionProfile).mockResolvedValueOnce(resolution("rule-1"));
    vi.mocked(ensureDefaultAgentToolsForAgent).mockResolvedValueOnce({
      changed: true,
      assignedToolSlugs: ["repo.read_file"],
      missingToolSlugs: [],
    });

    await expect(
      ensureStoredAgentDefaultRouting({
        agentId: "33333333-3333-4333-8333-333333333333",
        accessToken: "token-1",
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ changed: true, resolution: { source: { routingRuleId: "rule-1" } } });

    expect(upsertAgentCredentialReferenceRule).not.toHaveBeenCalled();
    expect(syncAgentGatewayConfigForExecutionProfile).not.toHaveBeenCalled();
    expect(ensureDefaultAgentToolsForAgent).toHaveBeenCalledWith({
      agentId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      agentType: "coding",
      toolProfile: "coding",
      runnerKind: "codex",
      userId: "user-1",
    });
  });
});
