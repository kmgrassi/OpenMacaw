import { z } from "zod";

import {
  ModelSettingsSchema,
  ToolPolicySchema,
  type ModelSettings,
  type ToolPolicy,
} from "../../../../contracts/agents.js";
import type { Json } from "@kmgrassi/supabase-schema";
import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";
import {
  JsonValueSchema,
  parseNullableSupabaseRow,
  parseSupabaseRow,
  parseSupabaseRows,
} from "../lib/supabase-row-parsers.js";

const StoredAgentRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  workspace_id: z.string(),
  type: z.string().nullable(),
  context: z.string().nullable().default(null),
  model_settings: ModelSettingsSchema,
  tool_policy: ToolPolicySchema,
});

const StoredAgentGatewayConfigRowSchema = z.object({
  id: z.string(),
  scope_id: z.string(),
  version: z.number(),
  config_hash: z.string(),
  config_json: JsonValueSchema,
});

const DeletedAgentRowSchema = z.object({
  id: z.string(),
});

const SetupAgentRowSchema = StoredAgentRowSchema.extend({
  status: z.string(),
  created_by_user_id: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type StoredAgentRow = z.infer<typeof StoredAgentRowSchema>;
export type StoredAgentGatewayConfigRow = z.infer<typeof StoredAgentGatewayConfigRowSchema>;
export type SetupAgentRow = z.infer<typeof SetupAgentRowSchema>;

const SETUP_AGENT_SELECT =
  "id,workspace_id,name,status,type,context,model_settings,tool_policy,created_by_user_id,updated_at" as const;
const STORED_AGENT_SELECT = "id,name,workspace_id,type,context,model_settings,tool_policy" as const;
const STORED_AGENT_GATEWAY_CONFIG_SELECT = "id,scope_id,version,config_hash,config_json" as const;

function clientForAccessToken(accessToken?: string) {
  return accessToken ? getUserScopedSupabase(accessToken) : getServiceRoleSupabase();
}

function toDatabaseJson(value: ModelSettings | ToolPolicy): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export async function listStoredAgentRows(accessToken?: string): Promise<StoredAgentRow[]> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "listStoredAgentRows",
      table: "agent",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: accessToken ? "user_scoped" : "service_role",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("agent")
        .select(STORED_AGENT_SELECT)
        .order("updated_at", { ascending: false });

      if (error) throw normalizeSupabaseError("agent query", error);
      return parseSupabaseRows("agent query", StoredAgentRowSchema, data);
    },
  );
}

export async function findStoredAgentRowById(accessToken: string, agentId: string): Promise<StoredAgentRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "findStoredAgentRowById",
      table: "agent",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("agent")
        .select(STORED_AGENT_SELECT)
        .eq("id", agentId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("agent query", error);
      return parseNullableSupabaseRow("agent query", StoredAgentRowSchema, data);
    },
  );
}

export async function listSetupAgentRows(accessToken: string): Promise<SetupAgentRow[]> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "listSetupAgentRows",
      table: "agent",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("agent")
        .select(SETUP_AGENT_SELECT)
        .order("updated_at", { ascending: false });

      if (error) throw normalizeSupabaseError("agent query", error);
      return parseSupabaseRows("agent query", SetupAgentRowSchema, data);
    },
  );
}

export async function findSetupAgentById(accessToken: string, agentId: string): Promise<SetupAgentRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "findSetupAgentById",
      table: "agent",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("agent")
        .select(SETUP_AGENT_SELECT)
        .eq("id", agentId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("agent query", error);
      return parseNullableSupabaseRow("agent query", SetupAgentRowSchema, data);
    },
  );
}

export async function createSetupAgent(input: {
  accessToken: string;
  workspaceId: string;
  userId: string;
  name: string;
  type: string;
  modelSettings: ModelSettings;
  toolPolicy: ToolPolicy;
  status: string;
}): Promise<SetupAgentRow> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "createSetupAgent",
      table: "agent",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: "user_scoped",
      workspaceId: input.workspaceId,
    },
    async () => {
      const modelSettings = ModelSettingsSchema.parse(input.modelSettings);
      const toolPolicy = ToolPolicySchema.parse(input.toolPolicy);
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("agent")
        .insert({
          workspace_id: input.workspaceId,
          created_by_user_id: input.userId,
          name: input.name,
          type: input.type,
          model_settings: toDatabaseJson(modelSettings),
          tool_policy: toDatabaseJson(toolPolicy),
          status: input.status,
        })
        .select(SETUP_AGENT_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("agent insert", error);
      return parseSupabaseRow("agent insert", SetupAgentRowSchema, data);
    },
  );
}

