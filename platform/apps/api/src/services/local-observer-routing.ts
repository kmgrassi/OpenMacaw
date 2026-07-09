import { z } from "zod";

import type {
  LocalObserverRecommendedTarget,
  LocalObserverRoutingExpectation,
  RenderLocalObserverPromptRequest,
  RenderLocalObserverPromptResponse,
  ValidateLocalObserverRecommendationRequest,
  ValidateLocalObserverRecommendationResponse,
} from "../../../../contracts/local-observer-routing.js";
import {
  LocalObserverRecommendedTargetSchema,
  LocalObserverRoutingRecommendationSchema,
  RenderLocalObserverPromptResponseSchema,
  ValidateLocalObserverRecommendationResponseSchema,
} from "../../../../contracts/local-observer-routing.js";

const targetDescriptions: Record<string, string> = {
  none: "No agent run should start.",
  manager: "The manager should reconcile state, create/update work items, or coordinate handoff.",
  codex: "Use for coding or implementation work that should run on Codex.",
  claude_code: "Use for code review, critique, or cross-model second-pass work.",
  local_relay: "Use for read-only local observation or summarization.",
  local_model_coding: "Use for local coding only when capability gates allow it.",
  human: "Use when policy, ambiguity, or missing context requires a person.",
};

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function outputJsonSchema(availableTargets: LocalObserverRecommendedTarget[]) {
  const schema = z.toJSONSchema(LocalObserverRoutingRecommendationSchema, {
    io: "input",
  }) as Record<string, unknown>;

  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const recommendedTarget = (properties as Record<string, unknown>).recommendedTarget;
    if (recommendedTarget && typeof recommendedTarget === "object" && !Array.isArray(recommendedTarget)) {
      (recommendedTarget as Record<string, unknown>).enum = availableTargets;
    }
  }

  return schema;
}

export function renderLocalObserverPrompt(
  request: RenderLocalObserverPromptRequest,
): RenderLocalObserverPromptResponse {
  const availableTargets = request.availableTargets;
  const targetGuide = availableTargets.map((target) => `- ${target}: ${targetDescriptions[target]}`).join("\n");
  const schema = outputJsonSchema(availableTargets);

  const prompt = [
    request.casePrompt ?? "Classify this artifact snapshot and recommend the next routing target.",
    "",
    "You are a local observer. You only inspect the bounded snapshot below.",
    "Do not request tools. Do not mutate state. Do not invent unavailable facts.",
    "Prefer none when no work is needed. Prefer manager or human when evidence is insufficient.",
    "",
    "Available targets:",
    targetGuide,
    "",
    "Workspace policy:",
    "```json",
    stableJson(request.workspacePolicy),
    "```",
    "",
    "Artifact snapshot:",
    "```json",
    stableJson(request.artifactSnapshot),
    "```",
    "",
    "Return only JSON matching this schema:",
    "```json",
    stableJson(schema),
    "```",
  ].join("\n");

  return RenderLocalObserverPromptResponseSchema.parse({
    prompt,
    outputSchema: schema,
    artifactSnapshot: request.artifactSnapshot,
    availableTargets,
  });
}

function includesText(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function evidenceText(evidence: string[]) {
  return evidence.join("\n");
}

function pushFailure(
  failures: ValidateLocalObserverRecommendationResponse["failures"],
  assertionType: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
) {
  failures.push({ assertionType, message, expected, actual });
}

function validateExpectations(
  request: ValidateLocalObserverRecommendationRequest,
  expectations: LocalObserverRoutingExpectation,
) {
  const { recommendation } = request;
  const failures: ValidateLocalObserverRecommendationResponse["failures"] = [];
  const availableTargets = request.availableTargets ?? LocalObserverRecommendedTargetSchema.options;

  if (!availableTargets.includes(recommendation.recommendedTarget)) {
    pushFailure(
      failures,
      "available_targets",
      "Recommended target is outside the available target set.",
      availableTargets,
      recommendation.recommendedTarget,
    );
  }

  if (
    expectations.recommendedTargetIn &&
    !expectations.recommendedTargetIn.includes(recommendation.recommendedTarget)
  ) {
    pushFailure(
      failures,
      "recommended_target_in",
      "Recommended target is not in the allowed set.",
      expectations.recommendedTargetIn,
      recommendation.recommendedTarget,
    );
  }

  if (
    expectations.recommendedTargetNotIn &&
    expectations.recommendedTargetNotIn.includes(recommendation.recommendedTarget)
  ) {
    pushFailure(
      failures,
      "recommended_target_not_in",
      "Recommended target is explicitly disallowed.",
      expectations.recommendedTargetNotIn,
      recommendation.recommendedTarget,
    );
  }

  if (expectations.intentEquals && recommendation.intent !== expectations.intentEquals) {
    pushFailure(
      failures,
      "intent_equals",
      "Intent did not match the expected value.",
      expectations.intentEquals,
      recommendation.intent,
    );
  }

  if (expectations.confidenceMin !== undefined && recommendation.confidence < expectations.confidenceMin) {
    pushFailure(
      failures,
      "confidence_min",
      "Confidence is below the expected minimum.",
      expectations.confidenceMin,
      recommendation.confidence,
    );
  }

  if (expectations.confidenceMax !== undefined && recommendation.confidence > expectations.confidenceMax) {
    pushFailure(
      failures,
      "confidence_max",
      "Confidence is above the expected maximum.",
      expectations.confidenceMax,
      recommendation.confidence,
    );
  }

  const evidence = evidenceText(recommendation.evidence);
  for (const expectedEvidence of expectations.evidenceContains ?? []) {
    if (!includesText(evidence, expectedEvidence)) {
      pushFailure(
        failures,
        "evidence_contains",
        "Evidence did not mention an expected signal.",
        expectedEvidence,
        recommendation.evidence,
      );
    }
  }

  const riskFlags = evidenceText(recommendation.riskFlags);
  for (const expectedRiskFlag of expectations.requireRiskFlags ?? []) {
    if (!includesText(riskFlags, expectedRiskFlag)) {
      pushFailure(
        failures,
        "require_risk_flags",
        "Risk flags did not mention an expected signal.",
        expectedRiskFlag,
        recommendation.riskFlags,
      );
    }
  }

  return failures;
}

export function validateLocalObserverRecommendation(
  request: ValidateLocalObserverRecommendationRequest,
): ValidateLocalObserverRecommendationResponse {
  const expectations = request.expectations ?? {};
  const failures = validateExpectations(request, expectations);

  return ValidateLocalObserverRecommendationResponseSchema.parse({
    valid: failures.length === 0,
    recommendation: request.recommendation,
    failures,
  });
}
