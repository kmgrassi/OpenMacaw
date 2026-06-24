import { z } from "zod";

import {
  AgentTypeSchema,
  ModelSettingsSchema,
  ToolPolicySchema,
} from "./agents.js";
import {
  CredentialProviderSchema,
  CredentialReferenceSchema,
} from "./credentials.js";
import {
  ExecutionProfileResolutionSchema,
  RuntimeExecutionTargetKindSchema,
  RunnerKindSchema,
} from "./execution-profile.js";
import { TrackerKindSchema } from "./tracker-kinds.js";

export const SetupCustomTargetSchema = z.object({
  backend: z.object({
    type: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
  }),
});

export const SetupCredentialSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1).optional(),
  secret: z.string().min(1),
  keyName: z.string().min(1),
});

export const SetupTrackerSchema = z.object({
  kind: TrackerKindSchema,
  repositoryUrl: z.string().trim().url().nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const SetupRunnerSchema = z.object({
  kind: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

const SetupRequestBaseSchema = z.object({
  agentId: z.string().uuid().optional(),
  workspaceId: z.string().uuid(),
  agentName: z.string().trim().min(1),
  agentType: AgentTypeSchema.optional(),
  model: z.string().trim().min(1),
  toolPolicy: z.record(z.string(), z.unknown()).default({}),
  customTarget: SetupCustomTargetSchema.optional(),
  workflowTemplate: z.string().trim().min(1),
  repositoryUrl: z.string().trim().url().nullable().optional(),
  tracker: SetupTrackerSchema,
  runners: z.array(SetupRunnerSchema).min(1),
  credentials: z.array(SetupCredentialSchema).default([]),
  maxConcurrentAgents: z.number().int().positive().max(32).default(1),
});

function requireCustomTarget(
  value: z.infer<typeof SetupRequestBaseSchema>,
  ctx: z.core.$RefinementCtx<z.infer<typeof SetupRequestBaseSchema>>,
) {
  if (value.agentType === "custom" && !value.customTarget) {
    ctx.addIssue({
      code: "custom",
      path: ["customTarget"],
      message: "customTarget is required when agentType is custom",
    });
  }
}

export const SetupRequestSchema =
  SetupRequestBaseSchema.superRefine(requireCustomTarget);

export const SetupUpdateRequestSchema = SetupRequestBaseSchema.extend({
  agentId: z.string().uuid(),
});

export const SetupAgentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().nullable(),
  status: z.string(),
  type: AgentTypeSchema.nullable().default("coding"),
  modelSettings: ModelSettingsSchema,
  toolPolicy: ToolPolicySchema,
  createdByUserId: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
});

export const SetupEngineInstanceSchema = z.object({
  instanceId: z.string(),
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  host: z.string(),
  port: z.number().int(),
  role: z.string(),
  status: z.string(),
  startedAt: z.string(),
  lastHealthAt: z.string().nullable(),
  updatedAt: z.string(),
  wsConnectionId: z.string().nullable(),
});

export const SetupRuntimeTargetSchema = z.object({
  agentId: z.string().uuid(),
  host: z.string(),
  port: z.number().int(),
  instanceId: z.string(),
});

export const SetupRuntimeHealthSchema = z.object({
  ok: z.boolean(),
  source: z.enum(["launcher", "engine_instance"]),
  status: z.string(),
  checkedAt: z.string(),
  runtimeTarget: SetupRuntimeTargetSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const SetupGatewayConfigSchema = z.object({
  id: z.string().uuid(),
  scopeType: z.string(),
  scopeId: z.string().uuid(),
  version: z.number().int(),
  configHash: z.string(),
  configJson: z.unknown(),
  updatedAt: z.string(),
  updatedBy: z.string().uuid(),
});

export const SetupGatewayConfigStateSchema = z.object({
  scopeType: z.string(),
  scopeId: z.string().uuid(),
  syncStatus: z.string(),
  syncError: z.string().nullable(),
  syncedAt: z.string().nullable(),
  lastAppliedHash: z.string().nullable(),
  lastAppliedVersion: z.number().int().nullable(),
  lastApplyStatus: z.string().nullable(),
  lastApplyError: z.string().nullable(),
  lastApplyAt: z.string().nullable(),
  brokerInstanceId: z.string().nullable(),
});

export const SetupWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerUserId: z.string().uuid(),
  createdAt: z.string(),
});

export const DefaultAgentRoleSchema = z.enum(["planning", "coding"]);

export const DefaultAgentMissingRequirementSchema = z.enum([
  "agent",
  "credential",
  "model",
  "gateway_config",
  "runner",
  "provider",
  "route",
]);

export const AgentConfigurationChecklistStepSchema = z.enum([
  "agent_exists",
  "routing_rule",
  "provider_configured",
  "model_selected",
  "credential_configured",
  "gateway_config",
  "runner_configured",
]);

export const AgentConfigurationChecklistStatusSchema = z.enum(["pass", "fail"]);

export const AgentConfigurationChecklistActionSchema = z.enum([
  "configure_routing",
  "select_model",
  "add_credential",
  "configure_runtime",
]);

export const AgentConfigurationChecklistItemSchema = z.object({
  step: AgentConfigurationChecklistStepSchema,
  status: AgentConfigurationChecklistStatusSchema,
  label: z.string().trim().min(1),
  action: AgentConfigurationChecklistActionSchema.optional(),
  actionUrl: z.string().trim().min(1).optional(),
});

export const AgentConfigurationChecklistSchema = z.object({
  configured: z.boolean(),
  checklist: z.array(AgentConfigurationChecklistItemSchema),
});

export const SetupConfigurationChecklistItemSchema = z.object({
  step: z.string().trim().min(1),
  status: AgentConfigurationChecklistStatusSchema,
  label: z.string().trim().min(1),
  action: z.string().trim().min(1).optional(),
  actionUrl: z.string().trim().min(1).optional(),
});

export const SetupRequirementStatusSchema = z.object({
  configured: z.boolean(),
  missing: z.array(DefaultAgentMissingRequirementSchema),
  checklist: z.array(SetupConfigurationChecklistItemSchema).optional(),
  executionProfile: ExecutionProfileResolutionSchema.optional(),
  localCodingExecutionTargetKind:
    RuntimeExecutionTargetKindSchema.nullable().optional(),
});

export const SetupResponseSchema = z.object({
  agent: SetupAgentSchema,
  engine: SetupEngineInstanceSchema.nullable(),
  runtimeHealth: SetupRuntimeHealthSchema.nullable().default(null),
  gatewayConfig: SetupGatewayConfigSchema.nullable(),
  gatewayConfigState: SetupGatewayConfigStateSchema.nullable(),
  requirements: SetupRequirementStatusSchema,
});

export const DefaultAgentStatusSchema = SetupRequirementStatusSchema.extend({
  agentId: z.string().uuid().nullable(),
});

export const DefaultAgentsAuthStateSchema = z.object({
  planning: DefaultAgentStatusSchema,
  coding: DefaultAgentStatusSchema,
});

export const ManagerAgentAuthStateSchema = DefaultAgentStatusSchema;

export const DefaultAgentsOnboardingStateSchema = z.object({
  required: z.boolean(),
  blocking: z.boolean(),
  reasons: z.array(z.string().trim().min(1)),
});

function createEmptyDefaultAgentStatus(): z.infer<
  typeof DefaultAgentStatusSchema
> {
  return {
    agentId: null,
    configured: false,
    missing: [],
  };
}

export const SetupAuthStateSchema = z.object({
  ready: z.boolean(),
  userId: z.string().uuid(),
  resolvedAgentId: z.string().uuid().nullable(),
  workspaceId: z.string().uuid().nullable(),
  workspaces: z.array(SetupWorkspaceSchema),
  agents: z.array(SetupAgentSchema),
  defaultAgents: DefaultAgentsAuthStateSchema.default(() => ({
    planning: createEmptyDefaultAgentStatus(),
    coding: createEmptyDefaultAgentStatus(),
  })),
  managerAgent: ManagerAgentAuthStateSchema.default(() =>
    createEmptyDefaultAgentStatus(),
  ),
  onboarding: DefaultAgentsOnboardingStateSchema.default(() => ({
    required: false,
    blocking: false,
    reasons: [],
  })),
});

// Credential requests may either carry a freshly pasted `secret` or reference
// an existing stored credential by `credentialId`. Exactly one must be present;
// `keyName` only applies when a new secret is being saved.
function requireSecretOrCredentialId(
  value: { secret?: string; credentialId?: string; keyName?: string },
  ctx: z.RefinementCtx,
) {
  if (!value.secret && !value.credentialId) {
    ctx.addIssue({
      code: "custom",
      path: ["secret"],
      message: "secret or credentialId is required",
    });
  }
  if (value.secret && value.credentialId) {
    ctx.addIssue({
      code: "custom",
      path: ["credentialId"],
      message: "Provide either secret or credentialId, not both",
    });
  }
  if (value.credentialId && value.keyName) {
    ctx.addIssue({
      code: "custom",
      path: ["keyName"],
      message: "keyName cannot be combined with credentialId",
    });
  }
}

export const DefaultAgentCredentialApplicationRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    provider: CredentialProviderSchema,
    model: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    keyName: z.string().trim().min(1).optional(),
    // Provide exactly one of `secret` (paste a new key) or `credentialId`
    // (reuse a stored workspace credential for this provider).
    secret: z.string().trim().min(1).optional(),
    credentialId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).min(1),
  })
  .superRefine(requireSecretOrCredentialId);