export async function updateSetupAgent(input: {
  accessToken: string;
  agentId: string;
  name: string;
  type: string;
  modelSettings: ModelSettings;
  toolPolicy: ToolPolicy;
}): Promise<SetupAgentRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "updateSetupAgent",
      table: "agent",
      operation: "update",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const modelSettings = ModelSettingsSchema.parse(input.modelSettings);
      const toolPolicy = ToolPolicySchema.parse(input.toolPolicy);
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("agent")
        .update({
          name: input.name,
          type: input.type,
          model_settings: toDatabaseJson(modelSettings),
          tool_policy: toDatabaseJson(toolPolicy),
        })
        .eq("id", input.agentId)
        .select(SETUP_AGENT_SELECT)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("agent update", error);
      return parseNullableSupabaseRow("agent update", SetupAgentRowSchema, data);
    },
  );
}

export async function createStoredAgentRow(input: {
  accessToken?: string;
  workspaceId: string;
  userId: string;
  name: string;
  type: string;
  context: string | null;
  modelSettings: ModelSettings;
  toolPolicy: ToolPolicy;
}) {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "createStoredAgentRow",
      table: "agent",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: input.accessToken ? "user_scoped" : "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const modelSettings = ModelSettingsSchema.parse(input.modelSettings);
      const toolPolicy = ToolPolicySchema.parse(input.toolPolicy);
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("agent")
        .insert({
          name: input.name,
          workspace_id: input.workspaceId,
          created_by_user_id: input.userId,
          type: input.type,
          context: input.context,
          model_settings: toDatabaseJson(modelSettings),
          tool_policy: toDatabaseJson(toolPolicy),
          status: "active",
        })
        .select(STORED_AGENT_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("agent insert", error);
      return parseNullableSupabaseRow("agent insert", StoredAgentRowSchema, data);
    },
  );
}

export async function updateStoredAgentRow(input: {
  accessToken: string;
  agentId: string;
  name: string;
  type: string;
  context: string | null;
  modelSettings: ModelSettings;
  toolPolicy: ToolPolicy;
}): Promise<StoredAgentRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "updateStoredAgentRow",
      table: "agent",
      operation: "update",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const modelSettings = ModelSettingsSchema.parse(input.modelSettings);
      const toolPolicy = ToolPolicySchema.parse(input.toolPolicy);
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("agent")
        .update({
          name: input.name,
          type: input.type,
          context: input.context,
          model_settings: toDatabaseJson(modelSettings),
          tool_policy: toDatabaseJson(toolPolicy),
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.agentId)
        .select(STORED_AGENT_SELECT)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("agent update", error);
      return parseNullableSupabaseRow("agent update", StoredAgentRowSchema, data);
    },
  );
}

export async function deleteStoredAgentRow(input: { accessToken: string; agentId: string }): Promise<boolean> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "deleteStoredAgentRow",
      table: "agent",
      operation: "delete",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("agent")
        .delete()
        .eq("id", input.agentId)
        .select("id")
        .maybeSingle();

      if (error) throw normalizeSupabaseError("agent delete", error);
      return parseNullableSupabaseRow("agent delete", DeletedAgentRowSchema, data) !== null;
    },
  );
}

