import { z } from "zod";

export const ExecutionKindSchema = z.enum([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "git",
  "api",
  "custom",
]);

export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const FilesystemReadExecutionConfigSchema = z.object({
  allowedPaths: z.array(z.string()).optional(),
  maxFileSizeBytes: z.number().int().positive().optional(),
});

export const FilesystemWriteExecutionConfigSchema = z.object({
  allowedPaths: z.array(z.string()).optional(),
  requireConfirmation: z.boolean().optional(),
});

export const ShellExecutionConfigSchema = z.object({
  commandTemplate: z.string().trim().min(1),
  allowedCommands: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const GitOperationSchema = z.enum([
  "status",
  "diff",
  "log",
  "branch",
  "commit",
  "push",
]);

export const GitExecutionConfigSchema = z.object({
  allowedOperations: z.array(GitOperationSchema).min(1),
});

export const ApiExecutionConfigSchema = z.object({
  urlTemplate: z.string().trim().min(1),
  method: z.string().trim().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

export const CustomExecutionConfigSchema = z.object({
  handler: z.string().trim().min(1),
  config: JsonObjectSchema,
});

export const ExecutionConfigSchema = z.union([
  FilesystemReadExecutionConfigSchema,
  FilesystemWriteExecutionConfigSchema,
  ShellExecutionConfigSchema,
  GitExecutionConfigSchema,
  ApiExecutionConfigSchema,
  CustomExecutionConfigSchema,
  JsonObjectSchema,
]);

export const ToolDefinitionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  slug: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  description: z.string(),
  parameters: JsonObjectSchema,
  examples: z.array(z.unknown()),
  executionKind: z.string().trim().min(1).nullable(),
  runnerKind: z.string().trim().min(1).nullable(),
  enabled: z.boolean(),
});

export const AgentToolBundleNameSchema = z.enum([
  ":planner",
  ":manager",
  ":learning",
  ":coding",
  ":repo_read",
  ":repo_write",
]);

export const ToolBundleSlugSchema = z.enum([
  "planner",
  "manager",
  "learning",
  "coding",
  "repo_read",
  "repo_write",
  "local_model_coding",
]);

export const ToolBundleSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  slug: ToolBundleSlugSchema.or(z.string().trim().min(1).max(128)),
  name: z.string().trim().min(1).max(256),
  description: z.string(),
  systemManaged: z.boolean(),
  enabled: z.boolean(),
});

export const ToolPolicyTemplateSlugSchema = z.enum([
  "planner",
  "manager",
  "learning",
  "coding",
  "repo_read",
  "repo_write",
  "local_model_coding",
]);

export const ToolPolicyTemplateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  slug: ToolPolicyTemplateSlugSchema.or(z.string().trim().min(1).max(128)),
  name: z.string().trim().min(1).max(256),
  description: z.string(),
  systemManaged: z.boolean(),
  enabled: z.boolean(),
});

export const ToolPolicyTemplateToolSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  templateId: z.string().uuid(),
  toolId: z.string().uuid(),
});

export const AgentToolGrantModeSchema = z.enum(["include", "exclude"]);

export const AgentToolGrantSourceSchema = z.enum([
  "template",
  "manual",
  "system",
  "migration",
]);

export const AgentToolGrantSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  toolId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  mode: AgentToolGrantModeSchema,
  source: AgentToolGrantSourceSchema,
  sourceToolTemplateId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
});

export const AgentToolOverrideSourceSchema = z.enum([
  "bundle",
  "include",
  "exclude",
  "template",
  "manual",
  "system",
  "migration",
]);

export const ResolvedAgentToolSchema = ToolDefinitionSchema.extend({
  source: AgentToolOverrideSourceSchema,
  enabledForAgent: z.boolean(),
});

export const NormalizedAgentToolSourceSchema = z.enum([
  "bundle",
  "include_override",
  "exclude_override",
]);

