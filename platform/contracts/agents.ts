import { z } from "zod";
import {
  CredentialReferenceSchema,
  KnownExecutionProviderSchema,
} from "./execution-profile.js";
import { ModelTierFloorSchema } from "./model-tiers.js";

export const AgentTypeSchema = z.enum([
  "coding",
  "planning",
  "manager",
  "learning",
  "router",
  "custom",
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export function normalizeAgentType(value: unknown): AgentType {
  const parsed = AgentTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : "coding";
}

export const PlanningDestinationSchema = z.enum(["database", "linear"]);

export const LocalModelCodingConfigRowSchema = z.object({
  enabled: z.boolean(),
  approval_policy: z.enum(["on_request", "never"]),
  workspace_write: z.boolean(),
  local_model_id: z.string().nullable().optional(),
});

export const LocalModelCodingConfigSchema = z.object({
  enabled: z.boolean(),
  approvalPolicy: z.enum(["on_request", "never"]),
  workspaceWrite: z.boolean(),
  localModelId: z.string().nullable().optional(),
});

const JsonLiteralSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
type JsonLiteral = z.infer<typeof JsonLiteralSchema>;
type JsonValue =
  | JsonLiteral
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonLiteralSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AgentCustomModelSettingsSchema = z
  .object({
    backend_type: z.string().trim().min(1).nullable().optional(),
    base_url: z.string().trim().min(1).nullable().optional(),
    agent_id: z.string().trim().min(1).nullable().optional(),
  })
  .catchall(JsonValueSchema);

export const ModelSettingsSchema = z.preprocess(
  (value) => (value === null ? {} : value),
  z
    .object({
      primary: z.string().trim().min(1).optional(),
      custom: AgentCustomModelSettingsSchema.optional(),
    })
    .catchall(JsonValueSchema),
);
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const ToolPolicySchema = z.preprocess(
  (value) => (value === null ? {} : value),
  z.record(z.string(), JsonValueSchema),
);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const StoredAgentConfigurationMissingRequirementSchema = z.enum([
  "agent",
  "credential",
  "model",
  "gateway_config",
  "runner",
]);

export const StoredAgentConfigurationStatusSchema = z.object({
  configured: z.boolean(),
  missing: z.array(StoredAgentConfigurationMissingRequirementSchema),
});

export const StoredAgentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace_id: z.string().nullable(),
  agent_type: AgentTypeSchema.default("coding"),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  runner_kind: z.string().nullable().optional().default(null),
  has_credentials: z.boolean(),
  is_resolved: z.boolean(),
  planning_destination: PlanningDestinationSchema.nullable().default(null),
  configuration_status:
    StoredAgentConfigurationStatusSchema.nullable().optional(),
  local_model_coding: LocalModelCodingConfigRowSchema.nullable().optional(),
  custom_target: z
    .object({
      backend_type: z.string().nullable(),
      base_url: z.string().nullable(),
      agent_id: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

export const StoredAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string().nullable(),
  agentType: AgentTypeSchema.default("coding"),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  context: z.string().nullable().default(null),
  runnerKind: z.string().nullable().optional().default(null),
  hasCredentials: z.boolean(),
  isResolved: z.boolean(),
  planningDestination: PlanningDestinationSchema.nullable().default(null),
  configurationStatus:
    StoredAgentConfigurationStatusSchema.nullable().optional(),
  localModelCoding: LocalModelCodingConfigSchema.nullable().optional(),
  customTarget: z
    .object({
      backendType: z.string().nullable(),
      baseUrl: z.string().nullable(),
      agentId: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

export const StoredAgentListResponseSchema = z.object({
  agents: z.array(StoredAgentSchema),
});

export const AgentRuntimeProviderSchema = KnownExecutionProviderSchema;

export const AgentRuntimeProfileSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  agentType: AgentTypeSchema,
  runnerKind: z.string(),
  provider: AgentRuntimeProviderSchema,
  model: z.string().trim().min(1),
  credentialRef: CredentialReferenceSchema.nullable(),
  fallbacks: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        credentialRef: CredentialReferenceSchema.nullable(),
      }),
    )
    .optional()
    .default([]),
  modelTierFloor: ModelTierFloorSchema.optional().default("any"),
  localEndpointUrl: z.string().trim().min(1).nullable(),
  localHelperRegistered: z.boolean(),
  updatedAt: z.string().nullable(),
});

export const AgentRuntimeProfileResponseSchema = z.object({
  profile: AgentRuntimeProfileSchema,
});

export const AgentRuntimeProfileUpdateRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  provider: AgentRuntimeProviderSchema,
  model: z.string().trim().min(1),
  credentialRef: CredentialReferenceSchema.nullable().optional(),
  fallbacks: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        credentialRef: CredentialReferenceSchema.nullable(),
      }),
    )
    .default([]),
  modelTierFloor: ModelTierFloorSchema.default("any"),
  localEndpointUrl: z.string().trim().min(1).nullable().optional(),
});

export type AgentRuntimeProfile = z.infer<typeof AgentRuntimeProfileSchema>;
export type AgentRuntimeProfileUpdateRequest = z.input<
  typeof AgentRuntimeProfileUpdateRequestSchema
>;

export const AgentFormInputSchema = z.object({
  name: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  type: AgentTypeSchema,
  model: z.string().nullable().optional(),
  planningDestination: PlanningDestinationSchema.optional(),
  customTarget: z
    .object({
      backendType: z.string().trim().min(1),
      baseUrl: z.string().trim().min(1),
      agentId: z.string().trim().min(1),
    })
    .optional(),
});

