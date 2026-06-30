import { z } from "zod";

import { ModelSettingsSchema, ToolPolicySchema } from "../../../../../contracts/agents.js";
import { ModelTierSchema, RegisteredProviderSchema } from "../../../../../contracts/model-tiers.js";
import { JsonValueSchema } from "../../lib/supabase-row-parsers.js";

export const AgentProfileRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  type: z.string().nullable(),
  model_settings: ModelSettingsSchema,
  tool_policy: ToolPolicySchema,
});
export type AgentProfileRow = z.infer<typeof AgentProfileRowSchema>;

export const GatewayConfigProfileRowSchema = z.object({
  config_json: JsonValueSchema,
});
export type GatewayConfigProfileRow = z.infer<typeof GatewayConfigProfileRowSchema>;

export const CredentialProfileRowSchema = z.object({
  id: z.string().uuid(),
  key_value: JsonValueSchema.nullable(),
});
export type CredentialProfileRow = z.infer<typeof CredentialProfileRowSchema>;

export const RoutingRuleRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  priority: z.number().int(),
  runner_kind: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  credential_id: z.string().uuid().nullable(),
  credential_alias: z.string().nullable(),
  model_tier_floor: ModelTierSchema.default("any"),
});
export type RoutingRuleRow = z.infer<typeof RoutingRuleRowSchema>;

export const RoutingRuleFallbackRowSchema = z.object({
  routing_rule_id: z.string().uuid(),
  position: z.number().int(),
  provider: RegisteredProviderSchema,
  model: z.string(),
  credential_id: z.string().uuid().nullable(),
  credential_alias: z.string().nullable(),
});
export type RoutingRuleFallbackRow = z.infer<typeof RoutingRuleFallbackRowSchema>;

export const RoutingRuleMatchRowSchema = z.object({
  rule_id: z.string().uuid(),
  kind: z.string(),
  key: z.string().nullable(),
  value: z.string(),
});
export type RoutingRuleMatchRow = z.infer<typeof RoutingRuleMatchRowSchema>;

export const CredentialAliasRowSchema = z.object({
  alias: z.string(),
  credential_id: z.string().uuid(),
});
export type CredentialAliasRow = z.infer<typeof CredentialAliasRowSchema>;

export type ResolveExecutionProfileInput = {
  agentId: string;
  intent?: string | null;
  intentKey?: string | null;
  accessToken?: string;
  requesterUserId?: string;
  skipCredentialCheck?: boolean;
};
