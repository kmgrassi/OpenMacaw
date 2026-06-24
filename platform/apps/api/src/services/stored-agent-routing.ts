import { deriveProviderFromModel } from "../../../../contracts/agent-helpers.js";
import { defaultRunnerKindForAgentType } from "../../../../contracts/agent-runner-defaults.js";
import { defaultModelForProvider, modelMatchesProvider } from "../../../../contracts/model-catalog.js";
import { ApiRouteError } from "../http.js";
import {
  credentialRefFromRoutingRule,
  getAgentCredentialReferenceRule,
  upsertAgentCredentialReferenceRule,
} from "../repositories/routing-rules.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { syncAgentGatewayConfigForExecutionProfile } from "./agent-gateway-config-sync.js";
import { listStoredAgentsFromSupabase } from "./stored-agent-management.js";
import { ensureDefaultAgentToolsForAgent } from "./default-agent-tools.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { toolProfileForAgentType } from "./tool-bundles.js";

/**
 * After saving an inline credential for a stored agent, ensure the
 * agent's `routing_rule` points at it.
 *
 * Without this, planner / coding / custom agents that save a credential
 * via `POST /api/credentials` only get a `credential`
 * row written — no `routing_rule` ever references it. The execution
 * profile resolver then falls back to legacy `gateway_config` lookup
 * (`source.fallbackUsed: true`, `legacyGatewayConfigUsed: true`), which
 * reads `runners[0].credential_id` (or alias) instead of the canonical
 * routing-rule path. PR #415 already does this for managers via the
 * runtime-profile editor; this puts every agent type on the same
 * canonical path.
 */
/**
 * Resolve the model that should land in the routing rule given a target
 * provider. If the agent's existing model is already compatible
 * (e.g., agent.model = "openai/gpt-5.2" and target provider = "openai"),
 * keep it — that preserves user intent across credential swaps within
 * the same provider family. Otherwise the existing model is incompatible
 * (e.g., transitioning from a local model to openai_codex) and we pick
 * the catalog default for the new provider so the routing rule isn't
 * left with `provider=openai_codex, model=qwen3-coder:30b`.
 */
export function resolveRoutingRuleModelForProvider(currentModel: string | null, targetProvider: string): string | null {
  if (currentModel && modelMatchesProvider(currentModel, targetProvider)) {
    return currentModel;
  }
  return defaultModelForProvider(targetProvider) ?? currentModel;
}

type RoutingRuleSyncAgent = {
  id: string;
  workspaceId: string;
  agentType: string | null;
};

type RoutingRuleSyncInput = {
  agent: RoutingRuleSyncAgent;
  provider: string;
  model: string | null;
  credentialRef: ReturnType<typeof credentialRefFromRoutingRule>;
};

async function upsertStoredAgentRoutingRule(input: RoutingRuleSyncInput) {
  return upsertAgentCredentialReferenceRule({
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
    runnerKind: defaultRunnerKindForAgentType(input.agent.agentType),
    provider: input.provider,
    model: input.model,
    credentialRef: input.credentialRef,
  });
}

/**
 * Bring the agent's routing rule into alignment when the agent's model
 * changes (e.g., via `PATCH /api/stored-agents/:id`). Keeps the existing
 * credential reference intact — this is for model-only changes, not
 * credential swaps. The companion `syncCredentialIntoRoutingRuleForAgent`
 * handles the credential-changed case.
 *
 * If the new model implies a different provider than the existing rule's
 * provider, the rule's provider is rewritten too. Runner kind is
 * re-derived from the agent type.
 */
export async function syncModelIntoRoutingRuleForAgent(input: { agent: RoutingRuleSyncAgent; newModel: string }) {
  const existingRule = await getAgentCredentialReferenceRule({
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
  });
  // No existing rule means the agent has no credentials configured yet;
  // saving a credential (or running the runtime-profile editor) will
  // create one. Nothing to sync here.
  if (!existingRule) return null;

  const targetProvider = deriveProviderFromModel(input.newModel) ?? existingRule.provider;
  if (!targetProvider) return existingRule;

  const rule = await upsertStoredAgentRoutingRule({
    agent: input.agent,
    provider: targetProvider,
    model: input.newModel,
    credentialRef: credentialRefFromRoutingRule(existingRule),
  });

  return rule;
}

