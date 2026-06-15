import { ApiRouteError } from "../../http.js";
import { ROUTING_RULE_PROVIDER_ALLOWED } from "../../repositories/routing-rules.js";
import type { ToolExecutionContext } from "../tool-execution-client.js";

import { executeSchemaAwareRows, queryFrom } from "./schema-aware-query.js";
import {
  booleanArg,
  type CredentialRefArg,
  type FallbackArg,
  jsonOutput,
  optionalPositiveInteger,
  stringArg,
} from "./shared.js";

const ROUTING_RULE_SELECT =
  "id,workspace_id,name,priority,runner_kind,provider,model,credential_id,credential_alias,enabled,model_tier_floor,updated_at" as const;
const ROUTING_RULE_FALLBACK_SELECT =
  "id,workspace_id,routing_rule_id,position,provider,model,credential_id,credential_alias,created_at,updated_at" as const;
const ROUTING_RULE_CHANGE_SELECT =
  "id,workspace_id,routing_rule_id,actor_agent_id,change_kind,old_provider,old_model,new_provider,new_model,reason,created_at" as const;

type RoutingRuleToolRow = {
  id: string;
  workspace_id: string;
  name: string;
  priority: number;
  runner_kind: string;
  provider: string | null;
  model: string | null;
  credential_id: string | null;
  credential_alias: string | null;
  enabled: boolean;
  model_tier_floor?: string | null;
  updated_at: string;
};

type RoutingRuleFallbackRow = {
  id: string;
  workspace_id: string;
  routing_rule_id: string;
  position: number;
  provider: string;
  model: string;
  credential_id: string | null;
  credential_alias: string | null;
  created_at: string;
  updated_at: string;
};

function credentialRefArg(value: unknown): CredentialRefArg | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  const refValue = typeof record.value === "string" ? record.value.trim() : "";
  if ((type === "credential_id" || type === "alias") && refValue) return { type, value: refValue };
  throw new ApiRouteError(400, "invalid_tool_arguments", "credentialRef must include type and value");
}

function assertKnownProviderModel(provider: string, model: string) {
  if (!provider || !model) {
    throw new ApiRouteError(400, "unknown_model_in_fallback_chain", "provider and model are required");
  }
  if (!ROUTING_RULE_PROVIDER_ALLOWED.has(provider)) {
    throw new ApiRouteError(400, "unknown_model_in_fallback_chain", `Unknown execution provider: ${provider}`);
  }
}

function fallbackArgs(value: unknown): FallbackArg[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new ApiRouteError(400, "invalid_tool_arguments", "fallbacks must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiRouteError(400, "invalid_tool_arguments", `fallbacks[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    assertKnownProviderModel(provider, model);
    return { provider, model, credentialRef: credentialRefArg(record.credentialRef ?? record.credential_ref) };
  });
}

function routingRuleIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "routingRuleId") || stringArg(args, "routing_rule_id") || stringArg(args, "id");
}

function publicRoutingRule(rule: RoutingRuleToolRow, fallbacks: RoutingRuleFallbackRow[]) {
  return {
    id: rule.id,
    workspaceId: rule.workspace_id,
    name: rule.name,
    priority: rule.priority,
    runnerKind: rule.runner_kind,
    provider: rule.provider,
    model: rule.model,
    credentialRef: rule.credential_alias
      ? { type: "alias", value: rule.credential_alias }
      : rule.credential_id
        ? { type: "credential_id", value: rule.credential_id }
        : null,
    enabled: rule.enabled,
    modelTierFloor: rule.model_tier_floor ?? "any",
    fallbacks: fallbacks.map((fallback) => ({
      id: fallback.id,
      position: fallback.position,
      provider: fallback.provider,
      model: fallback.model,
      credentialRef: fallback.credential_alias
        ? { type: "alias", value: fallback.credential_alias }
        : fallback.credential_id
          ? { type: "credential_id", value: fallback.credential_id }
          : null,
    })),
    updatedAt: rule.updated_at,
  };
}

async function listRoutingRuleFallbacks(ruleIds: string[], workspaceId: string): Promise<RoutingRuleFallbackRow[]> {
  if (ruleIds.length === 0) return [];
  return executeSchemaAwareRows<RoutingRuleFallbackRow>(
    "routing_rule_fallback query",
    queryFrom("routing_rule_fallback")
      .select(ROUTING_RULE_FALLBACK_SELECT)
      .eq("workspace_id", workspaceId)
      .in("routing_rule_id", ruleIds)
      .order("position", { ascending: true }),
  );
}

