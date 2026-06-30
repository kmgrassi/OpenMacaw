import { z } from "zod";

export const POLICY_KINDS = [
  "max_tool_calls_per_session",
  "cost_budget",
  "ask_on_shell",
  "ask_on_tool",
  "block_tools",
  "risk_score",
] as const;

export const PolicyScopeSchema = z.enum(["workspace", "agent", "session"]);
export const PolicyKindSchema = z.enum(POLICY_KINDS);
export const PolicyVerdictSchema = z.enum(["allow", "deny", "ask"]);
export const PolicySourceSchema = z.enum(["manual", "system", "template"]);

const ToolSlugSchema = z.string().trim().min(1).max(256);

export const MaxToolCallsPerSessionParamsSchema = z.object({
  limit: z.number().int().positive(),
});

export const CostBudgetParamsSchema = z.object({
  maxCostUsd: z.number().positive(),
  askThresholdsUsd: z.array(z.number().positive()).default([]),
});

export const AskOnShellParamsSchema = z.object({}).strict();

export const AskOnToolParamsSchema = z.object({
  tools: z.array(ToolSlugSchema).min(1),
});

export const BlockToolsParamsSchema = z.object({
  tools: z.array(ToolSlugSchema).min(1),
});

export const RiskScoreParamsSchema = z.object({
  guardedTools: z.array(ToolSlugSchema).min(1),
  threshold: z.number().positive(),
  weights: z.record(ToolSlugSchema, z.number().positive()).default({}),
});

export const PolicyKindParamsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("max_tool_calls_per_session"),
    params: MaxToolCallsPerSessionParamsSchema,
  }),
  z.object({ kind: z.literal("cost_budget"), params: CostBudgetParamsSchema }),
  z.object({ kind: z.literal("ask_on_shell"), params: AskOnShellParamsSchema }),
  z.object({ kind: z.literal("ask_on_tool"), params: AskOnToolParamsSchema }),
  z.object({ kind: z.literal("block_tools"), params: BlockToolsParamsSchema }),
  z.object({ kind: z.literal("risk_score"), params: RiskScoreParamsSchema }),
]);

export const PolicySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  scope: PolicyScopeSchema,
  agentId: z.string().uuid().nullable(),
  sessionThreadId: z.string().trim().min(1).nullable(),
  kind: PolicyKindSchema,
  params: z.record(z.string(), z.unknown()),
  priority: z.number().int(),
  enabled: z.boolean(),
  source: PolicySourceSchema,
  reason: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
});

export const PolicyRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  scope: PolicyScopeSchema,
  agent_id: z.string().uuid().nullable(),
  session_thread_id: z.string().trim().min(1).nullable(),
  kind: PolicyKindSchema,
  params: z.record(z.string(), z.unknown()),
  priority: z.number().int(),
  enabled: z.boolean(),
  source: PolicySourceSchema,
  reason: z.string().nullable(),
  created_by_user_id: z.string().uuid().nullable(),
  created_at: z.string(),
});

export const RuntimePolicySchema = PolicySchema.pick({
  id: true,
  workspaceId: true,
  scope: true,
  agentId: true,
  sessionThreadId: true,
  kind: true,
  params: true,
  priority: true,
  source: true,
  reason: true,
});

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

export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyKind = z.infer<typeof PolicyKindSchema>;
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyRow = z.infer<typeof PolicyRowSchema>;
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;
export type PolicyKindMetadata = z.infer<typeof PolicyKindMetadataSchema>;
export type AgentPolicySettingsResponse = z.infer<
  typeof AgentPolicySettingsResponseSchema
>;
