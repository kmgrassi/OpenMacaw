import {
  ModelSettingsSchema,
  ToolPolicySchema,
  type ModelSettings,
  type ToolPolicy,
} from "../../../../../contracts/agents.js";
import { normalizeSupabaseError } from "../../supabase-client.js";
import { parseNullableSupabaseRow, parseSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { withRepositoryLogging } from "../logging.js";

import {
  DeletedAgentRowSchema,
  SETUP_AGENT_SELECT,
  STORED_AGENT_SELECT,
  SetupAgentRowSchema,
  StoredAgentRowSchema,
  clientForAccessToken,
  toDatabaseJson,
  type SetupAgentRow,
  type StoredAgentRow,
} from "./shared.js";

export type { SetupAgentRow, StoredAgentRow } from "./shared.js";

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
