import { asRecord, deriveProviderFromModel, extractPrimaryModel } from "../../../../contracts/agent-helpers.js";
import {
  normalizeAgentType,
  LocalModelCodingConfigRowSchema,
  ModelSettingsSchema,
  PlanningDestinationSchema,
  StoredAgentSchema,
  ToolPolicySchema,
  type ModelSettings,
  type PlanningDestination,
  type StoredAgent,
  type ToolPolicy,
} from "../../../../contracts/agents.js";
import type {
  StoredAgentCreateRequest,
  StoredAgentUpdateRequest,
} from "../../../../contracts/stored-agent-management.js";
import {
  createStoredAgentGatewayConfig,
  createStoredAgentGatewayConfigVersion,
  createStoredAgentRow,
  deleteStoredAgentRow,
  findStoredAgentRowById,
  getStoredAgentGatewayConfig,
  listStoredAgentGatewayConfigRows,
  listStoredAgentRows,
  updateStoredAgentGatewayConfig,
  updateStoredAgentRow,
  type StoredAgentRow,
} from "../repositories/agents.js";
import { listCredentialAgentIds } from "../repositories/credentials.js";
import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { syncAgentGatewayConfigForExecutionProfile } from "./agent-gateway-config-sync.js";
import { countCredentialsForAgent } from "./credentials/agent-scope.js";
import { ensureDefaultAgentToolsForAgent } from "./default-agent-tools.js";
import { syncModelIntoRoutingRuleForAgent } from "./stored-agent-routing.js";
import { asJson, buildChangeSummary, hashConfig } from "./setup/builders.js";

function extractPlanningDestination(toolPolicy: unknown) {
  const policy = asRecord(toolPolicy);
  const planning = asRecord(policy?.planning);
  const parsed = PlanningDestinationSchema.safeParse(planning?.destination);
  return parsed.success ? parsed.data : null;
}

function extractLocalModelCodingConfig(toolPolicy: unknown) {
  const policy = asRecord(toolPolicy);
  const localCoding = asRecord(policy?.local_model_coding);
  const parsed = LocalModelCodingConfigRowSchema.safeParse(localCoding);
  if (!parsed.success) return null;
  return {
    enabled: parsed.data.enabled,
    approvalPolicy: parsed.data.approval_policy,
    workspaceWrite: parsed.data.workspace_write,
    localModelId: parsed.data.local_model_id ?? null,
  };
}

type StoredAgentAuthContext = {
  accessToken: string;
  userId: string;
};

function isMissingRoutingRuleTable(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "PGRST205" || error.message.includes("PGRST205") || error.message.includes("42P01");
}

async function resolveCredentialAgentIds(
  agentRows: Awaited<ReturnType<typeof listStoredAgentRows>>,
  auth?: StoredAgentAuthContext,
): Promise<Set<string>> {
  if (auth?.accessToken && auth.userId) {
    const entries = await Promise.all(
      agentRows.map(
        async (agent) => [agent.id, await countCredentialsForAgent(auth.accessToken, auth.userId, agent)] as const,
      ),
    );
    return new Set(entries.filter(([, count]) => count > 0).map(([agentId]) => agentId));
  }

  return listCredentialAgentIds(agentRows.map((row) => row.id));
}

function toRecord(value: unknown): Record<string, unknown> {
  return { ...(asRecord(value) ?? {}) };
}

function buildStoredAgentToolPolicy(
  input: {
    type: string;
    planningDestination?: PlanningDestination;
    localModelCoding?: {
      enabled: boolean;
      approvalPolicy: "on_request" | "never";
      workspaceWrite: boolean;
      localModelId?: string | null;
    };
  },
  existing?: unknown,
): ToolPolicy {
  const policy = toRecord(existing);
  if (input.type === "coding" && input.localModelCoding) {
    return ToolPolicySchema.parse({
      ...policy,
      local_model_coding: {
        enabled: input.localModelCoding.enabled,
        approval_policy: input.localModelCoding.approvalPolicy,
        workspace_write: input.localModelCoding.workspaceWrite,
        local_model_id: input.localModelCoding.localModelId ?? null,
      },
    });
  }

  if (input.type !== "planning") return ToolPolicySchema.parse(policy);

  const planning = toRecord(policy.planning);
  return ToolPolicySchema.parse({
    ...policy,
    planning: {
      ...planning,
      destination: input.planningDestination || "database",
    },
  });
}

