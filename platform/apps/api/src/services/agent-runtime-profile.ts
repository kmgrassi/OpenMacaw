import { deriveProviderFromModel } from "../../../../contracts/agent-helpers.js";
import {
  AgentRuntimeProfileSchema,
  AgentRuntimeProviderSchema,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileUpdateRequest,
} from "../../../../contracts/agents.js";
import type { CredentialReference } from "../../../../contracts/credentials.js";
import type { KnownExecutionProvider } from "../../../../contracts/execution-profile.js";
import { ApiRouteError } from "../http.js";
import { findStoredAgentRowById, getStoredAgentGatewayConfig, updateStoredAgentRow } from "../repositories/agents.js";
import type { SetupAgentRow } from "../repositories/agents.js";
import {
  credentialRefFromRoutingRuleFallback,
  credentialRefFromRoutingRule,
  getAgentCredentialReferenceRule,
  getRoutingRuleLocalEndpointUrl,
  listRoutingRuleFallbacks,
  upsertAgentCredentialReferenceRule,
} from "../repositories/routing-rules.js";
import { getCredentialRowByIdForWorkspace, resolveCredentialAlias } from "../repositories/credentials.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { ensureGatewayConfigExists } from "./ensure-gateway-config.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { asJson, buildChangeSummary, hashConfig } from "./setup/builders.js";
import { writeGatewayConfigForManagerAgent } from "./setup/store/gateway-config-writer.js";
import { createStoredAgentGatewayConfigVersion, updateStoredAgentGatewayConfig } from "../repositories/agents.js";
import { defaultRunnerKindForAgentType } from "../../../../contracts/agent-runner-defaults.js";
import { ModelSettingsSchema, ToolPolicySchema, normalizeAgentType } from "../../../../contracts/agents.js";

const HOSTED_PROVIDERS = new Set<KnownExecutionProvider>(["openai", "openai_compatible", "anthropic"]);

/**
 * The local helper advertises the runner kinds it can serve into
 * `local_runtime_machine.runner_kinds` (see
 * `local-runtime/machines.ts` — an `openai_compatible` registration
 * advertises `openai_compatible`, `local_model_coding`, `planner`). It
 * never advertises `llm_tool_runner`: a manager agent on a local model
 * does not run *on* the helper, it dispatches over the relay to the
 * helper's `openai_compatible` runner (the relay's default target — see
 * `runtime/.../manager/model_client/local_relay.ex`
 * `@default_target_runner_kind`).
 *
 * So when checking whether a workspace has a local helper for an agent,
 * map the agent's runner kind to the runner kind the helper would
 * actually advertise. Coding (`local_model_coding`) and planning
 * (`planner`) already match an advertised kind directly, so only the
 * manager's `llm_tool_runner` needs remapping.
 */
const LOCAL_HELPER_RUNNER_KIND_BY_AGENT_RUNNER_KIND: Record<string, string> = {
  llm_tool_runner: "openai_compatible",
};

export function localHelperRunnerKindForAgentRunnerKind(runnerKind: string): string {
  return LOCAL_HELPER_RUNNER_KIND_BY_AGENT_RUNNER_KIND[runnerKind] ?? runnerKind;
}

function runnerKindForRuntimeProfile(agentType: string | null | undefined, provider: KnownExecutionProvider) {
  // Coding agents pointed at a local provider use the local-coding
  // runtime instead of the cloud-hosted codex runner — different
  // executionLocation, different transport. Every other agent type
  // uses the canonical default (which is provider-agnostic, since
  // runner_kind describes capability, not the model backing it).
  if (agentType === "coding" && provider === "local") return "local_model_coding";
  return defaultRunnerKindForAgentType(agentType);
}

function credentialRequired(input: {
  runnerKind: string;
  provider: KnownExecutionProvider;
  localEndpointUrl?: string | null;
}) {
  if (!HOSTED_PROVIDERS.has(input.provider)) return false;
  if (input.provider === "openai_compatible" && input.localEndpointUrl?.trim()) return false;
  return true;
}

async function hasLocalHelper(input: { workspaceId: string; runnerKind: string }) {
  const { data, error } = await getServiceRoleSupabase()
    .from("local_runtime_machine")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .is("revoked_at", null)
    .contains("runner_kinds", [input.runnerKind])
    .limit(1);
  if (error) throw normalizeSupabaseError("local_runtime_machine query", error);
  return (data ?? []).length > 0;
}

