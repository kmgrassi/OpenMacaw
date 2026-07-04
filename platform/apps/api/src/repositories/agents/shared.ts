import type { Json } from "@kmgrassi/supabase-schema";
import { z } from "zod";

import {
  ModelSettingsSchema,
  ToolPolicySchema,
  type ModelSettings,
  type ToolPolicy,
} from "../../../../../contracts/agents.js";
import { getServiceRoleSupabase, getUserScopedSupabase } from "../../supabase-client.js";
import { JsonValueSchema } from "../../lib/supabase-row-parsers.js";

export const StoredAgentRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  workspace_id: z.string(),
  type: z.string().nullable(),
  context: z.string().nullable().default(null),
  model_settings: ModelSettingsSchema,
  tool_policy: ToolPolicySchema,
});

export const StoredAgentGatewayConfigRowSchema = z.object({
  id: z.string(),
  scope_id: z.string(),
  version: z.number(),
  config_hash: z.string(),
  config_json: JsonValueSchema,
});

export const DeletedAgentRowSchema = z.object({
  id: z.string(),
});

export const SetupAgentRowSchema = StoredAgentRowSchema.extend({
  status: z.string(),
  created_by_user_id: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type StoredAgentRow = z.infer<typeof StoredAgentRowSchema>;
export type StoredAgentGatewayConfigRow = z.infer<typeof StoredAgentGatewayConfigRowSchema>;
export type SetupAgentRow = z.infer<typeof SetupAgentRowSchema>;

export const SETUP_AGENT_SELECT =
  "id,workspace_id,name,status,type,context,model_settings,tool_policy,created_by_user_id,updated_at" as const;
export const STORED_AGENT_SELECT = "id,name,workspace_id,type,context,model_settings,tool_policy" as const;
export const STORED_AGENT_GATEWAY_CONFIG_SELECT = "id,scope_id,version,config_hash,config_json" as const;

export function clientForAccessToken(accessToken?: string) {
  return accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase();
}

export function toDatabaseJson(value: ModelSettings | ToolPolicy): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