export const NormalizedResolvedAgentToolSchema = ToolDefinitionSchema.extend({
  enabledForAgent: z.boolean(),
  source: NormalizedAgentToolSourceSchema,
  bundleIds: z.array(z.string().uuid()),
  bundleSlugs: z.array(
    ToolBundleSlugSchema.or(z.string().trim().min(1).max(128)),
  ),
});

export const AgentToolOverrideModeSchema = z.enum(["include", "exclude"]);

export const AgentToolOverrideSchema = z.object({
  agentId: z.string().uuid(),
  toolId: z.string().uuid(),
  mode: AgentToolOverrideModeSchema,
  reason: z.string().nullable(),
});

export const OpenAIToolSpecSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: JsonObjectSchema,
  }),
});

export const AnthropicToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: JsonObjectSchema,
});

export const GenericProviderToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: JsonObjectSchema,
});

export const GenericToolSpecSchema = GenericProviderToolSpecSchema;

export const ProviderToolSpecSchema = z.union([
  OpenAIToolSpecSchema,
  AnthropicToolSpecSchema,
  GenericToolSpecSchema,
]);

export const ToolDefinitionListResponseSchema = z.object({
  tools: z.array(ToolDefinitionSchema),
});

export const AgentToolSettingsResponseSchema = z.object({
  templates: z.array(ToolPolicyTemplateSchema),
  availableTools: z.array(ToolDefinitionSchema),
  grants: z.array(AgentToolGrantSchema),
  tools: z.array(ResolvedAgentToolSchema),
});

export const ResolvedAgentToolListResponseSchema = z.object({
  bundles: z.array(AgentToolBundleNameSchema),
  tools: z.array(ResolvedAgentToolSchema),
});

export const ToolDefinitionResponseSchema = z.object({
  tool: ToolDefinitionSchema,
});

export const CreateToolDefinitionRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  slug: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  description: z.string().optional().default(""),
  parameters: JsonObjectSchema.optional().default({}),
  examples: z.array(z.unknown()).optional().default([]),
  executionKind: z.string().trim().min(1).nullable().optional().default(null),
  runnerKind: z.string().trim().min(1).nullable().optional().default(null),
});

export const UpdateToolDefinitionRequestSchema =
  CreateToolDefinitionRequestSchema.pick({
    workspaceId: true,
  })
    .extend({
      slug: z.string().trim().min(1).max(128).optional(),
      name: z.string().trim().min(1).max(256).optional(),
      description: z.string().optional(),
      parameters: JsonObjectSchema.optional(),
      examples: z.array(z.unknown()).optional(),
      executionKind: z.string().trim().min(1).nullable().optional(),
      runnerKind: z.string().trim().min(1).nullable().optional(),
    })
    .refine(
      (value) => Object.keys(value).some((key) => key !== "workspaceId"),
      {
        message: "At least one tool field must be provided",
      },
    );

export const AssignAgentToolRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  toolId: z.string().uuid(),
});

export const AgentToolOverrideRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  toolName: z.string().trim().min(1).max(128),
});

export const ReplaceAgentToolBundlesRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  bundles: z.array(AgentToolBundleNameSchema),
});

export const ApplyToolPolicyTemplateRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const UpsertAgentToolGrantRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  mode: AgentToolGrantModeSchema,
  reason: z.string().trim().max(512).nullable().optional(),
});

export const ReorderAgentToolsRequestSchema = z.object({
  toolIds: z.array(z.string().uuid()),
});

export const AppendToolExamplesRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    examples: z.array(z.unknown()).min(1).optional(),
    example: z.unknown().optional(),
  })
  .refine(
    (value) => value.examples !== undefined || value.example !== undefined,
    {
      message: "examples or example is required",
    },
  )
  .transform((value) => ({
    workspaceId: value.workspaceId,
    examples: value.examples ?? [value.example],
  }));

export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type FilesystemReadExecutionConfig = z.infer<
  typeof FilesystemReadExecutionConfigSchema
>;
export type FilesystemWriteExecutionConfig = z.infer<
  typeof FilesystemWriteExecutionConfigSchema