function updateGatewayRuntimeConfig(input: {
  currentConfig: unknown;
  provider: KnownExecutionProvider;
  model: string;
  runnerKind: string;
}) {
  const root =
    input.currentConfig && typeof input.currentConfig === "object" && !Array.isArray(input.currentConfig)
      ? { ...(input.currentConfig as Record<string, unknown>) }
      : {};
  const runners = root.runners;
  const patch = {
    kind: input.runnerKind,
    provider: input.provider,
    model: input.model,
  };

  if (Array.isArray(runners)) {
    const firstRunner = typeof runners[0] === "object" && runners[0] !== null ? runners[0] : {};
    return {
      ...root,
      runners: [{ ...firstRunner, ...patch }, ...runners.slice(1)],
    };
  }

  return {
    ...root,
    runners: [{ ...patch }],
  };
}

async function persistAgentGatewayRuntimeConfig(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  provider: KnownExecutionProvider;
  model: string;
  runnerKind: string;
}) {
  const existing = await getStoredAgentGatewayConfig(input.accessToken, input.agentId);
  if (!existing) {
    await ensureGatewayConfigExists({
      agentId: input.agentId,
      role: input.runnerKind === "planner" || input.runnerKind === "llm_tool_runner" ? "planning" : "coding",
      provider: input.provider,
      model: input.model,
    });
  }

  const current = existing ?? (await getStoredAgentGatewayConfig(input.accessToken, input.agentId));
  if (!current) return;

  const nextConfig = updateGatewayRuntimeConfig({
    currentConfig: current.config_json,
    provider: input.provider,
    model: input.model,
    runnerKind: input.runnerKind,
  });
  const nextVersion = current.version + 1;
  const configHash = hashConfig(nextConfig);
  const updated = await updateStoredAgentGatewayConfig({
    accessToken: input.accessToken,
    gatewayConfigId: current.id,
    userId: input.userId,
    version: nextVersion,
    configHash,
    configJson: asJson(nextConfig),
  });
  if (!updated) throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
  await createStoredAgentGatewayConfigVersion({
    accessToken: input.accessToken,
    gatewayConfigId: updated.id,
    userId: input.userId,
    version: nextVersion,
    configHash,
    configJson: updated.config_json,
    changeSummary: asJson(buildChangeSummary(current.config_json, nextConfig)),
  });
}

async function updateAgentPrimaryModel(input: {
  accessToken: string;
  agentId: string;
  existing: Awaited<ReturnType<typeof findStoredAgentRowById>>;
  model: string;
}) {
  if (!input.existing) return;
  const currentSettings = ModelSettingsSchema.parse(input.existing.model_settings);
  const nextSettings = ModelSettingsSchema.parse({ ...currentSettings, primary: input.model });
  await updateStoredAgentRow({
    accessToken: input.accessToken,
    agentId: input.agentId,
    name: input.existing.name?.trim() || input.agentId,
    type: input.existing.type ?? "coding",
    context: input.existing.context ?? null,
    modelSettings: nextSettings,
    toolPolicy: ToolPolicySchema.parse(input.existing.tool_policy),
  });
}

function assertCredentialPolicy(input: {
  agentType: string | null;
  runnerKind: string;
  provider: KnownExecutionProvider;
  credentialRef: CredentialReference | null;
  localEndpointUrl?: string | null;
}) {
  if (credentialRequired(input) && !input.credentialRef) {
    throw new ApiRouteError(400, "credential_required", "Hosted providers require a credential reference");
  }
}

async function assertCredentialReferenceBelongsToWorkspace(input: {
  workspaceId: string;
  credentialRef: CredentialReference | null;
}) {
  if (!input.credentialRef) return;

  if (input.credentialRef.type === "alias") {
    const alias = await resolveCredentialAlias(input.workspaceId, input.credentialRef.value);
    if (!alias) throw new ApiRouteError(404, "credential_alias_not_found", "Credential alias was not found");
    return;
  }

  const credential = await getCredentialRowByIdForWorkspace(input.credentialRef.value, input.workspaceId);
  if (!credential) throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
}

async function assertFallbackCredentialsBelongToWorkspace(input: {
  workspaceId: string;
  fallbacks: NonNullable<AgentRuntimeProfileUpdateRequest["fallbacks"]>;
}) {
  for (const fallback of input.fallbacks) {
    await assertCredentialReferenceBelongsToWorkspace({
      workspaceId: input.workspaceId,
      credentialRef: fallback.credentialRef,
    });
  }
}