export const DefaultAgentCredentialApplicationResponseSchema = z.object({
  authState: SetupAuthStateSchema,
});

export const AgentCredentialConfigurationRequestSchema = z
  .object({
    agentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    provider: CredentialProviderSchema,
    model: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    keyName: z.string().trim().min(1).optional(),
    // Provide exactly one of `secret` (paste a new key) or `credentialId`
    // (reuse a stored workspace credential for this provider).
    secret: z.string().trim().min(1).optional(),
    credentialId: z.string().uuid().optional(),
  })
  .superRefine(requireSecretOrCredentialId);

export const AgentCredentialConfigurationResponseSchema = z.object({
  setup: SetupResponseSchema,
});

export const ManagerCredentialActivationRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    agentId: z.string().uuid(),
    provider: CredentialProviderSchema,
    model: z.string().trim().min(1),
    runnerKind: RunnerKindSchema.default("llm_tool_runner"),
    credentialRef: CredentialReferenceSchema.optional(),
    newCredential: z
      .object({
        apiKey: z.string().trim().min(1),
        label: z.string().trim().min(1).optional(),
      })
      .optional(),
    cadenceMs: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.runnerKind !== "llm_tool_runner") {
      ctx.addIssue({
        code: "custom",
        path: ["runnerKind"],
        message: "Manager agents currently require llm_tool_runner",
      });
    }
    if (!value.credentialRef && !value.newCredential) {
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "credentialRef or newCredential is required",
      });
    }
    if (value.credentialRef && value.newCredential) {
      ctx.addIssue({
        code: "custom",
        path: ["newCredential"],
        message: "Provide either credentialRef or newCredential, not both",
      });
    }
  });