>;
export type ShellExecutionConfig = z.infer<typeof ShellExecutionConfigSchema>;
export type GitOperation = z.infer<typeof GitOperationSchema>;
export type GitExecutionConfig = z.infer<typeof GitExecutionConfigSchema>;
export type ApiExecutionConfig = z.infer<typeof ApiExecutionConfigSchema>;
export type CustomExecutionConfig = z.infer<typeof CustomExecutionConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type AgentToolBundleName = z.infer<typeof AgentToolBundleNameSchema>;
export type ToolBundleSlug = z.infer<typeof ToolBundleSlugSchema>;
export type ToolBundle = z.infer<typeof ToolBundleSchema>;
export type ToolPolicyTemplateSlug = z.infer<
  typeof ToolPolicyTemplateSlugSchema
>;
export type ToolPolicyTemplate = z.infer<typeof ToolPolicyTemplateSchema>;
export type ToolPolicyTemplateTool = z.infer<
  typeof ToolPolicyTemplateToolSchema
>;
export type AgentToolGrantMode = z.infer<typeof AgentToolGrantModeSchema>;
export type AgentToolGrantSource = z.infer<typeof AgentToolGrantSourceSchema>;
export type AgentToolGrant = z.infer<typeof AgentToolGrantSchema>;
export type AgentToolOverrideSource = z.infer<
  typeof AgentToolOverrideSourceSchema
>;
export type ResolvedAgentTool = z.infer<typeof ResolvedAgentToolSchema>;
export type NormalizedAgentToolSource = z.infer<
  typeof NormalizedAgentToolSourceSchema
>;
export type NormalizedResolvedAgentTool = z.infer<
  typeof NormalizedResolvedAgentToolSchema
>;
export type AgentToolOverrideMode = z.infer<typeof AgentToolOverrideModeSchema>;
export type AgentToolOverride = z.infer<typeof AgentToolOverrideSchema>;
export type ToolDefinitionListResponse = z.infer<
  typeof ToolDefinitionListResponseSchema
>;
export type AgentToolSettingsResponse = z.infer<
  typeof AgentToolSettingsResponseSchema
>;
export type ResolvedAgentToolListResponse = z.infer<
  typeof ResolvedAgentToolListResponseSchema
>;
export type ToolDefinitionResponse = z.infer<
  typeof ToolDefinitionResponseSchema
>;
export type OpenAIToolSpec = z.infer<typeof OpenAIToolSpecSchema>;
export type AnthropicToolSpec = z.infer<typeof AnthropicToolSpecSchema>;
export type GenericProviderToolSpec = z.infer<
  typeof GenericProviderToolSpecSchema
>;
export type GenericToolSpec = z.infer<typeof GenericToolSpecSchema>;
export type ProviderToolSpec = z.infer<typeof ProviderToolSpecSchema>;
export type CreateToolDefinitionRequest = z.input<
  typeof CreateToolDefinitionRequestSchema
>;
export type UpdateToolDefinitionRequest = z.infer<
  typeof UpdateToolDefinitionRequestSchema
>;
export type AppendToolExamplesRequest = z.infer<
  typeof AppendToolExamplesRequestSchema
>;
export type AssignAgentToolRequest = z.infer<
  typeof AssignAgentToolRequestSchema
>;
export type AgentToolOverrideRequest = z.infer<
  typeof AgentToolOverrideRequestSchema
>;
export type ReplaceAgentToolBundlesRequest = z.infer<
  typeof ReplaceAgentToolBundlesRequestSchema
>;
export type ApplyToolPolicyTemplateRequest = z.infer<
  typeof ApplyToolPolicyTemplateRequestSchema
>;
export type UpsertAgentToolGrantRequest = z.infer<
  typeof UpsertAgentToolGrantRequestSchema
>;
export type ReorderAgentToolsRequest = z.infer<
  typeof ReorderAgentToolsRequestSchema
>;
