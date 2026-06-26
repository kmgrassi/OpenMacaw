import { ModelSettingsSchema } from "../../../../../contracts/agents.js";
import { ApiRouteError } from "../../http.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import { hasCredentialForAgent } from "../credentials/agent-scope.js";
import type {
  AgentProfileRow,
  CredentialAliasRow,
  CredentialProfileRow,
  GatewayConfigProfileRow,
  ResolveExecutionProfileInput,
  RoutingRuleFallbackRow,
  RoutingRuleMatchRow,
  RoutingRuleRow,
} from "./types.js";
import {
  AgentProfileRowSchema,
  CredentialAliasRowSchema,
  CredentialProfileRowSchema,
  GatewayConfigProfileRowSchema,
  RoutingRuleFallbackRowSchema,
  RoutingRuleMatchRowSchema,
  RoutingRuleRowSchema,
} from "./types.js";

function clientForAccessToken(accessToken?: string) {
  return narrowSupabase(accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase());
}

function firstRow<Row>(data: Row[] | Row | null): Row | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

export async function getAgent(input: ResolveExecutionProfileInput): Promise<AgentProfileRow> {
  const { data, error } = await clientForAccessToken(input.accessToken)
    .from<AgentProfileRow>("agent")
    .select("id,workspace_id,type,model_settings,tool_policy")
    .eq("id", input.agentId)
    .limit(1);
  if (error) throw normalizeSupabaseError("agent query", error);

  const agent = parseNullableSupabaseRow("agent query", AgentProfileRowSchema, firstRow(data));
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }
  return agent;
}

export async function getAgentGatewayConfig(
  input: ResolveExecutionProfileInput,
): Promise<GatewayConfigProfileRow | null> {
  const { data, error } = await clientForAccessToken(input.accessToken)
    .from<GatewayConfigProfileRow>("gateway_config")
    .select("config_json")
    .eq("scope_type", "agent")
    .eq("scope_id", input.agentId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw normalizeSupabaseError("gateway_config query", error);

  return parseNullableSupabaseRow("gateway_config query", GatewayConfigProfileRowSchema, firstRow(data));
}

export async function getRoutingRules(workspaceId: string, accessToken?: string): Promise<RoutingRuleRow[]> {
  const { data, error } = await clientForAccessToken(accessToken)
    .from<RoutingRuleRow>("routing_rule")
    .select("id,workspace_id,priority,runner_kind,provider,model,credential_id,credential_alias,model_tier_floor")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw normalizeSupabaseError("routing_rule query", error);

  const rows = parseSupabaseRows("routing_rule query", RoutingRuleRowSchema, Array.isArray(data) ? data : []);
  return rows.sort((left, right) => right.priority - left.priority);
}

export async function getRuleMatches(
  workspaceId: string,
  ruleIds: string[],
  accessToken?: string,
): Promise<RoutingRuleMatchRow[]> {
  if (ruleIds.length === 0) return [];
  const { data, error } = await clientForAccessToken(accessToken)
    .from<RoutingRuleMatchRow>("routing_rule_match")
    .select("rule_id,kind,key,value")
    .eq("workspace_id", workspaceId)
    .in("rule_id", ruleIds);
  if (error) throw normalizeSupabaseError("routing_rule_match query", error);

  return parseSupabaseRows("routing_rule_match query", RoutingRuleMatchRowSchema, Array.isArray(data) ? data : []);
}

export async function getRoutingRuleFallbacks(
  workspaceId: string,
  ruleIds: string[],
  accessToken?: string,
): Promise<RoutingRuleFallbackRow[]> {
  if (ruleIds.length === 0) return [];
  const { data, error } = await clientForAccessToken(accessToken)
    .from<RoutingRuleFallbackRow>("routing_rule_fallback")
    .select("routing_rule_id,position,provider,model,credential_id,credential_alias")
    .eq("workspace_id", workspaceId)
    .in("routing_rule_id", ruleIds)
    .order("position", { ascending: true });
  if (error) throw normalizeSupabaseError("routing_rule_fallback query", error);

  return parseSupabaseRows(
    "routing_rule_fallback query",
    RoutingRuleFallbackRowSchema,
    Array.isArray(data) ? data : [],
  );
}

export async function resolveCredentialAlias(
  workspaceId: string,
  alias: string,
  accessToken?: string,
): Promise<string | null> {
  const { data, error } = await clientForAccessToken(accessToken)
    .from<CredentialAliasRow>("credential_alias")
    .select("alias,credential_id")
    .eq("workspace_id", workspaceId)
    .eq("alias", alias)
    .limit(1);
  if (error) throw normalizeSupabaseError("credential_alias query", error);

  const match = parseNullableSupabaseRow("credential_alias query", CredentialAliasRowSchema, firstRow(data));
  return match?.credential_id ?? null;
}

export async function getAgentCredentialId(
  agentId: string,
  workspaceId: string | null,
  accessToken?: string,
): Promise<string | null> {
  if (!workspaceId) return null;
  const { data, error } = await clientForAccessToken(accessToken)
    .from<CredentialProfileRow>("credential")
    .select("id,key_value")
    .eq("workspace_id", workspaceId);
  if (error) throw normalizeSupabaseError("credential query", error);

  const rows = parseSupabaseRows("credential query", CredentialProfileRowSchema, Array.isArray(data) ? data : []);
  const match = rows.find((row) => {
    const value = row.key_value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return (value as { agent_id?: unknown }).agent_id === agentId;
  });
  return match?.id ?? null;
}

export async function hasScopedCredential(
  input: ResolveExecutionProfileInput,
  agent: AgentProfileRow,
): Promise<boolean> {
  if (input.skipCredentialCheck) return true;
  if (!input.requesterUserId) return false;
  return hasCredentialForAgent(input.accessToken ?? "", input.requesterUserId, {
    ...agent,
    model_settings: ModelSettingsSchema.parse(agent.model_settings),
  });
}
