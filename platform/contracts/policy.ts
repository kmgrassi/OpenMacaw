import { z } from "zod";

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

export const PolicySchema = z.object({
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
  createdAt: z.string().datetime(),
});

export const PolicyRowSchema = z.object({
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
  created_at: z.string().datetime(),
});

export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;
export type PolicyEventType = z.infer<typeof PolicyEventTypeSchema>;
export type PolicyKind = z.infer<typeof PolicyKindSchema>;
export type PolicyParams = z.infer<typeof PolicyParamsSchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRow = z.infer<typeof PolicyRowSchema>;
