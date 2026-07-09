import { z } from "zod";
import { ModelSettingsSchema, ToolPolicySchema } from "./agents.js";

export const LauncherDatabaseHealthSchema = z.object({
  configured: z.boolean(),
  started: z.boolean(),
  connected: z.boolean(),
  status: z.string(),
  source: z.string().nullable(),
  last_error: z.string().nullable(),
});

export const LauncherHealthSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  database: LauncherDatabaseHealthSchema.optional(),
});

export const LauncherHealthResponseSchema = LauncherHealthSchema;

export const LauncherAgentSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  workspace_id: z.string().nullable(),
  project_id: z.string().nullable(),
  description: z.string().nullable(),
  slug: z.string().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  session_id: z.string().nullable(),
  context: z.string().nullable(),
  is_active: z.boolean().nullable(),
  model_settings: ModelSettingsSchema,
  tool_policy: ToolPolicySchema,
  has_credentials: z.boolean(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const LauncherAgentListResponseSchema = z.object({
  data: z.array(LauncherAgentSchema),
});

export const LauncherAgentResponseSchema = z.object({
  data: LauncherAgentSchema,
});

export const LauncherStoredCredentialSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  provider: z.string().nullable(),
  label: z.string(),
  env_var: z.string(),
  updated_at: z.string().nullable(),
  launchable_kind: z.string().nullable(),
  has_secret: z.boolean(),
});

export const LauncherStoredCredentialListResponseSchema = z.object({
  data: z.array(LauncherStoredCredentialSchema),
});

export const LauncherOrchestratorSchema = z.object({
  id: z.string(),
  port: z.number(),
  config: z.record(z.string(), z.unknown()),
  started_at: z.string(),
  status: z.string(),
  reused: z.boolean(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  restart_count: z.number().optional(),
});

export const LauncherOrchestratorResponseSchema = z.object({
  data: LauncherOrchestratorSchema,
});

export const LauncherOrchestratorListResponseSchema = z.object({
  data: z.array(LauncherOrchestratorSchema),
});

export type LauncherHealthResponse = z.infer<
  typeof LauncherHealthResponseSchema
>;
export type LauncherDatabaseHealth = z.infer<
  typeof LauncherDatabaseHealthSchema
>;
export type LauncherAgent = z.infer<typeof LauncherAgentSchema>;
export type LauncherAgentListResponse = z.infer<
  typeof LauncherAgentListResponseSchema
>;
export type LauncherAgentResponse = z.infer<typeof LauncherAgentResponseSchema>;
export type LauncherStoredCredential = z.infer<
  typeof LauncherStoredCredentialSchema
>;
export type LauncherStoredCredentialListResponse = z.infer<
  typeof LauncherStoredCredentialListResponseSchema
>;
export type LauncherOrchestrator = z.infer<typeof LauncherOrchestratorSchema>;
export type LauncherOrchestratorResponse = z.infer<
  typeof LauncherOrchestratorResponseSchema
>;
export type LauncherOrchestratorListResponse = z.infer<
  typeof LauncherOrchestratorListResponseSchema
>;