export async function listStoredAgentGatewayConfigRows(
  agentIds: string[],
  accessToken?: string,
): Promise<StoredAgentGatewayConfigRow[]> {
  if (agentIds.length === 0) return [];

  return withRepositoryLogging(
    {
      repository: "agents",
      method: "listStoredAgentGatewayConfigRows",
      table: "gateway_config",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: accessToken ? "user_scoped" : "service_role",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("gateway_config")
        .select(STORED_AGENT_GATEWAY_CONFIG_SELECT)
        .eq("scope_type", "agent")
        .in("scope_id", agentIds);

      if (error) throw normalizeSupabaseError("gateway_config query", error);
      return parseSupabaseRows("gateway_config query", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function getStoredAgentGatewayConfig(
  accessToken: string,
  agentId: string,
): Promise<StoredAgentGatewayConfigRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "getStoredAgentGatewayConfig",
      table: "gateway_config",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("gateway_config")
        .select(STORED_AGENT_GATEWAY_CONFIG_SELECT)
        .eq("scope_type", "agent")
        .eq("scope_id", agentId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("gateway_config query", error);
      return parseNullableSupabaseRow("gateway_config query", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function getWorkspaceGatewayConfig(
  accessToken: string | undefined,
  workspaceId: string,
): Promise<StoredAgentGatewayConfigRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "getWorkspaceGatewayConfig",
      table: "gateway_config",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: accessToken ? "user_scoped" : "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await clientForAccessToken(accessToken)
        .from("gateway_config")
        .select(STORED_AGENT_GATEWAY_CONFIG_SELECT)
        .eq("scope_type", "workspace")
        .eq("scope_id", workspaceId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("gateway_config query", error);
      return parseNullableSupabaseRow("gateway_config query", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function createStoredAgentGatewayConfig(input: {
  accessToken: string;
  agentId: string;
  userId: string;
  configHash: string;
  configJson: Json;
}): Promise<StoredAgentGatewayConfigRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "createStoredAgentGatewayConfig",
      table: "gateway_config",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: "user_scoped",
    },
    async () => {
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("gateway_config")
        .insert({
          scope_type: "agent",
          scope_id: input.agentId,
          version: 1,
          config_hash: input.configHash,
          config_json: input.configJson,
          updated_by: input.userId,
        })
        .select(STORED_AGENT_GATEWAY_CONFIG_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("gateway_config insert", error);
      return parseNullableSupabaseRow("gateway_config insert", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function createWorkspaceGatewayConfig(input: {
  accessToken?: string;
  workspaceId: string;
  userId: string;
  configHash: string;
  configJson: Json;
}): Promise<StoredAgentGatewayConfigRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "createWorkspaceGatewayConfig",
      table: "gateway_config",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: input.accessToken ? "user_scoped" : "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await clientForAccessToken(input.accessToken)
        .from("gateway_config")
        .insert({
          scope_type: "workspace",
          scope_id: input.workspaceId,
          version: 1,
          config_hash: input.configHash,
          config_json: input.configJson,
          updated_by: input.userId,
        })
        .select(STORED_AGENT_GATEWAY_CONFIG_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("gateway_config insert", error);
      return parseNullableSupabaseRow("gateway_config insert", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function updateStoredAgentGatewayConfig(input: {
  accessToken?: string;
  gatewayConfigId: string;
  userId: string;
  version: number;
  configHash: string;
  configJson: Json;
  expectedVersion?: number;
  expectedConfigHash?: string;
}): Promise<StoredAgentGatewayConfigRow | null> {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "updateStoredAgentGatewayConfig",
      table: "gateway_config",
      operation: "update",
      expectedCardinality: "zero_or_one",
      access: input.accessToken ? "user_scoped" : "service_role",
    },
    async () => {
      let query = clientForAccessToken(input.accessToken)
        .from("gateway_config")
        .update({
          version: input.version,
          config_hash: input.configHash,
          config_json: input.configJson,
          updated_by: input.userId,
        })
        .eq("id", input.gatewayConfigId);

      if (typeof input.expectedVersion === "number") {
        query = query.eq("version", input.expectedVersion);
      }
      if (typeof input.expectedConfigHash === "string") {
        query = query.eq("config_hash", input.expectedConfigHash);
      }

      const { data, error } = await query.select(STORED_AGENT_GATEWAY_CONFIG_SELECT).maybeSingle();

      if (error) throw normalizeSupabaseError("gateway_config update", error);
      return parseNullableSupabaseRow("gateway_config update", StoredAgentGatewayConfigRowSchema, data);
    },
  );
}

export async function createStoredAgentGatewayConfigVersion(input: {
  accessToken?: string;
  gatewayConfigId: string;
  userId: string;
  version: number;
  configHash: string;
  configJson: Json;
  changeSummary: Json;
}) {
  return withRepositoryLogging(
    {
      repository: "agents",
      method: "createStoredAgentGatewayConfigVersion",
      table: "gateway_config_versions",
      operation: "insert",
      expectedCardinality: "write_only",
      access: input.accessToken ? "user_scoped" : "service_role",
    },
    async () => {
      const { error } = await clientForAccessToken(input.accessToken).from("gateway_config_versions").insert({
        gateway_config_id: input.gatewayConfigId,
        version: input.version,
        config_hash: input.configHash,
        config_json: input.configJson,
        created_by: input.userId,
        change_summary: input.changeSummary,
      });

      if (error) throw normalizeSupabaseError("gateway_config_versions insert", error);
    },
  );
}