function buildStoredAgentModelSettings(input: {
  model?: string | null;
  type: string;
  customTarget?: StoredAgentCreateRequest["customTarget"];
}): ModelSettings {
  const settings: Record<string, unknown> = {};
  const model = input.model?.trim();
  if (model) settings.primary = model;
  if (input.type === "custom" && input.customTarget) {
    settings.custom = {
      backend_type: input.customTarget.backendType.trim(),
      base_url: input.customTarget.baseUrl.trim(),
      agent_id: input.customTarget.agentId.trim(),
    };
  }
  return ModelSettingsSchema.parse(settings);
}

function buildGatewayBackendConfig(input: StoredAgentCreateRequest | StoredAgentUpdateRequest) {
  if (input.type !== "custom" || !input.customTarget) return null;
  return {
    type: input.customTarget.backendType.trim(),
    base_url: input.customTarget.baseUrl.trim(),
    agent_id: input.customTarget.agentId.trim(),
  };
}

function extractCustomTarget(config: unknown): StoredAgent["customTarget"] {
  const root = asRecord(config);
  const backend = asRecord(root?.backend);
  if (!backend) return null;

  return {
    backendType: typeof backend.type === "string" && backend.type.trim() ? backend.type.trim() : null,
    baseUrl: typeof backend.base_url === "string" && backend.base_url.trim() ? backend.base_url.trim() : null,
    agentId: typeof backend.agent_id === "string" && backend.agent_id.trim() ? backend.agent_id.trim() : null,
  };
}

function toStoredAgent(input: {
  row: StoredAgentRow;
  isResolved: boolean;
  hasCredentials: boolean;
  runnerKind?: string | null;
  gatewayConfig?: unknown;
  sessionFallback?: { model: string; provider: string | null } | null;
}) {
  const agentType = normalizeAgentType(input.row.type);
  const configuredModel = extractPrimaryModel(input.row.model_settings);
  const usingSessionFallback = !configuredModel && Boolean(input.sessionFallback?.model);
  const model = configuredModel ?? input.sessionFallback?.model ?? null;

  return StoredAgentSchema.parse({
    id: input.row.id,
    name: input.row.name?.trim() || input.row.id,
    workspaceId: input.row.workspace_id,
    agentType: agentType,
    model,
    provider: usingSessionFallback
      ? (input.sessionFallback?.provider ?? deriveProviderFromModel(model))
      : deriveProviderFromModel(model),
    runnerKind: input.runnerKind ?? null,
    hasCredentials: input.hasCredentials,
    isResolved: input.isResolved,
    context: input.row.context?.trim() || null,
    planningDestination: extractPlanningDestination(input.row.tool_policy),
    localModelCoding: extractLocalModelCodingConfig(input.row.tool_policy),
    customTarget: agentType === "custom" ? extractCustomTarget(input.gatewayConfig) : null,
  });
}

export function isStoredAgentRuntimeSelectable(agent: Pick<StoredAgent, "agentType">): boolean {
  return agent.agentType !== "manager";
}

// PATCH is partial: only touch context when the client actually sends the
// field. An omitted `context` preserves the saved value; an explicit null or
// blank string clears it.
export function resolveUpdatedAgentContext(
  bodyContext: string | null | undefined,
  existingContext: string | null,
): string | null {
  if (bodyContext === undefined) return existingContext ?? null;
  return bodyContext?.trim() || null;
}