export const AgentUpdateInputSchema = AgentFormInputSchema.omit({
  workspaceId: true,
});

export const StoredAgentCreateResponseSchema = z.object({
  agent: StoredAgentSchema,
});

export const BrokerRunSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  attempt: z.number().nullable(),
  createdAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  status: z.string().nullable(),
  error: z.string().nullable(),
  terminalReason: z.string().nullable(),
  trackerKind: z.string().nullable(),
  trackerIssueKey: z.string().nullable(),
  issueIdentifier: z.string().nullable(),
  issueState: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const BrokerTaskSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  attempt: z.number().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  lastEvent: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const GatewayConfigStateSchema = z.object({
  scopeType: z.string().nullable(),
  scopeId: z.string().nullable(),
  syncStatus: z.string().nullable(),
  syncError: z.string().nullable(),
  lastApplyStatus: z.string().nullable(),
  lastApplyError: z.string().nullable(),
  lastApplyAt: z.string().nullable(),
  lastAppliedVersion: z.number().nullable(),
});

export const BrokerRunHistoryResponseSchema = z.object({
  runs: z.array(BrokerRunSchema),
  total: z.number(),
});

export const BrokerTasksResponseSchema = z.object({
  tasks: z.array(BrokerTaskSchema),
});

export const GatewayConfigStateResponseSchema = z.object({
  state: GatewayConfigStateSchema.nullable(),
});

export const PlanReviewEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().nullable(),
  snippet: z.string().nullable(),
  label: z.string().nullable(),
});

export const PlanReviewTaskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  planId: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  state: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.array(z.string()).nullable(),
  metadata: z.unknown(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  evidence: z.array(PlanReviewEvidenceSchema),
});

export const PlanReviewPlanSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  tasks: z.array(PlanReviewTaskSchema),
  evidence: z.array(PlanReviewEvidenceSchema),
});

export const PlanReviewListResponseSchema = z.object({
  plans: z.array(PlanReviewPlanSchema),
});

export const StoredAgentAuthStateSchema = z.object({
  readyToPrepare: z.boolean(),
  reasons: z.array(z.string()),
  resolvedAgentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  agents: z.array(StoredAgentSchema),
});

export const AgentObservationEventSchema = z.object({
  event: z.string(),
  source: z.enum(["platform", "gateway", "runtime", "tool"]),
  severity: z.enum(["info", "warning", "error"]),
  occurredAt: z.string().nullable(),
  summary: z.string(),
  runId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const AgentObservationHealthSchema = z.object({
  status: z.enum(["healthy", "degraded", "unavailable", "unknown"]),
  config: z.object({
    status: z.string().nullable(),
    error: z.string().nullable(),
    checkedAt: z.string().nullable(),
  }),
  runtime: z.object({
    status: z.string().nullable(),
    lastHeartbeatAt: z.string().nullable(),
    instanceId: z.string().nullable(),
  }),
  launcher: z.object({
    reachable: z.boolean(),
    status: z.string().nullable(),
    error: z.string().nullable(),
  }),
  latestRun: z
    .object({
      runId: z.string(),
      status: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      error: z.string().nullable(),
      terminalReason: z.string().nullable(),
    })
    .nullable(),
  lastFailure: AgentObservationEventSchema.nullable(),
});

export const AgentObservationResponseSchema = z.object({
  observerAgentId: z.string().nullable(),
  targetAgent: z.object({
    id: z.string(),
    name: z.string().nullable(),
    workspaceId: z.string(),
    agentType: AgentTypeSchema,
  }),
  health: AgentObservationHealthSchema,
  events: z.array(AgentObservationEventSchema),
});

export type StoredAgentRow = z.infer<typeof StoredAgentRowSchema>;
export type StoredAgent = z.infer<typeof StoredAgentSchema>;
export type AgentFormInput = z.infer<typeof AgentFormInputSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateInputSchema>;
export type StoredAgentListResponse = z.infer<
  typeof StoredAgentListResponseSchema
>;
export type StoredAgentCreateResponse = z.infer<
  typeof StoredAgentCreateResponseSchema
>;
export type StoredAgentAuthState = z.infer<typeof StoredAgentAuthStateSchema>;
export type PlanningDestination = z.infer<typeof PlanningDestinationSchema>;
export type LocalModelCodingConfig = z.infer<
  typeof LocalModelCodingConfigSchema
>;
export type StoredAgentConfigurationStatus = z.infer<
  typeof StoredAgentConfigurationStatusSchema
>;
export type BrokerRun = z.infer<typeof BrokerRunSchema>;
export type BrokerTask = z.infer<typeof BrokerTaskSchema>;
export type GatewayConfigState = z.infer<typeof GatewayConfigStateSchema>;
export type BrokerRunHistoryResponse = z.infer<
  typeof BrokerRunHistoryResponseSchema
>;
export type PlanReviewEvidence = z.infer<typeof PlanReviewEvidenceSchema>;
export type PlanReviewTask = z.infer<typeof PlanReviewTaskSchema>;
export type PlanReviewPlan = z.infer<typeof PlanReviewPlanSchema>;
export type AgentObservationEvent = z.infer<typeof AgentObservationEventSchema>;
export type AgentObservationHealth = z.infer<
  typeof AgentObservationHealthSchema
>;
export type AgentObservationResponse = z.infer<
  typeof AgentObservationResponseSchema
>;
