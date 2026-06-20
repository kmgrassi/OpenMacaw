import { z } from "zod";
import {
  CapabilityRequirementsSchema,
  LocalModelCodingRunnerKindSchema,
  WorkspacePolicySchema,
} from "./local-model-coding.js";
import { KnownExecutionProviderSchema } from "./provider-registry.js";
import { ModelTierSchema, RegisteredProviderSchema } from "./model-tiers.js";
import { RUNNER_KINDS } from "./runner-kinds.js";
import { ToolDefinitionSchema } from "./tool-definition.js";
export { KnownExecutionProviderSchema } from "./provider-registry.js";
export { ModelTierSchema, RegisteredProviderSchema } from "./model-tiers.js";

export const AgentRoleSchema = z.enum([
  "planning",
  "coding",
  "manager",
  "learning",
  "router",
  "learning",
  "custom",
]);

export const RunnerKindSchema = z.enum(RUNNER_KINDS);

export const ExecutionProviderSchema = z
  .string()
  .trim()
  .min(1)
  .pipe(KnownExecutionProviderSchema);

export const ToolProfileSchema = z.enum([
  "planning",
  "coding",
  "manager",
  "learning",
  "router",
  "none",
]);

export const CredentialReferenceSchema = z.object({
  type: z.enum(["credential_id", "alias"]),
  value: z.string().trim().min(1),
});

export const ExecutionProfileCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  toolCalls: z.boolean(),
  workspaceWrite: z.boolean(),
  structuredOutput: z.boolean(),
  interrupt: z.boolean(),
});

export const ExecutionProfileAdapterConfigSchema = z.record(
  z.string(),
  z.unknown(),
);
export const ExecutionProfileSourceMetadataSchema = z.record(
  z.string(),
  z.unknown(),
);

export const ExecutionProfileFallbackSchema = z.object({
  provider: RegisteredProviderSchema,
  model: z.string().trim().min(1),
  credentialRef: CredentialReferenceSchema.optional(),
});

export const WorkspaceSandboxSchema = z.enum(["read_only", "workspace_write"]);

export const ApprovalPolicySchema = z.enum([
  "never",
  "on_request",
  "on_failure",
  "untrusted",
]);

export const RuntimeWorkspacePolicySchema = z.object({
  sandbox: WorkspaceSandboxSchema,
  approvalPolicy: ApprovalPolicySchema,
});

export const RuntimeExecutionTargetKindSchema = z.enum([
  "local_helper",
  "container",
]);

export const RepositorySourceTypeSchema = z.enum([
  "git_ref",
  "workspace_snapshot",
]);

export const RuntimeRepositoryRefSchema = z
  .object({
    type: RepositorySourceTypeSchema,
    branch: z.string().trim().min(1).optional(),
    ref: z.string().trim().min(1).optional(),
    commitSha: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "workspace_snapshot") return;
    if (value.branch || value.ref || value.commitSha) return;

    ctx.addIssue({
      code: "custom",
      message: "git_ref repository sources require branch, ref, or commitSha",
      path: ["ref"],
    });
  });

export const RuntimeRepositorySourceSchema = RuntimeRepositoryRefSchema.extend({
  repositoryUrl: z.string().trim().min(1),
});

export const ContainerDispatchLimitsSchema = z.object({
  timeoutMs: z.number().int().positive(),
  maxCpuCores: z.number().positive(),
  maxMemoryMb: z.number().int().positive(),
  maxDiskMb: z.number().int().positive(),
  maxProcessCount: z.number().int().positive(),
});

export const ArtifactRetentionSchema = z.object({
  retainDays: z.number().int().positive(),
  storeCommandOutput: z.boolean(),
  storePatchArtifact: z.boolean(),
});

export const ContainerArtifactStoreSchema = z.object({
  type: z.literal("s3"),
  bucket: z.string().trim().min(1),
  prefix: z.string().trim().min(1),
  kmsKeyArn: z.string().trim().min(1).optional(),
});

export const RuntimeArtifactKindSchema = z.enum([
  "summary",
  "command_log",
  "patch",
  "workspace_snapshot",
  "diagnostic",
]);

export const RuntimeArtifactSchema = z.object({
  kind: RuntimeArtifactKindSchema,
  uri: z.string().trim().min(1),
  contentType: z.string().trim().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().trim().min(1).optional(),
});

