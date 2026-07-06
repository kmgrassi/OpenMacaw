import { z } from "zod";

export const SessionPolicyKindSchema = z.enum([
  "max_tool_calls_per_session",
  "cost_budget",
  "ask_on_shell",
  "ask_on_tool",
  "block_tools",
  "risk_score",
]);

const NonNegativeNumberSchema = z.number().finite().nonnegative();
const PositiveNumberSchema = z.number().finite().positive();

export const CostBudgetPolicyParamsSchema = z
  .object({
    max_cost_usd: PositiveNumberSchema.optional(),
    ask_thresholds_usd: z.array(PositiveNumberSchema).default([]),
  })
  .refine(
    (params) =>
      params.max_cost_usd !== undefined || params.ask_thresholds_usd.length > 0,
    {
      message: "cost_budget requires max_cost_usd or ask_thresholds_usd",
    },
  );

export const RiskScorePolicyParamsSchema = z.object({
  guarded_tools: z.array(z.string().trim().min(1)).min(1),
  threshold: PositiveNumberSchema,
  weights: z
    .record(z.string().trim().min(1), NonNegativeNumberSchema)
    .default({}),
  verdict: z.enum(["ask", "deny"]).default("ask"),
});

export const SessionPolicyParamsByKindSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cost_budget"),
    params: CostBudgetPolicyParamsSchema,
  }),
  z.object({
    kind: z.literal("risk_score"),
    params: RiskScorePolicyParamsSchema,
  }),
  z.object({
    kind: z.enum([
      "max_tool_calls_per_session",
      "ask_on_shell",
      "ask_on_tool",
      "block_tools",
    ]),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const PolicySessionStateEntrySchema = z.object({
  key: z.string().min(1),
  valueNumeric: z.number().finite().nullable(),
  valueJson: z.unknown().nullable(),
  updatedAt: z.string().nullable(),
});

export const SessionPolicyStateCountersSchema = z.object({
  toolCallCount: z.number().finite().nonnegative(),
  accruedCostUsd: z.number().finite().nonnegative(),
  riskPoints: z.number().finite().nonnegative(),
});

export const SessionPolicyStateResponseSchema = z.object({
  sessionThreadId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  counters: SessionPolicyStateCountersSchema,
  state: z.array(PolicySessionStateEntrySchema),
});

export type SessionPolicyKind = z.infer<typeof SessionPolicyKindSchema>;
export type CostBudgetPolicyParams = z.infer<
  typeof CostBudgetPolicyParamsSchema
>;
export type RiskScorePolicyParams = z.infer<typeof RiskScorePolicyParamsSchema>;
export type SessionPolicyStateResponse = z.infer<
  typeof SessionPolicyStateResponseSchema
>;