async function readRoutingRule(routingRuleId: string, workspaceId: string): Promise<RoutingRuleToolRow> {
  const rows = await executeSchemaAwareRows<RoutingRuleToolRow>(
    "routing_rule query",
    queryFrom("routing_rule")
      .select(ROUTING_RULE_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("id", routingRuleId)
      .limit(1),
  );
  const rule = rows[0] ?? null;
  if (!rule) throw new ApiRouteError(404, "routing_rule_not_found", "Routing rule was not found");
  return rule;
}

async function isActorRule(routingRuleId: string, workspaceId: string, agentId: string): Promise<boolean> {
  const matches = await executeSchemaAwareRows<{ kind: string | null; key: string | null; value: string | null }>(
    "routing_rule_match query",
    queryFrom("routing_rule_match")
      .select("kind,key,value")
      .eq("workspace_id", workspaceId)
      .eq("rule_id", routingRuleId)
      .eq("value", agentId),
  );
  return matches.some(
    (match) =>
      (match.kind === "agent" && match.key === "id") ||
      (match.kind === "agent_id" && (match.key === "id" || match.key === "agent_id")),
  );
}

async function insertRoutingRuleChange(input: {
  workspaceId: string;
  routingRuleId: string;
  actorAgentId: string | null;
  changeKind: "primary_model" | "fallback_chain" | "enabled";
  oldProvider?: string | null;
  oldModel?: string | null;
  newProvider?: string | null;
  newModel?: string | null;
  reason: string;
}) {
  await executeSchemaAwareRows(
    "routing_rule_change insert",
    queryFrom("routing_rule_change")
      .insert({
        workspace_id: input.workspaceId,
        routing_rule_id: input.routingRuleId,
        actor_agent_id: input.actorAgentId,
        change_kind: input.changeKind,
        old_provider: input.oldProvider ?? null,
        old_model: input.oldModel ?? null,
        new_provider: input.newProvider ?? null,
        new_model: input.newModel ?? null,
        reason: input.reason,
      })
      .select(ROUTING_RULE_CHANGE_SELECT),
  );
}

async function replaceRoutingRuleFallbacks(input: {
  workspaceId: string;
  routingRuleId: string;
  fallbacks: FallbackArg[];
}) {
  await executeSchemaAwareRows(
    "routing_rule_fallback delete",
    queryFrom("routing_rule_fallback")
      .delete()
      .eq("workspace_id", input.workspaceId)
      .eq("routing_rule_id", input.routingRuleId),
  );
  if (input.fallbacks.length === 0) return;
  await executeSchemaAwareRows(
    "routing_rule_fallback insert",
    queryFrom("routing_rule_fallback")
      .insert(
        input.fallbacks.map((fallback, position) => ({
          workspace_id: input.workspaceId,
          routing_rule_id: input.routingRuleId,
          position,
          provider: fallback.provider,
          model: fallback.model,
          credential_id: fallback.credentialRef?.type === "credential_id" ? fallback.credentialRef.value : null,
          credential_alias: fallback.credentialRef?.type === "alias" ? fallback.credentialRef.value : null,
        })),
      )
      .select(ROUTING_RULE_FALLBACK_SELECT),
  );
}

export async function listRoutingRules(args: Record<string, unknown>, workspaceId: string) {
  const limit = optionalPositiveInteger(args, "limit", 50, 200);
  const rules = await executeSchemaAwareRows<RoutingRuleToolRow>(
    "routing_rule query",
    queryFrom("routing_rule")
      .select(ROUTING_RULE_SELECT)
      .eq("workspace_id", workspaceId)
      .order("priority", { ascending: true })
      .limit(limit),
  );
  const fallbacks = await listRoutingRuleFallbacks(
    rules.map((rule) => rule.id),
    workspaceId,
  );
  const fallbacksByRule = new Map<string, RoutingRuleFallbackRow[]>();
  for (const fallback of fallbacks) {
    const current = fallbacksByRule.get(fallback.routing_rule_id) ?? [];
    current.push(fallback);
    fallbacksByRule.set(fallback.routing_rule_id, current);
  }
  return {
    status: 200,
    output: jsonOutput({
      routingRules: rules.map((rule) => publicRoutingRule(rule, fallbacksByRule.get(rule.id) ?? [])),
    }),
  };
}

export async function readRoutingRuleTool(args: Record<string, unknown>, workspaceId: string) {
  const routingRuleId = routingRuleIdArg(args);
  if (!routingRuleId) throw new ApiRouteError(400, "invalid_tool_arguments", "routingRuleId is required");
  const rule = await readRoutingRule(routingRuleId, workspaceId);
  const fallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
  return { status: 200, output: jsonOutput({ routingRule: publicRoutingRule(rule, fallbacks) }) };
}

export async function updateRoutingRule(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
) {
  const routingRuleId = routingRuleIdArg(args);
  if (!routingRuleId) throw new ApiRouteError(400, "invalid_tool_arguments", "routingRuleId is required");
  if (args.modelTierFloor !== undefined || args.model_tier_floor !== undefined) {
    throw new ApiRouteError(
      400,
      "model_tier_floor_user_owned",
      "routing_rule.update cannot modify model_tier_floor; users own that policy field",
    );
  }
  const reason = stringArg(args, "reason");
  if (!reason) throw new ApiRouteError(400, "missing_reason", "reason is required for routing_rule.update");

  const existing = await readRoutingRule(routingRuleId, workspaceId);
  const previousPrimary = { provider: existing.provider, model: existing.model, enabled: existing.enabled };
  const existingFallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
  const actorAgentId = context?.agentId?.trim() || null;
  const actorOwnsRule = actorAgentId ? await isActorRule(routingRuleId, workspaceId, actorAgentId) : false;
  const requestedEnabled = booleanArg(args, "enabled");
  if (actorOwnsRule && requestedEnabled === false) {
    throw new ApiRouteError(400, "self_brick_update", "Agents cannot disable their own routing rule");
  }

  const provider = stringArg(args, "provider");
  const model = stringArg(args, "model");
  const hasCredentialUpdate = args.credentialRef !== undefined || args.credential_ref !== undefined;
  const hasPrimaryUpdate = provider.length > 0 || model.length > 0 || hasCredentialUpdate;
  const fallbacks = fallbackArgs(args.fallbacks);
  const nextProvider = provider || existing.provider || "";
  const nextModel = model || existing.model || "";
  if (hasPrimaryUpdate) assertKnownProviderModel(nextProvider, nextModel);
  if (actorOwnsRule && requestedEnabled !== true && !existing.enabled) {
    throw new ApiRouteError(400, "self_brick_update", "Agents cannot leave their own routing rule disabled");
  }
  const nextFallbackCount = fallbacks === null ? existingFallbacks.length : fallbacks.length;
  if (actorOwnsRule && (!nextProvider || !nextModel) && nextFallbackCount === 0) {
    throw new ApiRouteError(
      400,
      "self_brick_update",
      "Agents cannot leave their own routing rule with zero resolvable links",
    );
  }

  const credentialRef = credentialRefArg(args.credentialRef ?? args.credential_ref);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (hasPrimaryUpdate) {
    update.provider = nextProvider;
    update.model = nextModel;
    if (hasCredentialUpdate) {
      update.credential_id = credentialRef?.type === "credential_id" ? credentialRef.value : null;
      update.credential_alias = credentialRef?.type === "alias" ? credentialRef.value : null;
    }
  }
  if (requestedEnabled !== null) update.enabled = requestedEnabled;

  const updatedRows =
    Object.keys(update).length > 1
      ? await executeSchemaAwareRows<RoutingRuleToolRow>(
          "routing_rule update",
          queryFrom("routing_rule")
            .update(update)
            .eq("id", routingRuleId)
            .eq("workspace_id", workspaceId)
            .select(ROUTING_RULE_SELECT),
        )
      : [existing];
  const updated = updatedRows[0] ?? existing;

  if (fallbacks !== null) {
    await replaceRoutingRuleFallbacks({ workspaceId, routingRuleId, fallbacks });
  }

  if (hasPrimaryUpdate && (previousPrimary.provider !== updated.provider || previousPrimary.model !== updated.model)) {
    await insertRoutingRuleChange({
      workspaceId,
      routingRuleId,
      actorAgentId,
      changeKind: "primary_model",
      oldProvider: previousPrimary.provider,
      oldModel: previousPrimary.model,
      newProvider: updated.provider,
      newModel: updated.model,
      reason,
    });
  }
  if (fallbacks !== null) {
    await insertRoutingRuleChange({
      workspaceId,
      routingRuleId,
      actorAgentId,
      changeKind: "fallback_chain",
      oldProvider: existingFallbacks[0]?.provider ?? null,
      oldModel: existingFallbacks[0]?.model ?? null,
      newProvider: fallbacks[0]?.provider ?? null,
      newModel: fallbacks[0]?.model ?? null,
      reason,
    });
  }
  if (requestedEnabled !== null && previousPrimary.enabled !== requestedEnabled) {
    await insertRoutingRuleChange({
      workspaceId,
      routingRuleId,
      actorAgentId,
      changeKind: "enabled",
      oldProvider: previousPrimary.provider,
      oldModel: previousPrimary.model,
      newProvider: updated.provider,
      newModel: updated.model,
      reason,
    });
  }

  const updatedFallbacks = await listRoutingRuleFallbacks([routingRuleId], workspaceId);
  return { status: 200, output: jsonOutput({ routingRule: publicRoutingRule(updated, updatedFallbacks) }) };
}