export const RuntimeFailureSurfaceSchema = z.object({
  phase: z.enum([
    "bootstrap",
    "credential_resolution",
    "clone",
    "tool_execution",
    "artifact_write",
    "review_handoff",
    "cleanup",
  ]),
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  retryable: z.boolean(),
  artifactUri: z.string().trim().min(1).optional(),
});

export const ReviewHandoffPolicySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["patch_artifact", "branch_pr"]),
  baseBranch: z.string().trim().min(1).optional(),
});

export const NetworkPolicySchema = z.object({
  mode: z.enum(["deny_all", "allowlist"]),
  allowedHosts: z.array(z.string().trim().min(1)),
});

export const ExecutionResourceAccessModeSchema = z.enum(["read", "write"]);

export const ExecutionResourceRequirementSchema = z.enum([
  "required",
  "optional",
]);

export const RuntimeExecutionResourceSchema = z.object({
  grantId: z.string().uuid(),
  resourceId: z.string().uuid(),
  resourceType: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  providerUrl: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable(),
  alias: z.string().trim().min(1),
  credentialRef: CredentialReferenceSchema.nullable(),
  accessMode: ExecutionResourceAccessModeSchema,
  requirement: ExecutionResourceRequirementSchema,
  repositoryRef: RuntimeRepositoryRefSchema.optional(),
  networkPolicy: NetworkPolicySchema,
});

export const ContainerExecutionDispatchMetadataSchema = z.object({
  workspaceId: z.string().uuid(),
  sessionId: z.string().trim().min(1),
  resources: z.array(RuntimeExecutionResourceSchema).min(1),
  limits: ContainerDispatchLimitsSchema,
  artifactRetention: ArtifactRetentionSchema,
  artifactStore: ContainerArtifactStoreSchema.optional(),
  reviewHandoff: ReviewHandoffPolicySchema.optional(),
  networkPolicy: NetworkPolicySchema,
});

export const LocalHelperExecutionTargetSchema = z.object({
  kind: z.literal("local_helper"),
  workspaceId: z.string().uuid(),
  runnerKind: z.union([LocalModelCodingRunnerKindSchema, z.literal("planner")]),
  machineId: z.string().uuid(),
  workspaceRootRef: z.string().trim().min(1),
  /**
   * Absolute path the user picked in the agent settings UI. The runtime
   * will operate inside this directory when honoring this dispatch
   * target. Optional — when absent, the agent has no configured
   * workspace and the runtime should fail workspace-requiring tool
   * calls with a clear "no workspace" message.
   */
  workspaceRoot: z.string().trim().min(1).optional(),
});

export const ContainerExecutionTargetSchema = z.object({
  kind: z.literal("container"),
  metadata: ContainerExecutionDispatchMetadataSchema,
});

export const RuntimeExecutionTargetSchema = z.discriminatedUnion("kind", [
  LocalHelperExecutionTargetSchema,
  ContainerExecutionTargetSchema,
]);

export const ExecutionProfileSchema = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: AgentRoleSchema,
  runnerKind: RunnerKindSchema,
  provider: ExecutionProviderSchema,
  model: z.string().trim().min(1),
  credentialRef: CredentialReferenceSchema.nullable(),
  fallbacks: z.array(ExecutionProfileFallbackSchema).default([]),
  modelTierFloor: ModelTierSchema.default("any"),
  toolProfile: ToolProfileSchema,
  workspacePolicy: WorkspacePolicySchema.optional(),
  capabilityRequirements: CapabilityRequirementsSchema.optional(),
  toolDefinitions: z.array(ToolDefinitionSchema).optional(),
  adapterConfig: ExecutionProfileAdapterConfigSchema.optional(),
  sourceMetadata: ExecutionProfileSourceMetadataSchema.optional(),
  capabilities: ExecutionProfileCapabilitiesSchema,
});

export const RuntimeDispatchContextSchema = z.object({
  executionProfile: ExecutionProfileSchema,
  workspacePolicy: RuntimeWorkspacePolicySchema,
  executionTarget: RuntimeExecutionTargetSchema,
  toolAssignments: z.array(ToolDefinitionSchema),
});

export const ExecutionProfileMissingRequirementSchema = z.enum([
  "agent",
  "credential",
  "model",
  "gateway_config",
  "runner",
  "provider",
  "route",
]);

