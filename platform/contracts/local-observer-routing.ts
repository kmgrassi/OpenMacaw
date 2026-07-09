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

export const LocalObserverRecommendedTargetSchema = z.enum([
  "none",
  "manager",
  "codex",
  "claude_code",
  "local_relay",
  "local_model_coding",
  "human",
]);

export const LocalObserverRoutingIntentSchema = z.enum([
  "no_action",
  "triage",
  "review",
  "fix",
  "summarize",
  "route_to_manager",
  "ask_human",
  "run_eval",
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

export const LocalObserverRoutingRecommendationSchema = z.object({
  recommendedTarget: LocalObserverRecommendedTargetSchema,
  intent: LocalObserverRoutingIntentSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
  followUp: z.string().trim().min(1).nullable().default(null),
});

export const LocalObserverRoutingExpectationSchema = z.object({
  recommendedTargetIn: z.array(LocalObserverRecommendedTargetSchema).optional(),
  recommendedTargetNotIn: z
    .array(LocalObserverRecommendedTargetSchema)
    .optional(),
  intentEquals: LocalObserverRoutingIntentSchema.optional(),
  confidenceMin: z.number().min(0).max(1).optional(),
  confidenceMax: z.number().min(0).max(1).optional(),
  evidenceContains: z.array(z.string().trim().min(1)).optional(),
  requireRiskFlags: z.array(z.string().trim().min(1)).optional(),
});

export const RenderLocalObserverPromptRequestSchema = z.object({
  artifactSnapshot: LocalObserverArtifactSnapshotSchema,
  workspacePolicy: z.record(z.string(), z.unknown()).default({}),
  availableTargets: z
    .array(LocalObserverRecommendedTargetSchema)
    .default([
      "none",
      "manager",
      "codex",
      "claude_code",
      "local_relay",
      "local_model_coding",
      "human",
    ]),
  casePrompt: z.string().trim().min(1).optional(),
});

export const RenderLocalObserverPromptResponseSchema = z.object({
  prompt: z.string(),
  outputSchema: z.record(z.string(), z.unknown()),
  artifactSnapshot: LocalObserverArtifactSnapshotSchema,
  availableTargets: z.array(LocalObserverRecommendedTargetSchema),
});

export const ValidateLocalObserverRecommendationRequestSchema = z.object({
  recommendation: LocalObserverRoutingRecommendationSchema,
  availableTargets: z
    .array(LocalObserverRecommendedTargetSchema)
    .default([
      "none",
      "manager",
      "codex",
      "claude_code",
      "local_relay",
      "local_model_coding",
      "human",
    ]),
  expectations: LocalObserverRoutingExpectationSchema.default({}),
});

export const LocalObserverValidationFailureSchema = z.object({
  assertionType: z.string(),
  message: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export const ValidateLocalObserverRecommendationResponseSchema = z.object({
  valid: z.boolean(),
  recommendation: LocalObserverRoutingRecommendationSchema,
  failures: z.array(LocalObserverValidationFailureSchema),
});

export type LocalObserverArtifactSnapshot = z.infer<
  typeof LocalObserverArtifactSnapshotSchema
>;
export type LocalObserverRecommendedTarget = z.infer<
  typeof LocalObserverRecommendedTargetSchema
>;
export type LocalObserverRoutingRecommendation = z.infer<
  typeof LocalObserverRoutingRecommendationSchema
>;
export type LocalObserverRoutingExpectation = z.infer<
  typeof LocalObserverRoutingExpectationSchema
>;
export type RenderLocalObserverPromptRequest = z.infer<
  typeof RenderLocalObserverPromptRequestSchema
>;
export type RenderLocalObserverPromptResponse = z.infer<
  typeof RenderLocalObserverPromptResponseSchema
>;
export type ValidateLocalObserverRecommendationRequest = z.infer<
  typeof ValidateLocalObserverRecommendationRequestSchema
>;
export type ValidateLocalObserverRecommendationResponse = z.infer<
  typeof ValidateLocalObserverRecommendationResponseSchema
>;
