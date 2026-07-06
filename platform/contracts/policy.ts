import { z } from "zod";

export const PolicyScopeSchema = z.enum(["workspace", "agent", "session"]);
export const PolicySourceSchema = z.enum(["manual", "system", "template"]);
export const PolicyVerdictSchema = z.enum(["allow", "deny", "ask"]);

export const PolicyKindSchema = z.enum([
  "max_tool_calls_per_session",
  "cost_budget",
  "ask_on_shell",
  "ask_on_tool",
  "block_tools",
  "risk_score",
]);

const ToolListSchema = z.object({
  tools: z.array(z.string().trim().min(1)).min(1),
});

export const MaxToolCallsPolicyParamsSchema = z.object({
  limit: z.number().int().positive(),
});

export const CostBudgetPolicyParamsSchema = z.object({
  max_cost_usd: z.number().positive(),
  ask_thresholds_usd: z.array(z.number().positive()).default([]),
});

export const AskOnShellPolicyParamsSchema = z
  .record(z.string(), z.never())
  .default({});
export const AskOnToolPolicyParamsSchema = ToolListSchema;
export const BlockToolsPolicyParamsSchema = ToolListSchema;
export const RiskScorePolicyParamsSchema = z.object({
  guarded_tools: z.array(z.string().trim().min(1)).min(1),
  threshold: z.number().positive(),
  weights: z.record(z.string(), z.number().positive()).default({}),
});

export const PolicyParamsSchema = z.union([
  MaxToolCallsPolicyParamsSchema,
  CostBudgetPolicyParamsSchema,
  AskOnShellPolicyParamsSchema,
  AskOnToolPolicyParamsSchema,
  BlockToolsPolicyParamsSchema,
  RiskScorePolicyParamsSchema,
]);

function validatePolicyParamsForKind(
  policy: { kind: PolicyKind; params: z.infer<typeof PolicyParamsSchema> },
  ctx: z.RefinementCtx,
) {
  const schema = policyParamsSchemaForKind(policy.kind);
  const result = schema?.safeParse(policy.params);

  if (result && !result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ["params", ...issue.path] });
    }
  }
}

function policyParamsSchemaForKind(kind: PolicyKind) {
  switch (kind) {
    case "max_tool_calls_per_session":
      return MaxToolCallsPolicyParamsSchema;
    case "cost_budget":
      return CostBudgetPolicyParamsSchema;
    case "ask_on_shell":
      return AskOnShellPolicyParamsSchema;
    case "ask_on_tool":
      return AskOnToolPolicyParamsSchema;
    case "block_tools":
      return BlockToolsPolicyParamsSchema;
    case "risk_score":
      return RiskScorePolicyParamsSchema;
  }
}

const PolicyBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  scope: PolicyScopeSchema,
  agentId: z.string().nullable(),
  sessionThreadId: z.string().nullable(),
  kind: PolicyKindSchema,
  params: PolicyParamsSchema,
  priority: z.number().int(),
  enabled: z.boolean(),
  source: PolicySourceSchema,
  reason: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export const PolicySchema = PolicyBaseSchema.superRefine(
  validatePolicyParamsForKind,
);

const PolicyRowBaseSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  scope: PolicyScopeSchema,
  agent_id: z.string().nullable(),
  session_thread_id: z.string().nullable(),
  kind: PolicyKindSchema,
  params: PolicyParamsSchema,
  priority: z.number().int(),
  enabled: z.boolean(),
  source: PolicySourceSchema,
  reason: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
});

export const PolicyRowSchema = PolicyRowBaseSchema.superRefine(
  validatePolicyParamsForKind,
);

export const PolicySessionStateSchema = z.object({
  workspaceId: z.string(),
  sessionThreadId: z.string(),
  key: z.string(),
  valueNumeric: z.number().nullable(),
  valueJson: z.unknown().nullable(),
  updatedAt: z.string(),
});

export const PolicySessionStateRowSchema = z.object({
  workspace_id: z.string(),
  session_thread_id: z.string(),
  key: z.string(),
  value_numeric: z.coerce.number().nullable(),
  value_json: z.unknown().nullable(),
  updated_at: z.string(),
});

export const PolicyKindDefinitionSchema = z.object({
  kind: PolicyKindSchema,
  label: z.string(),
  description: z.string(),
  defaultParams: PolicyParamsSchema,
});

export const AgentPoliciesResponseSchema = z.object({
  policies: z.array(PolicySchema),
  effectivePolicies: z.array(PolicySchema),
  availableKinds: z.array(PolicyKindDefinitionSchema),
});

const PolicyMutationRequestBaseSchema = z.object({
  workspaceId: z.string().trim().min(1),
  kind: PolicyKindSchema,
  params: PolicyParamsSchema,
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  reason: z.string().trim().min(1).nullable().optional(),
});

export const UpsertAgentPolicyRequestSchema =
  PolicyMutationRequestBaseSchema.superRefine(validatePolicyParamsForKind);

export const CreateSessionPolicyRequestSchema =
  PolicyMutationRequestBaseSchema.superRefine(validatePolicyParamsForKind);

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
export type PolicyKind = z.infer<typeof PolicyKindSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRow = z.infer<typeof PolicyRowSchema>;
export type PolicySessionState = z.infer<typeof PolicySessionStateSchema>;
export type PolicyKindDefinition = z.infer<typeof PolicyKindDefinitionSchema>;
export type AgentPoliciesResponse = z.infer<typeof AgentPoliciesResponseSchema>;
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
    defaultParams: { limit: 25 },
  },
  {
    kind: "cost_budget",
    label: "Cost budget",
    description: "Ask at configured spend thresholds and deny above the max.",
    defaultParams: { max_cost_usd: 10, ask_thresholds_usd: [5] },
  },
  {
    kind: "ask_on_shell",
    label: "Ask on shell",
    description: "Require approval before shell or operating-system tools run.",
    defaultParams: {},
  },
  {
    kind: "ask_on_tool",
    label: "Ask on tool",
    description: "Require approval before specific tools run.",
    defaultParams: { tools: ["shell.exec"] },
  },
  {
    kind: "block_tools",
    label: "Block tools",
    description: "Deny specific tools even when the agent grant allows them.",
    defaultParams: { tools: ["shell.exec"] },
  },
  {
    kind: "risk_score",
    label: "Risk score",
    description:
      "Accrue risk points for guarded tools and ask above a threshold.",
    defaultParams: {
      guarded_tools: ["shell.exec"],
      threshold: 10,
      weights: {},
    },
  },
];