export const ExecutionProfileSourceSchema = z.object({
  routingRuleId: z.string().uuid().nullable(),
  credentialAlias: z.string().nullable(),
  fallbackUsed: z.boolean(),
  legacyGatewayConfigUsed: z.boolean(),
});

export const ExecutionProfileResolutionSchema = z.object({
  agent: z
    .object({
      agentId: z.string().uuid(),
      workspaceId: z.string().uuid().nullable(),
      role: AgentRoleSchema,
    })
    .nullable(),
  profile: ExecutionProfileSchema.nullable(),
  missing: z.array(ExecutionProfileMissingRequirementSchema),
  source: ExecutionProfileSourceSchema,
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type { RunnerKind } from "./runner-kinds.js";
export type KnownExecutionProvider = z.infer<
  typeof KnownExecutionProviderSchema
>;
export type ExecutionProvider = z.infer<typeof ExecutionProviderSchema>;
export type ToolProfile = z.infer<typeof ToolProfileSchema>;
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;
export type ExecutionProfileCapabilities = z.infer<
  typeof ExecutionProfileCapabilitiesSchema
>;
export type ExecutionProfileAdapterConfig = z.infer<
  typeof ExecutionProfileAdapterConfigSchema
>;
export type ExecutionProfileSourceMetadata = z.infer<
  typeof ExecutionProfileSourceMetadataSchema
>;
export type ExecutionProfileFallback = z.infer<
  typeof ExecutionProfileFallbackSchema
>;
export type WorkspaceSandbox = z.infer<typeof WorkspaceSandboxSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type RuntimeWorkspacePolicy = z.infer<
  typeof RuntimeWorkspacePolicySchema
>;
export type RuntimeExecutionTargetKind = z.infer<
  typeof RuntimeExecutionTargetKindSchema
>;
export type RepositorySourceType = z.infer<typeof RepositorySourceTypeSchema>;
export type RuntimeRepositoryRef = z.infer<typeof RuntimeRepositoryRefSchema>;
export type RuntimeRepositorySource = z.infer<
  typeof RuntimeRepositorySourceSchema
>;
export type ContainerDispatchLimits = z.infer<
  typeof ContainerDispatchLimitsSchema
>;
export type ArtifactRetention = z.infer<typeof ArtifactRetentionSchema>;
export type ContainerArtifactStore = z.infer<
  typeof ContainerArtifactStoreSchema
>;
export type RuntimeArtifactKind = z.infer<typeof RuntimeArtifactKindSchema>;
export type RuntimeArtifact = z.infer<typeof RuntimeArtifactSchema>;
export type RuntimeFailureSurface = z.infer<typeof RuntimeFailureSurfaceSchema>;
export type ReviewHandoffPolicy = z.infer<typeof ReviewHandoffPolicySchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type ExecutionResourceAccessMode = z.infer<
  typeof ExecutionResourceAccessModeSchema
>;
export type ExecutionResourceRequirement = z.infer<
  typeof ExecutionResourceRequirementSchema
>;
export type RuntimeExecutionResource = z.infer<
  typeof RuntimeExecutionResourceSchema
>;
export type ContainerExecutionDispatchMetadata = z.infer<
  typeof ContainerExecutionDispatchMetadataSchema
>;
export type LocalHelperExecutionTarget = z.infer<
  typeof LocalHelperExecutionTargetSchema
>;
export type ContainerExecutionTarget = z.infer<
  typeof ContainerExecutionTargetSchema
>;
export type RuntimeExecutionTarget = z.infer<
  typeof RuntimeExecutionTargetSchema
>;
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type RuntimeDispatchContext = z.infer<
  typeof RuntimeDispatchContextSchema
>;
export type ExecutionProfileMissingRequirement = z.infer<
  typeof ExecutionProfileMissingRequirementSchema
>;
export type ExecutionProfileSource = z.infer<
  typeof ExecutionProfileSourceSchema
>;
export type ExecutionProfileResolution = z.infer<
  typeof ExecutionProfileResolutionSchema
>;

export function deriveExecutionProviderFromModel(
  model: string | null | undefined,
): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) return null;
  const [provider] = trimmed.split("/", 1);
  return provider?.trim() || null;
}

export function resolveExecutionProvider(input: {
  provider?: string | null;
  model?: string | null;
}): string | null {
  const provider = input.provider?.trim();
  if (provider) return provider;
  return deriveExecutionProviderFromModel(input.model);
}
