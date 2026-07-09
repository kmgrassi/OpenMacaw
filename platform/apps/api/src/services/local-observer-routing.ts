import { z } from "zod";

import type {
  LocalObserverEvaluationJudgment,
  LocalObserverRemediationProposal,
  ProposeLocalObserverRemediationRequest,
  ProposeLocalObserverRemediationResponse,
  RenderLocalObserverEvaluationPromptRequest,
  RenderLocalObserverEvaluationPromptResponse,
  ReviewLocalObserverEvaluationRequest,
  ReviewLocalObserverEvaluationResponse,
} from "../../../../contracts/local-observer-routing.js";
import {
  LocalObserverEvaluationJudgmentSchema,
  ProposeLocalObserverRemediationResponseSchema,
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

type ParsedReviewRequest = ReviewLocalObserverEvaluationRequest & {
  judgment: LocalObserverEvaluationJudgment;
};

function reviewJudgmentAgainstTrace(request: ParsedReviewRequest) {
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
  const parsedJudgment = LocalObserverEvaluationJudgmentSchema.safeParse(request.judgment);

  if (!parsedJudgment.success) {
    return ReviewLocalObserverEvaluationResponseSchema.parse({
      accepted: false,
      judgment: null,
      notices: [
        {
          noticeType: "invalid_evaluator_judgment",
          message: "The evaluator tool call did not match the expected judgment schema.",
          details: z.flattenError(parsedJudgment.error),
        },
      ],
    });
  }

  const judgment: LocalObserverEvaluationJudgment = parsedJudgment.data;
  const notices = reviewJudgmentAgainstTrace({ ...request, judgment });

  return ReviewLocalObserverEvaluationResponseSchema.parse({
    accepted: true,
    judgment,
    notices,
  });
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function remediationKindFor(judgment: LocalObserverEvaluationJudgment) {
  if (judgment.verdict === "correct" || judgment.verdict === "inconclusive") {
    return "none" as const;
  }

  if (judgment.failureModes.includes("unsafe_action")) {
    return "human_review" as const;
  }

  if (
    judgment.failureModes.includes("bad_arguments") ||
    judgment.failureModes.includes("wrong_tool") ||
    judgment.failureModes.includes("missing_tool_call")
  ) {
    return "tool_schema" as const;
  }

  if (
    judgment.failureModes.includes("wasted_tokens") ||
    judgment.failureModes.includes("unnecessary_tool_call") ||
    judgment.failureModes.includes("missed_escalation") ||
    judgment.failureModes.includes("premature_escalation")
  ) {
    return "prompt_guidance" as const;
  }

  if (judgment.failureModes.includes("missed_context")) {
    return "code_change" as const;
  }

  return "eval_fixture" as const;
}

function severityFor(judgment: LocalObserverEvaluationJudgment) {
  if (judgment.failureModes.includes("unsafe_action")) return "high" as const;
  if (judgment.verdict === "incorrect") return "medium" as const;
  return "low" as const;
}

function titleFor(request: ProposeLocalObserverRemediationRequest) {
  const agent = request.trace.actingAgent.label ?? request.trace.actingAgent.role;
  const primaryIssue = request.judgment.issues[0] ?? request.judgment.observedBehavior;
  return `Fix ${agent} agent evaluation failure: ${primaryIssue}`.slice(0, 180);
}

function buildDescription(request: ProposeLocalObserverRemediationRequest) {
  const toolCalls = request.trace.toolCalls
    .map((toolCall) => `- ${toolCall.name}: ${stableJson(toolCall.arguments)}`)
    .join("\n");
  const failureModes =
    request.judgment.failureModes.length > 0
      ? request.judgment.failureModes.map((mode) => `- ${mode}`).join("\n")
      : "- none";
  const issues =
    request.judgment.issues.length > 0
      ? request.judgment.issues.map((issue) => `- ${issue}`).join("\n")
      : "- none recorded";

  return [
    "A stronger observer agent found a remediation-worthy agent behavior.",
    "",
    `Verdict: ${request.judgment.verdict}`,
    `Confidence: ${request.judgment.confidence}`,
    "",
    "Observed behavior:",
    request.judgment.observedBehavior,
    "",
    "Expected behavior:",
    request.judgment.expectedBehavior ?? "Not specified by evaluator.",
    "",
    "Reasoning:",
    request.judgment.reasoning,
    "",
    "Failure modes:",
    failureModes,
    "",
    "Issues:",
    issues,
    "",
    "Observed tool calls:",
    toolCalls || "- none",
    "",
    "Suggested follow-up:",
    request.judgment.suggestedFollowUp ?? "Ask the planner to inspect the trace and propose a fix.",
  ].join("\n");
}

function proposalFor(request: ProposeLocalObserverRemediationRequest): LocalObserverRemediationProposal {
  const remediationKind = remediationKindFor(request.judgment);
  const shouldCreateWorkItem =
    request.judgment.verdict === "incorrect" || request.judgment.verdict === "partially_correct";
  const toolSignature = request.trace.toolCalls.map((toolCall) => toolCall.name).join(",") || "no_tool_call";
  const failureSignature = request.judgment.failureModes.join(",") || request.judgment.verdict;
  const agentSignature = [
    request.trace.actingAgent.role,
    request.trace.actingAgent.provider,
    request.trace.actingAgent.model,
  ]
    .filter(Boolean)
    .join(":");
  const dedupeKey = [
    "local-observer",
    normalizeSlug(agentSignature || "agent"),
    normalizeSlug(failureSignature),
    normalizeSlug(toolSignature),
  ].join(":");

  return {
    shouldCreateWorkItem,
    remediationKind,
    severity: severityFor(request.judgment),
    dedupeKey,
    title: titleFor(request),
    description: buildDescription(request),
    evidence: [
      `traceId=${request.trace.traceId ?? "unknown"}`,
      `task=${request.trace.task}`,
      `verdict=${request.judgment.verdict}`,
      ...request.judgment.issues,
    ],
    labels: ["agent-observer", `remediation:${remediationKind}`, `severity:${severityFor(request.judgment)}`],
    metadata: {
      source: request.source,
      dedupeKey,
      traceId: request.trace.traceId ?? null,
      actingAgent: request.trace.actingAgent,
      failureModes: request.judgment.failureModes,
      observedToolCalls: request.trace.toolCalls.map((toolCall) => toolCall.name),
    },
  };
}

export function proposeLocalObserverRemediation(
  request: ProposeLocalObserverRemediationRequest,
): ProposeLocalObserverRemediationResponse {
  const proposal = proposalFor(request);
  const workItemDraft =
    proposal.shouldCreateWorkItem && request.workspaceId
      ? {
          workspaceId: request.workspaceId,
          title: proposal.title,
          description: proposal.description,
          priority: proposal.severity === "high" ? "high" : "normal",
          labels: proposal.labels,
          metadata: proposal.metadata,
        }
      : null;

  return ProposeLocalObserverRemediationResponseSchema.parse({
    proposal,
    workItemDraft,
  });
}