export async function getAgentRuntimeProfile(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<AgentRuntimeProfile> {
  const agent = await findStoredAgentRowById(input.accessToken, input.agentId);
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  if (input.workspaceId && agent.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const rule = await getAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
  });
  const resolution = await resolveExecutionProfile({
    accessToken: input.accessToken,
    requesterUserId: input.userId,
    agentId: agent.id,
    skipCredentialCheck: true,
  });
  const profile = resolution.profile;
  const model = rule?.model ?? profile?.model ?? "";
  const provider = rule?.provider ?? profile?.provider ?? deriveProviderFromModel(model);
  const agentType = normalizeAgentType(agent.type);
  const parsedProvider = AgentRuntimeProviderSchema.safeParse(provider);
  if (!model || !parsedProvider.success) {
    throw new ApiRouteError(422, "runtime_profile_incomplete", "Agent runtime profile is missing a model or provider");
  }
  const runnerKind =
    rule?.runner_kind ?? profile?.runnerKind ?? runnerKindForRuntimeProfile(agentType, parsedProvider.data);
  const localEndpointUrl = rule
    ? await getRoutingRuleLocalEndpointUrl({
        ruleId: rule.id,
        workspaceId: agent.workspace_id,
      })
    : null;
  const fallbacks = rule
    ? await listRoutingRuleFallbacks({
        ruleId: rule.id,
        workspaceId: agent.workspace_id,
      })
    : [];

  return AgentRuntimeProfileSchema.parse({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    agentType,
    runnerKind,
    provider: parsedProvider.data,
    model,
    credentialRef: credentialRefFromRoutingRule(rule) ?? profile?.credentialRef ?? null,
    fallbacks: fallbacks.map((fallback) => ({
      provider: fallback.provider,
      model: fallback.model,
      credentialRef: credentialRefFromRoutingRuleFallback(fallback),
    })),
    modelTierFloor: rule?.model_tier_floor ?? "any",
    localEndpointUrl,
    localHelperRegistered:
      provider === "local"
        ? await hasLocalHelper({
            workspaceId: agent.workspace_id,
            runnerKind: localHelperRunnerKindForAgentRunnerKind(runnerKind),
          })
        : false,
    updatedAt: rule?.updated_at ?? null,
  });
}

export async function updateAgentRuntimeProfile(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  body: AgentRuntimeProfileUpdateRequest;
  localMachineId?: string | null;
}): Promise<AgentRuntimeProfile> {
  const agent = await findStoredAgentRowById(input.accessToken, input.agentId);
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  if (agent.workspace_id !== input.body.workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const agentType = normalizeAgentType(agent.type);
  const runnerKind = runnerKindForRuntimeProfile(agentType, input.body.provider);
  const credentialRef = input.body.provider === "local" ? null : (input.body.credentialRef ?? null);
  assertCredentialPolicy({
    agentType,
    runnerKind,
    provider: input.body.provider,
    credentialRef,
    localEndpointUrl: input.body.localEndpointUrl,
  });
  await assertCredentialReferenceBelongsToWorkspace({
    workspaceId: agent.workspace_id,
    credentialRef,
  });
  await assertFallbackCredentialsBelongToWorkspace({
    workspaceId: agent.workspace_id,
    fallbacks: input.body.fallbacks ?? [],
  });

  await updateAgentPrimaryModel({
    accessToken: input.accessToken,
    agentId: agent.id,
    existing: agent,
    model: input.body.model,
  });

  await upsertAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    runnerKind,
    provider: input.body.provider,
    model: input.body.model,
    credentialRef,
    fallbacks: input.body.fallbacks ?? [],
    modelTierFloor: input.body.modelTierFloor ?? "any",
    localEndpointUrl: input.body.localEndpointUrl ?? null,
    localMachineId: input.body.provider === "local" ? input.localMachineId : null,
  });

  if (agentType === "manager") {
    const managerAgent = {
      ...agent,
      status: "active",
      created_by_user_id: null,
      updated_at: null,
    } satisfies SetupAgentRow;

    await writeGatewayConfigForManagerAgent({
      accessToken: input.accessToken,
      userId: input.userId,
      agent: managerAgent,
      provider: input.body.provider,
      model: input.body.model,
      runnerKind: "llm_tool_runner",
    });
  } else if (agentType === "planning" || agentType === "coding") {
    await persistAgentGatewayRuntimeConfig({
      accessToken: input.accessToken,
      userId: input.userId,
      agentId: agent.id,
      provider: input.body.provider,
      model: input.body.model,
      runnerKind,
    });
  }

  return getAgentRuntimeProfile({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: agent.id,
    workspaceId: agent.workspace_id,
  });
}

export async function updateAgentRuntimeProfileForAuthenticatedUser(input: {
  auth: {
    accessToken: string;
    userId: string;
  };
  agentId: string;
  body: AgentRuntimeProfileUpdateRequest;
  localMachineId?: string | null;
}): Promise<AgentRuntimeProfile> {
  if (!input.auth.accessToken.trim() || !input.auth.userId.trim()) {
    throw new ApiRouteError(401, "unauthorized", "Authenticated user context is required");
  }

  return updateAgentRuntimeProfile({
    accessToken: input.auth.accessToken,
    userId: input.auth.userId,
    agentId: input.agentId,
    body: input.body,
    localMachineId: input.localMachineId,
  });
}
