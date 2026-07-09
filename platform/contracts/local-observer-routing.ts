import { z } from "zod";

export const LocalObserverArtifactKindSchema = z.enum([
  "work_item",
  "plan",
  "document",
  "ci_failure",
  "repository_state",
  "pull_request",
  "scheduled_task_run",
]);

export const LocalObserverArtifactSnapshotSchema = z.object({
  kind: LocalObserverArtifactKindSchema,
  provider: z.string().trim().min(1),
  locator: z.record(z.string(), z.unknown()).default({}),
  version: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  state: z.record(z.string(), z.unknown()).default({}),
  signals: z.array(z.string().trim().min(1)).default([]),
  diffSummary: z.record(z.string(), z.unknown()).optional(),
  constraints: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const LocalObserverAgentRoleSchema = z.enum([
  "routing",
  "manager",
  "coding",
  "review",
  "local_model",
  "observer",
  "other",
]);

export const LocalObserverAgentRefSchema = z.object({
  role: LocalObserverAgentRoleSchema,
  agentId: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
});

export const LocalObserverToolSpecSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export const LocalObserverToolCallSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  status: z
    .enum([
      "requested",
      "completed",
      "failed",
      "cancelled",
      "approval_required",
      "malformed",
    ])
    .default("requested"),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().trim().min(1).optional(),
});

export const LocalObserverAgentTraceSchema = z.object({
  traceId: z.string().trim().min(1).optional(),
  actingAgent: LocalObserverAgentRefSchema,
  task: z.string().trim().min(1),
  artifactSnapshot: LocalObserverArtifactSnapshotSchema.optional(),
  workspacePolicy: z.record(z.string(), z.unknown()).default({}),
  availableTools: z.array(LocalObserverToolSpecSchema).default([]),
  promptSummary: z.string().trim().min(1).optional(),
  modelResponse: z.string().optional(),
  toolCalls: z.array(LocalObserverToolCallSchema).default([]),
  finalOutput: z.string().optional(),
  outcome: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const LocalObserverEvaluationVerdictSchema = z.enum([
  "correct",
  "incorrect",
  "partially_correct",
  "inconclusive",
]);

export const LocalObserverFailureModeSchema = z.enum([
  "wrong_tool",
  "missing_tool_call",
  "unnecessary_tool_call",
  "bad_arguments",
  "missed_escalation",
  "premature_escalation",
  "missed_context",
  "unsafe_action",
  "wasted_tokens",
  "other",
]);

export const LocalObserverEvaluationJudgmentSchema = z.object({
  verdict: LocalObserverEvaluationVerdictSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1),
  observedBehavior: z.string().trim().min(1),
  expectedBehavior: z.string().trim().min(1).optional(),
  failureModes: z.array(LocalObserverFailureModeSchema).default([]),
  strengths: z.array(z.string().trim().min(1)).default([]),
  issues: z.array(z.string().trim().min(1)).default([]),
  suggestedFollowUp: z.string().trim().min(1).nullable().default(null),
});

export const RenderLocalObserverEvaluationPromptRequestSchema = z.object({
  trace: LocalObserverAgentTraceSchema,
  evaluator: LocalObserverAgentRefSchema.default({ role: "observer" }),
  rubric: z.array(z.string().trim().min(1)).default([]),
  casePrompt: z.string().trim().min(1).optional(),
});

export const RenderLocalObserverEvaluationPromptResponseSchema = z.object({
  prompt: z.string(),
  evaluationTool: LocalObserverToolSpecSchema,
  trace: LocalObserverAgentTraceSchema,
});

export const ReviewLocalObserverEvaluationRequestSchema = z.object({
  trace: LocalObserverAgentTraceSchema,
  judgment: z.unknown(),
});

export const LocalObserverEvaluationNoticeSchema = z.object({
  noticeType: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.unknown().optional(),
});

export const ReviewLocalObserverEvaluationResponseSchema = z.object({
  accepted: z.boolean(),
  judgment: LocalObserverEvaluationJudgmentSchema.nullable(),
  notices: z.array(LocalObserverEvaluationNoticeSchema),
});

export type LocalObserverArtifactSnapshot = z.infer<
  typeof LocalObserverArtifactSnapshotSchema
>;
export type LocalObserverAgentTrace = z.infer<
  typeof LocalObserverAgentTraceSchema
>;
export type LocalObserverEvaluationJudgment = z.infer<
  typeof LocalObserverEvaluationJudgmentSchema
>;
export type RenderLocalObserverEvaluationPromptRequest = z.infer<
  typeof RenderLocalObserverEvaluationPromptRequestSchema
>;
export type RenderLocalObserverEvaluationPromptResponse = z.infer<
  typeof RenderLocalObserverEvaluationPromptResponseSchema
>;
export type ReviewLocalObserverEvaluationRequest = z.infer<
  typeof ReviewLocalObserverEvaluationRequestSchema
>;
export type ReviewLocalObserverEvaluationResponse = z.infer<
  typeof ReviewLocalObserverEvaluationResponseSchema
>;