export async function syncCredentialIntoRoutingRuleForAgent(input: {
  agent: RoutingRuleSyncAgent & {
    model: string | null;
    provider: string | null;
  };
  credentialId: string;
  provider: string;
}) {
  const rule = await upsertStoredAgentRoutingRule({
    agent: input.agent,
    provider: input.provider,
    model: resolveRoutingRuleModelForProvider(input.agent.model, input.provider),
    credentialRef: { type: "credential_id" as const, value: input.credentialId },
  });

  return rule;
}

export async function ensureStoredAgentDefaultRouting(input: { agentId: string; accessToken: string; userId: string }) {
  const agents = await listStoredAgentsFromSupabase({
    accessToken: input.accessToken,
    userId: input.userId,
  });
  const agent = agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const before = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.userId,
    agentId: agent.id,
    skipCredentialCheck: true,
  });

  const routeMissing = !before.source.routingRuleId;
  const gatewayMissing = before.missing.includes("gateway_config");
  if (!agent.workspaceId) {
    throw new ApiRouteError(422, "agent_workspace_required", "Default routing requires an agent workspace", {
      agent_id: agent.id,
      agent_type: agent.agentType,
      missing: ["workspace"],
      execution_profile: before,
    });
  }

  const defaultTools = await ensureDefaultAgentToolsForAgent({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    agentType: agent.agentType,
    toolProfile: before.profile?.toolProfile ?? toolProfileForAgentType(agent.agentType),
    runnerKind: before.profile?.runnerKind,
    userId: input.userId,
  });

  if (!routeMissing && !gatewayMissing) {
    return { agent, changed: defaultTools.changed, resolution: before };
  }

  const model = agent.model?.trim() || null;
  const provider = agent.provider?.trim() || deriveProviderFromModel(model);
  if (!model || !provider) {
    throw new ApiRouteError(422, "agent_model_required", "Default routing requires an agent model", {
      agent_id: agent.id,
      agent_type: agent.agentType,
      missing: [!model ? "model" : null, !provider ? "provider" : null].filter(Boolean),
      execution_profile: before,
    });
  }

  let changed = defaultTools.changed;
  const existingRule = await getAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  });

  if (!existingRule || routeMissing) {
    await upsertStoredAgentRoutingRule({
      agent: {
        id: agent.id,
        workspaceId: agent.workspaceId,
        agentType: agent.agentType,
      },
      provider: existingRule?.provider ?? provider,
      model: existingRule?.model ?? model,
      credentialRef: credentialRefFromRoutingRule(existingRule),
    });
    changed = true;
  }

  const syncResult = await syncAgentGatewayConfigForExecutionProfile({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: agent.id,
  });
  changed ||= syncResult.changed && gatewayMissing;

  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.userId,
    agentId: agent.id,
    skipCredentialCheck: true,
  });

  return { agent, changed, resolution };
}

export async function resolveLocalModelRoutingRule(input: {
  workspaceId: string;
  localModelId: string | null | undefined;
  localEndpointUrl?: string | null | undefined;
}) {
  const localModelId = input.localModelId?.trim();
  if (!localModelId) {
    throw new ApiRouteError(400, "local_model_required", "localModelId is required for local model coding");
  }

  const supabase = getServiceRoleSupabase();
  const { data: rule, error: ruleError } = await supabase
    .from("routing_rule")
    .select("id,model,provider")
    .eq("id", localModelId)
    .eq("workspace_id", input.workspaceId)
    .eq("runner_kind", "local_relay")
    .like("name", "local:%")
    .neq("provider", "openclaw")
    .single();
  if (ruleError || !rule) {
    throw new ApiRouteError(404, "local_model_not_found", "Local model was not found", ruleError);
  }

  const { data: endpointMatches, error: endpointError } = await supabase
    .from("routing_rule_match")
    .select("value")
    .eq("rule_id", localModelId)
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_endpoint")
    .eq("key", "url")
    .limit(1);
  if (endpointError) {
    throw new ApiRouteError(
      502,
      "local_model_endpoint_read_failed",
      "Could not read local model endpoint",
      endpointError,
    );
  }

  const endpointValue = endpointMatches?.[0]?.value;
  const fallbackEndpointUrl = input.localEndpointUrl?.trim() || "";
  const endpointUrl = typeof endpointValue === "string" ? endpointValue.trim() : fallbackEndpointUrl;

  return {
    id: String(rule.id),
    model: rule.model ?? null,
    provider: rule.provider ?? "openai_compatible",
    endpointUrl: endpointUrl || null,
  };
}
