import { z } from "zod";

import type {
  LocalObserverEvaluationJudgment,
  RenderLocalObserverEvaluationPromptRequest,
  RenderLocalObserverEvaluationPromptResponse,
  ReviewLocalObserverEvaluationRequest,
  ReviewLocalObserverEvaluationResponse,
} from "../../../../contracts/local-observer-routing.js";
import {
  LocalObserverEvaluationJudgmentSchema,
  RenderLocalObserverEvaluationPromptResponseSchema,
  ReviewLocalObserverEvaluationResponseSchema,
} from "../../../../contracts/local-observer-routing.js";

const evaluationToolName = "observer_record_evaluation";

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function evaluationParametersSchema() {
  return z.toJSONSchema(LocalObserverEvaluationJudgmentSchema, {
    io: "input",
  }) as Record<string, unknown>;
}

function evaluationToolSpec() {
  return {
    name: evaluationToolName,
    description:
      "Record a stronger evaluator agent's judgment of whether the observed agent made a good tool-use or routing decision.",
    parameters: evaluationParametersSchema(),
  };
}

function defaultRubric() {
  return [
    "Judge whether the acting agent made a reasonable decision for the situation, including edge cases.",
    "Prefer reasoning from the trace over rigid target matching.",
    "Evaluate tool selection, tool arguments, unnecessary work, missed escalation, and use of available context.",
    "Mark the result inconclusive when the trace lacks enough evidence.",
    "Do not mutate state or propose a new live action; only record an evaluation judgment.",
  ];
}

export function renderLocalObserverEvaluationPrompt(
  request: RenderLocalObserverEvaluationPromptRequest,
): RenderLocalObserverEvaluationPromptResponse {
  const rubric = request.rubric.length > 0 ? request.rubric : defaultRubric();
  const prompt = [
    request.casePrompt ?? "Evaluate whether the acting agent made the right tool-use or routing decision.",
    "",
    "You are a stronger observer agent evaluating another agent after the fact.",
    "The observed agent was allowed to reason normally and use its normal tool surface.",
    "Your job is observability: decide whether the trace shows good judgment.",
    "",
    "Rubric:",
    ...rubric.map((item) => `- ${item}`),
    "",
    "Evaluator:",
    "```json",
    stableJson(request.evaluator),
    "```",
    "",
    "Observed agent trace:",
    "```json",
    stableJson(request.trace),
    "```",
    "",
    `Call ${evaluationToolName} with your judgment. Do not call tools from the observed trace.`,
  ].join("\n");

  return RenderLocalObserverEvaluationPromptResponseSchema.parse({
    prompt,
    evaluationTool: evaluationToolSpec(),
    trace: request.trace,
  });
}

function addNotice(
  notices: ReviewLocalObserverEvaluationResponse["notices"],
  noticeType: string,
  message: string,
  details?: unknown,
) {
  notices.push({ noticeType, message, details });
}

function toolNamesFromTrace(request: ReviewLocalObserverEvaluationRequest) {
  return new Set(request.trace.availableTools.map((tool) => tool.name));
}

function reviewJudgmentAgainstTrace(request: ReviewLocalObserverEvaluationRequest) {
  const notices: ReviewLocalObserverEvaluationResponse["notices"] = [];
  const availableToolNames = toolNamesFromTrace(request);
  const calledUnknownTools = request.trace.toolCalls
    .map((toolCall) => toolCall.name)
    .filter((name) => availableToolNames.size > 0 && !availableToolNames.has(name));

  if (calledUnknownTools.length > 0) {
    addNotice(
      notices,
      "unknown_tool_call_observed",
      "The trace includes tool calls that were not listed in availableTools.",
      calledUnknownTools,
    );
  }

  if (request.judgment.verdict === "incorrect" && request.judgment.issues.length === 0) {
    addNotice(
      notices,
      "missing_issue_detail",
      "Incorrect judgments should include at least one issue for downstream observability.",
    );
  }

  if (request.judgment.failureModes.length > 0 && request.judgment.verdict === "correct") {
    addNotice(
      notices,
      "failure_modes_on_correct_verdict",
      "A correct judgment included failure modes; verify that this is intentional.",
      request.judgment.failureModes,
    );
  }

  return notices;
}

export function reviewLocalObserverEvaluation(
  request: ReviewLocalObserverEvaluationRequest,
): ReviewLocalObserverEvaluationResponse {
  const judgment: LocalObserverEvaluationJudgment = LocalObserverEvaluationJudgmentSchema.parse(request.judgment);
  const notices = reviewJudgmentAgainstTrace({ ...request, judgment });

  return ReviewLocalObserverEvaluationResponseSchema.parse({
    accepted: true,
    judgment,
    notices,
  });
}