async function upsertCustomGatewayConfig(input: {
  accessToken: string;
  agentId: string;
  userId: string;
  agentInput: StoredAgentCreateRequest | StoredAgentUpdateRequest;
}) {
  const backendConfig = buildGatewayBackendConfig(input.agentInput);
  const existing = await getStoredAgentGatewayConfig(input.accessToken, input.agentId);
  if (!existing && !backendConfig) return;

  const nextConfig = toRecord(existing?.config_json);
  if (backendConfig) {
    nextConfig.backend = backendConfig;
  } else {
    delete nextConfig.backend;
  }

  const configHash = hashConfig(nextConfig);

  if (existing) {
    const nextVersion = (existing.version ?? 0) + 1;
    const updated = await updateStoredAgentGatewayConfig({
      accessToken: input.accessToken,
      gatewayConfigId: existing.id,
      userId: input.userId,
      version: nextVersion,
      configHash,
      configJson: asJson(nextConfig),
    });
    if (!updated) {
      throw new ApiRouteError(502, "gateway_config_update_failed", "Gateway config update returned no row");
    }
    await createStoredAgentGatewayConfigVersion({
      accessToken: input.accessToken,
      gatewayConfigId: updated.id,
      userId: input.userId,
      version: nextVersion,
      configHash,
      configJson: asJson(nextConfig),
      changeSummary: asJson(buildChangeSummary(existing.config_json, nextConfig)),
    });
    return;
  }

  const created = await createStoredAgentGatewayConfig({
    accessToken: input.accessToken,
    agentId: input.agentId,
    userId: input.userId,
    configHash,
    configJson: asJson(nextConfig),
  });
  if (!created) {
    throw new ApiRouteError(502, "gateway_config_create_failed", "Gateway config creation returned no row");
  }

  await createStoredAgentGatewayConfigVersion({
    accessToken: input.accessToken,
    gatewayConfigId: created.id,
    userId: input.userId,
    version: created.version,
    configHash: created.config_hash,
    configJson: created.config_json,
    changeSummary: asJson({ created: true }),
  });
}

export async function listStoredAgentsFromSupabase(auth?: StoredAgentAuthContext): Promise<StoredAgent[]> {
  const accessToken = auth?.accessToken?.trim() || undefined;
  const agentRows = await listStoredAgentRows(accessToken);
  if (agentRows.length === 0) return [];

  const agentIds = agentRows.map((row) => row.id);
  const credentialAgentIds = await resolveCredentialAgentIds(agentRows, auth);
  const routeNames = agentIds.map((agentId) => `agent:${agentId}:execution-profile`);
  const credentialReferenceAgentIds = new Set<string>();
  const runnerKindByAgentId = new Map<string, string>();
  if (routeNames.length > 0) {
    let routingRows: Array<{
      name: string;
      runner_kind: string | null;
      credential_id: string | null;
      credential_alias: string | null;
    }> = [];
    const { data, error: routingError } = await getServiceRoleSupabase()
      .from("routing_rule")
      .select("name,runner_kind,credential_id,credential_alias")
      .in("name", routeNames);
    if (routingError) {
      const normalized = normalizeSupabaseError("routing_rule query", routingError);
      if (!isMissingRoutingRuleTable(normalized)) throw normalized;
    } else {
      routingRows = data ?? [];
    }
    for (const row of routingRows) {
      const match = /^agent:(.+):execution-profile$/.exec(row.name);
      if (!match?.[1]) continue;
      if (row.runner_kind) runnerKindByAgentId.set(match[1], row.runner_kind);
      if (row.credential_id || row.credential_alias) credentialReferenceAgentIds.add(match[1]);
    }
  }
  const gatewayConfigRows = await listStoredAgentGatewayConfigRows(agentIds, accessToken);
  const gatewayConfigByAgentId = new Map(gatewayConfigRows.map((row) => [row.scope_id, row.config_json] as const));
  const resolvedAgentId = agentRows.find((agent) => normalizeAgentType(agent.type) !== "manager")?.id ?? null;

  const { data: sessionRows, error: sessionError } = await getServiceRoleSupabase()
    .from("session_thread")
    .select("agent_id,model,model_provider")
    .in("agent_id", agentIds)
    .not("model", "is", null)
    .order("updated_at", { ascending: false });
  if (sessionError) throw normalizeSupabaseError("session_thread query", sessionError);
  const latestSessionModelByAgent = new Map<string, { model: string; provider: string | null }>();
  for (const row of sessionRows) {
    if (!row.agent_id || typeof row.model !== "string" || row.model.trim().length === 0) continue;
    if (latestSessionModelByAgent.has(row.agent_id)) continue;
    latestSessionModelByAgent.set(row.agent_id, {
      model: row.model.trim(),
      provider:
        typeof row.model_provider === "string" && row.model_provider.trim().length > 0
          ? row.model_provider.trim()
          : null,
    });
  }

  return agentRows.map((agent) =>
    toStoredAgent({
      row: agent,
      isResolved: agent.id === resolvedAgentId,
      hasCredentials: credentialAgentIds.has(agent.id) || credentialReferenceAgentIds.has(agent.id),
      runnerKind: runnerKindByAgentId.get(agent.id) ?? null,
      gatewayConfig: gatewayConfigByAgentId.get(agent.id),
      sessionFallback: latestSessionModelByAgent.get(agent.id) ?? null,
    }),
  );
}