export const ManagerCredentialActivationResponseSchema = z.object({
  authState: SetupAuthStateSchema,
});

export const DefaultAgentAssignmentUpdateRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  role: DefaultAgentRoleSchema,
  agentId: z.string().uuid(),
});

export type SetupRequest = z.infer<typeof SetupRequestSchema>;
export type SetupUpdateRequest = z.infer<typeof SetupUpdateRequestSchema>;
export type SetupResponse = z.infer<typeof SetupResponseSchema>;
export type SetupRequirementStatus = z.infer<
  typeof SetupRequirementStatusSchema
>;
export type AgentConfigurationChecklistStep = z.infer<
  typeof AgentConfigurationChecklistStepSchema
>;
export type AgentConfigurationChecklistStatus = z.infer<
  typeof AgentConfigurationChecklistStatusSchema
>;
export type AgentConfigurationChecklistAction = z.infer<
  typeof AgentConfigurationChecklistActionSchema
>;
export type AgentConfigurationChecklistItem = z.infer<
  typeof AgentConfigurationChecklistItemSchema
>;
export type AgentConfigurationChecklist = z.infer<
  typeof AgentConfigurationChecklistSchema
>;
export type SetupConfigurationChecklistItem = z.infer<
  typeof SetupConfigurationChecklistItemSchema
>;
export type SetupAuthState = z.infer<typeof SetupAuthStateSchema>;
export type DefaultAgentRole = z.infer<typeof DefaultAgentRoleSchema>;
export type DefaultAgentMissingRequirement = z.infer<
  typeof DefaultAgentMissingRequirementSchema
>;
export type DefaultAgentStatus = z.infer<typeof DefaultAgentStatusSchema>;
export type DefaultAgentsAuthState = z.infer<
  typeof DefaultAgentsAuthStateSchema
>;
export type ManagerAgentAuthState = z.infer<typeof ManagerAgentAuthStateSchema>;
export type DefaultAgentsOnboardingState = z.infer<
  typeof DefaultAgentsOnboardingStateSchema
>;
export type DefaultAgentCredentialApplicationRequest = z.infer<
  typeof DefaultAgentCredentialApplicationRequestSchema
>;
export type DefaultAgentCredentialApplicationResponse = z.infer<
  typeof DefaultAgentCredentialApplicationResponseSchema
>;
export type AgentCredentialConfigurationRequest = z.infer<
  typeof AgentCredentialConfigurationRequestSchema
>;
export type AgentCredentialConfigurationResponse = z.infer<
  typeof AgentCredentialConfigurationResponseSchema
>;
export type ManagerCredentialActivationRequest = z.infer<
  typeof ManagerCredentialActivationRequestSchema
>;
export type ManagerCredentialActivationResponse = z.infer<
  typeof ManagerCredentialActivationResponseSchema
>;
export type DefaultAgentAssignmentUpdateRequest = z.infer<
  typeof DefaultAgentAssignmentUpdateRequestSchema
>;
