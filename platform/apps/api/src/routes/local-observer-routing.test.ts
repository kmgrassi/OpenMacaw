import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProposeLocalObserverRemediationResponseSchema,
  RenderLocalObserverEvaluationPromptResponseSchema,
  ReviewLocalObserverEvaluationResponseSchema,
} from "../../../../contracts/local-observer-routing.js";
import { registerLocalObserverRoutingRoutes } from "./local-observer-routing.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const artifactSnapshot = {
  kind: "pull_request",
  provider: "github",
  locator: { repository: "kmgrassi/OpenMacaw", number: 355 },
  version: "abc123",
  title: "Add local observer routing API",
  summary: "Adds local observer evaluation scaffolding.",
  state: {
    status: "open",
    checks: [{ name: "api", status: "passed" }],
    reviews: [{ author_kind: "ai", state: "commented" }],
  },
  signals: ["review comment present", "api-only change", "tests present"],
};

const trace = {
  traceId: "trace-1",
  actingAgent: {
    role: "routing",
    provider: "local",
    model: "small-local-model",
  },
  task: "Decide whether a PR with an actionable review comment needs another run.",
  artifactSnapshot,
  workspacePolicy: { preferCheapObservation: true },
  availableTools: [
    {
      name: "dispatch_runner",
      description: "Dispatch a runner for follow-up work.",
      parameters: {
        type: "object",
        properties: {
          runner: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    {
      name: "mark_done",
      description: "Mark the item complete when no more action is needed.",
      parameters: { type: "object", properties: {} },
    },
  ],
  promptSummary: "The agent saw a PR with one unresolved review comment.",
  toolCalls: [
    {
      id: "call-1",
      name: "dispatch_runner",
      arguments: {
        runner: "codex",
        reason: "Address the review comment.",
      },
      status: "completed",
      result: { runId: "run-1" },
    },
  ],
  outcome: { followUpRunStarted: true },
};

describe("local observer routing routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    registerLocalObserverRoutingRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("renders a stronger-agent evaluation prompt from an agent trace", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/render-evaluation-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trace,
        evaluator: {
          role: "observer",
          provider: "openai",
          model: "strong-evaluator-model",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = RenderLocalObserverEvaluationPromptResponseSchema.parse(await response.json());

    expect(body.prompt).toContain("stronger observer agent");
    expect(body.prompt).toContain("dispatch_runner");
    expect(body.prompt).toContain('"number": 355');
    expect(body.evaluationTool.name).toBe("observer_record_evaluation");
    expect(body.evaluationTool.parameters).toHaveProperty("type", "object");
    expect(body.trace.toolCalls[0]?.name).toBe("dispatch_runner");
  });

  it("accepts an evaluator judgment without constraining the acting agent", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/review-evaluation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trace,
        judgment: {
          verdict: "correct",
          confidence: 0.86,
          reasoning: "The acting agent saw an unresolved review comment and dispatched Codex with a relevant reason.",
          observedBehavior: "The agent called dispatch_runner with runner=codex.",
          expectedBehavior: "A follow-up coding run should be started to address the comment.",
          failureModes: [],
          strengths: ["used available review context", "called a relevant tool"],
          issues: [],
          suggestedFollowUp: null,
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ReviewLocalObserverEvaluationResponseSchema.parse(await response.json());

    expect(body.accepted).toBe(true);
    expect(body.judgment).not.toBeNull();
    if (!body.judgment) throw new Error("Expected accepted judgment");
    expect(body.judgment.verdict).toBe("correct");
    expect(body.notices).toEqual([]);
  });

  it("surfaces trace quality notices instead of blocking edge-case judgment", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/review-evaluation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trace: {
          ...trace,
          toolCalls: [
            {
              name: "experimental_handoff",
              arguments: { reason: "Edge-case handoff" },
              status: "completed",
            },
          ],
        },
        judgment: {
          verdict: "incorrect",
          confidence: 0.74,
          reasoning:
            "The handoff did not use the documented tool surface and did not explain why the normal dispatch tool was insufficient.",
          observedBehavior: "The agent called an unlisted handoff tool.",
          failureModes: ["wrong_tool"],
          strengths: [],
          issues: [],
          suggestedFollowUp: "Record why this edge case needs a new handoff tool if the behavior is intentional.",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ReviewLocalObserverEvaluationResponseSchema.parse(await response.json());

    expect(body.accepted).toBe(true);
    expect(body.notices.map((notice) => notice.noticeType)).toEqual([
      "unknown_tool_call_observed",
      "missing_issue_detail",
    ]);
  });

  it("records malformed evaluator judgments as observability notices", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/review-evaluation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trace,
        judgment: {
          verdict: "incorrect",
          confidence: 0.74,
          reasoning: "The acting agent dispatched a runner unnecessarily.",
          observedBehavior: "The agent called dispatch_runner.",
          failureModes: ["unnecessary_tool_call"],
          strengths: "",
          issues: ["Started a run when no work remained."],
          suggestedFollowUp: null,
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ReviewLocalObserverEvaluationResponseSchema.parse(await response.json());

    expect(body.accepted).toBe(false);
    expect(body.judgment).toBeNull();
    expect(body.notices.map((notice) => notice.noticeType)).toEqual(["invalid_evaluator_judgment"]);
  });

  it("proposes a remediation work-item draft for incorrect judgments", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/propose-remediation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        trace: {
          ...trace,
          toolCalls: [
            {
              name: "dispatch_runner",
              arguments: { runner_kind: "codex", intent: "address_review" },
              status: "completed",
            },
          ],
        },
        judgment: {
          verdict: "incorrect",
          confidence: 0.91,
          reasoning: "The PR had no unresolved comments, so dispatching a runner was wasteful.",
          observedBehavior: "The local routing agent called dispatch_runner.",
          expectedBehavior: "The agent should have called mark_done.",
          failureModes: ["wrong_tool", "wasted_tokens"],
          strengths: [],
          issues: ["Started a coding runner when no work remained."],
          suggestedFollowUp: "Improve manager tool guidance for no-op PR states.",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ProposeLocalObserverRemediationResponseSchema.parse(await response.json());

    expect(body.proposal.shouldCreateWorkItem).toBe(true);
    expect(body.proposal.remediationKind).toBe("tool_schema");
    expect(body.proposal.dedupeKey).toContain("wrong-tool-wasted-tokens");
    expect(body.workItemDraft?.workspaceId).toBe("workspace-1");
    expect(body.workItemDraft?.title).toContain("Fix routing agent evaluation failure");
    expect(body.workItemDraft?.description).toContain("Observed behavior:");
    expect(body.workItemDraft?.metadata.failureModes).toEqual(["wrong_tool", "wasted_tokens"]);
  });

  it("does not create a work-item draft for correct judgments", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/propose-remediation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        trace,
        judgment: {
          verdict: "correct",
          confidence: 0.88,
          reasoning: "The agent used the expected tool.",
          observedBehavior: "The local routing agent called dispatch_runner.",
          expectedBehavior: "Dispatch a runner for actionable review feedback.",
          failureModes: [],
          strengths: ["Used the available context."],
          issues: [],
          suggestedFollowUp: null,
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ProposeLocalObserverRemediationResponseSchema.parse(await response.json());

    expect(body.proposal.shouldCreateWorkItem).toBe(false);
    expect(body.proposal.remediationKind).toBe("none");
    expect(body.workItemDraft).toBeNull();
  });
});