export async function createStoredAgentFromApi(input: {
  accessToken: string;
  userId: string;
  body: StoredAgentCreateRequest;
}): Promise<StoredAgent> {
  const created = await createStoredAgentRow({
    accessToken: input.accessToken,
    workspaceId: input.body.workspaceId,
    userId: input.userId,
    name: input.body.name.trim(),
    type: input.body.type,
    context: input.body.context?.trim() || null,
    modelSettings: buildStoredAgentModelSettings(input.body),
    toolPolicy: buildStoredAgentToolPolicy(input.body),
  });

  if (!created) {
    throw new ApiRouteError(502, "agent_create_failed", "Agent creation returned no row");
  }

  await upsertCustomGatewayConfig({
    accessToken: input.accessToken,
    agentId: created.id,
    userId: input.userId,
    agentInput: input.body,
  });
  await ensureDefaultAgentToolsForAgent({
    agentId: created.id,
    workspaceId: created.workspace_id,
    agentType: created.type,
    localModelCodingEnabled: input.body.localModelCoding?.enabled,
    userId: input.userId,
  });

  const gatewayConfig = await getStoredAgentGatewayConfig(input.accessToken, created.id);
  return toStoredAgent({
    row: created as StoredAgentRow,
    isResolved: normalizeAgentType(created.type) !== "manager",
    hasCredentials: false,
    runnerKind: null,
    gatewayConfig: gatewayConfig?.config_json,
  });
}

export async function updateStoredAgentFromApi(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  body: StoredAgentUpdateRequest;
}): Promise<StoredAgent> {
  const existing = await findStoredAgentRowById(input.accessToken, input.agentId);
  if (!existing) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }

  const previousModel = extractPrimaryModel(existing.model_settings);
  const nextModel = input.body.model?.trim() || null;
  const nextContext = resolveUpdatedAgentContext(input.body.context, existing.context ?? null);

  const updated = await updateStoredAgentRow({
    accessToken: input.accessToken,
    agentId: input.agentId,
    name: input.body.name.trim(),
    type: input.body.type,
    context: nextContext,
    modelSettings: buildStoredAgentModelSettings(input.body),
    toolPolicy: buildStoredAgentToolPolicy(input.body, existing.tool_policy),
  });

  if (!updated) {
    throw new ApiRouteError(502, "agent_update_failed", "Agent update returned no row");
  }

  await upsertCustomGatewayConfig({
    accessToken: input.accessToken,
    agentId: input.agentId,
    userId: input.userId,
    agentInput: input.body,
  });
  await ensureDefaultAgentToolsForAgent({
    agentId: updated.id,
    workspaceId: updated.workspace_id,
    agentType: updated.type,
    localModelCodingEnabled: input.body.localModelCoding?.enabled,
    userId: input.userId,
  });

  // If the user changed the model on the agent, mirror that into the
  // routing rule so the resolver sees the new model (and provider,
  // if it changed) on the next request. Credential reference is
  // preserved — credential swaps go through a different code path.
  if (nextModel && nextModel !== previousModel) {
    try {
      await syncModelIntoRoutingRuleForAgent({
        agent: {
          id: updated.id,
          workspaceId: updated.workspace_id,
          agentType: updated.type,
        },
        newModel: nextModel,
        userId: input.userId,
      });
      await syncAgentGatewayConfigForExecutionProfile({
        accessToken: input.accessToken,
        userId: input.userId,
        agentId: updated.id,
      });
    } catch (syncError) {
      // Don't fail the agent update on a sync error — log it and let
      // the user retry. The agent row is already persisted.
      console.error("[stored-agent-update] Failed to sync runtime config:", syncError);
    }
  }

  const gatewayConfig = await getStoredAgentGatewayConfig(input.accessToken, updated.id);
  return toStoredAgent({
    row: updated,
    isResolved: normalizeAgentType(updated.type) !== "manager",
    runnerKind: null,
    hasCredentials: (await listCredentialAgentIds([updated.id])).has(updated.id),
    gatewayConfig: gatewayConfig?.config_json,
  });
}

export async function deleteStoredAgentFromApi(input: { accessToken: string; agentId: string }): Promise<void> {
  const deleted = await deleteStoredAgentRow({
    accessToken: input.accessToken,
    agentId: input.agentId,
  });

  if (!deleted) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }
}
