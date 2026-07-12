import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const SupabaseDateTimeSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")
      : value,
  IsoDateTimeSchema,
);

export const PolicyScopeSchema = z.enum(["workspace", "agent", "session"]);

export const PolicyVerdictSchema = z.enum(["allow", "deny", "ask"]);

export const PolicyEventTypeSchema = z.enum(["tool_call", "llm_request"]);

export const POLICY_KINDS = [
  "max_tool_calls_per_session",
  "cost_budget",
  "ask_on_shell",
  "ask_on_tool",
  "block_tools",
  "risk_score",
] as const;

export const PolicyKindSchema = z.enum(POLICY_KINDS);

const NonEmptyToolListSchema = z
  .array(z.string().trim().min(1).max(256))
  .min(1);

export const MaxToolCallsPerSessionPolicyParamsSchema = z
  .object({
    kind: z.literal("max_tool_calls_per_session"),
    limit: z.number().int().positive(),
  })
  .strict();

export const CostBudgetPolicyParamsSchema = z
  .object({
    kind: z.literal("cost_budget"),
    max_cost_usd: z.number().positive(),
    ask_thresholds_usd: z.array(z.number().positive()).default([]),
  })
  .strict()
  .refine(
    (params) =>
      params.ask_thresholds_usd.every(
        (threshold) => threshold < params.max_cost_usd,
      ),
    {
      message: "ask_thresholds_usd entries must be below max_cost_usd",
      path: ["ask_thresholds_usd"],
    },
  );

export const AskOnShellPolicyParamsSchema = z
  .object({
    kind: z.literal("ask_on_shell"),
  })
  .strict();

export const AskOnToolPolicyParamsSchema = z
  .object({
    kind: z.literal("ask_on_tool"),
    tools: NonEmptyToolListSchema,
  })
  .strict();

export const BlockToolsPolicyParamsSchema = z
  .object({
    kind: z.literal("block_tools"),
    tools: NonEmptyToolListSchema,
  })
  .strict();

export const RiskScorePolicyParamsSchema = z
  .object({
    kind: z.literal("risk_score"),
    guarded_tools: NonEmptyToolListSchema,
    threshold: z.number().positive(),
    weights: z.record(z.string().trim().min(1).max(128), z.number().positive()),
  })
  .strict();

export const PolicyParamsSchema = z.discriminatedUnion("kind", [
  MaxToolCallsPerSessionPolicyParamsSchema,
  CostBudgetPolicyParamsSchema,
  AskOnShellPolicyParamsSchema,
  AskOnToolPolicyParamsSchema,
  BlockToolsPolicyParamsSchema,
  RiskScorePolicyParamsSchema,
]);

export const PolicySourceSchema = z.enum(["manual", "system", "template"]);

function requireMatchingPolicyParamsKind(
  policy: { kind: PolicyKind; params: PolicyParams },
  ctx: z.RefinementCtx,
) {
  if (policy.params.kind !== policy.kind) {
    ctx.addIssue({
      code: "custom",
      message: "params.kind must match policy kind",
      path: ["params", "kind"],
    });
  }
}

export const POLICY_KIND_REGISTRY = {
  max_tool_calls_per_session: {
    kind: "max_tool_calls_per_session",
    eventTypes: ["tool_call"],
    params: MaxToolCallsPerSessionPolicyParamsSchema,
  },
  cost_budget: {
    kind: "cost_budget",
    eventTypes: ["tool_call", "llm_request"],
    params: CostBudgetPolicyParamsSchema,
  },
  ask_on_shell: {
    kind: "ask_on_shell",
    eventTypes: ["tool_call"],
    params: AskOnShellPolicyParamsSchema,
  },
  ask_on_tool: {
    kind: "ask_on_tool",
    eventTypes: ["tool_call"],
    params: AskOnToolPolicyParamsSchema,
  },
  block_tools: {
    kind: "block_tools",
    eventTypes: ["tool_call"],
    params: BlockToolsPolicyParamsSchema,
  },
  risk_score: {
    kind: "risk_score",
    eventTypes: ["tool_call"],
    params: RiskScorePolicyParamsSchema,
  },
} as const satisfies Record<
  PolicyKind,
  {
    kind: PolicyKind;
    eventTypes: readonly PolicyEventType[];
    params: z.ZodType<PolicyParams>;
  }
>;

export const PolicySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    scope: PolicyScopeSchema,
    agentId: z.string().uuid().nullable(),
    sessionThreadId: z.string().uuid().nullable(),
    kind: PolicyKindSchema,
    params: PolicyParamsSchema,
    priority: z.number().int(),
    enabled: z.boolean(),
    source: PolicySourceSchema,
    reason: z.string().nullable(),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .superRefine(requireMatchingPolicyParamsKind);

export const PolicyRowSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    scope: PolicyScopeSchema,
    agent_id: z.string().uuid().nullable(),
    session_thread_id: z.string().uuid().nullable(),
    kind: PolicyKindSchema,
    params: PolicyParamsSchema,
    priority: z.number().int(),
    enabled: z.boolean(),
    source: PolicySourceSchema,
    reason: z.string().nullable(),
    created_by_user_id: z.string().uuid().nullable(),
    created_at: SupabaseDateTimeSchema,
    updated_at: SupabaseDateTimeSchema.nullable().optional(),
  })
  .superRefine(requireMatchingPolicyParamsKind);

