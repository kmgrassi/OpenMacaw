import type { Json } from "@kmgrassi/supabase-schema";

import { normalizeSupabaseError } from "../../supabase-client.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { withRepositoryLogging } from "../logging.js";

import {
  STORED_AGENT_GATEWAY_CONFIG_SELECT,
  StoredAgentGatewayConfigRowSchema,
  clientForAccessToken,
  type StoredAgentGatewayConfigRow,
} from "./shared.js";

export type { StoredAgentGatewayConfigRow } from "./shared.js";

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