export const RuntimePolicySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    scope: PolicyScopeSchema,
    agentId: z.string().uuid().nullable(),
    sessionThreadId: z.string().uuid().nullable(),
    kind: PolicyKindSchema,
    params: PolicyParamsSchema,
    priority: z.number().int(),
    source: PolicySourceSchema,
    reason: z.string().nullable(),
  })
  .superRefine(requireMatchingPolicyParamsKind);

export const PolicyKindMetadataSchema = z.object({
  kind: PolicyKindSchema,
  paramsSchema: z.record(z.string(), z.unknown()),
});

export const AgentPolicySettingsResponseSchema = z.object({
  availableKinds: z.array(PolicyKindMetadataSchema),
  workspacePolicies: z.array(PolicySchema),
  agentPolicies: z.array(PolicySchema),
  sessionPolicies: z.array(PolicySchema),
  effectivePolicies: z.array(RuntimePolicySchema),
});

export const PolicySessionStateSchema = z.object({
  workspaceId: z.string().uuid(),
  sessionThreadId: z.string().uuid(),
  key: z.string().trim().min(1),
  valueNumeric: z.number().nullable(),
  valueJson: z.unknown().nullable(),
  updatedAt: IsoDateTimeSchema,
});

export const PolicySessionStateRowSchema = z.object({
  workspace_id: z.string().uuid(),
  session_thread_id: z.string().uuid(),
  key: z.string().trim().min(1),
  value_numeric: z.coerce.number().nullable(),
  value_json: z.unknown().nullable(),
  updated_at: SupabaseDateTimeSchema,
});

export const PolicyKindDefinitionSchema = z.object({
  kind: PolicyKindSchema,
  label: z.string(),
  description: z.string(),
  defaultParams: PolicyParamsSchema,
});

const PolicyMutationRequestBaseSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    kind: PolicyKindSchema,
    params: PolicyParamsSchema,
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
    reason: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine(requireMatchingPolicyParamsKind);

export const UpsertAgentPolicyRequestSchema = PolicyMutationRequestBaseSchema;
export const CreateSessionPolicyRequestSchema = PolicyMutationRequestBaseSchema;

export const SessionPoliciesResponseSchema = z.object({
  policies: z.array(PolicySchema),
  availableKinds: z.array(PolicyKindDefinitionSchema),
});

export const SessionPolicyStateResponseSchema = z.object({
  state: z.array(PolicySessionStateSchema),
});

export const PolicyMutationResponseSchema = z.object({
  policy: PolicySchema,
});

export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;
export type PolicyEventType = z.infer<typeof PolicyEventTypeSchema>;
export type PolicyKind = z.infer<typeof PolicyKindSchema>;
export type PolicyParams = z.infer<typeof PolicyParamsSchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRow = z.infer<typeof PolicyRowSchema>;
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;
export type PolicyKindMetadata = z.infer<typeof PolicyKindMetadataSchema>;
export type AgentPolicySettingsResponse = z.infer<
  typeof AgentPolicySettingsResponseSchema
>;
export type PolicySessionState = z.infer<typeof PolicySessionStateSchema>;
export type PolicyKindDefinition = z.infer<typeof PolicyKindDefinitionSchema>;
export type SessionPoliciesResponse = z.infer<
  typeof SessionPoliciesResponseSchema
>;
export type SessionPolicyStateResponse = z.infer<
  typeof SessionPolicyStateResponseSchema
>;
export type UpsertAgentPolicyRequest = z.infer<
  typeof UpsertAgentPolicyRequestSchema
>;
export type CreateSessionPolicyRequest = z.infer<
  typeof CreateSessionPolicyRequestSchema
>;

export const POLICY_KIND_DEFINITIONS: PolicyKindDefinition[] = [
  {
    kind: "max_tool_calls_per_session",
    label: "Max tool calls",
    description: "Deny tool calls once the session reaches a fixed call count.",
    defaultParams: { kind: "max_tool_calls_per_session", limit: 25 },
  },
  {
    kind: "cost_budget",
    label: "Cost budget",
    description: "Ask at configured spend thresholds and deny above the max.",
    defaultParams: {
      kind: "cost_budget",
      max_cost_usd: 10,
      ask_thresholds_usd: [5],
    },
  },
  {
    kind: "ask_on_shell",
    label: "Ask on shell",
    description: "Require approval before shell or operating-system tools run.",
    defaultParams: { kind: "ask_on_shell" },
  },
  {
    kind: "ask_on_tool",
    label: "Ask on tool",
    description: "Require approval before specific tools run.",
    defaultParams: { kind: "ask_on_tool", tools: ["shell.exec"] },
  },
  {
    kind: "block_tools",
    label: "Block tools",
    description: "Deny specific tools even when the agent grant allows them.",
    defaultParams: { kind: "block_tools", tools: ["shell.exec"] },
  },
  {
    kind: "risk_score",
    label: "Risk score",
    description:
      "Accrue risk points for guarded tools and ask above a threshold.",
    defaultParams: {
      kind: "risk_score",
      guarded_tools: ["shell.exec"],
      threshold: 10,
      weights: {},
    },
  },
];
