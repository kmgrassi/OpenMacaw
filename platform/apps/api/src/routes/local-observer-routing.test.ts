import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RenderLocalObserverPromptResponseSchema,
  ValidateLocalObserverRecommendationResponseSchema,
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
  locator: { repository: "kmgrassi/OpenMacaw", number: 352 },
  version: "abc123",
  title: "Add failure pattern mining scope",
  summary: "Adds a docs-only scoping document.",
  state: {
    status: "open",
    checks: [{ name: "docs", status: "passed" }],
    reviews: [{ author_kind: "ai", state: "approved" }],
  },
  signals: ["docs only", "checks passed", "approved"],
  diffSummary: {
    files_changed: 2,
    paths: ["platform/docs/active/failure-pattern-mining-scope.md"],
  },
  constraints: {
    local_model_allowed_actions: ["observe", "recommend"],
  },
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

  it("renders a bounded observer prompt from an artifact snapshot", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/render-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactSnapshot,
        workspacePolicy: { preferCheapObservation: true },
        availableTargets: ["none", "manager", "codex", "claude_code", "human"],
      }),
    });

    expect(response.status).toBe(200);
    const body = RenderLocalObserverPromptResponseSchema.parse(await response.json());

    expect(body.availableTargets).toEqual(["none", "manager", "codex", "claude_code", "human"]);
    expect(body.prompt).toContain("You are a local observer.");
    expect(body.prompt).toContain('"kind": "pull_request"');
    expect(body.prompt).toContain('"repository": "kmgrassi/OpenMacaw"');
    expect(body.prompt).toContain("Return only JSON matching this schema");
    expect(body.outputSchema).toHaveProperty("type", "object");
  });

  it("validates a matching routing recommendation", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/validate-recommendation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recommendation: {
          recommendedTarget: "none",
          intent: "no_action",
          confidence: 0.91,
          reason: "The snapshot is already approved and checks passed.",
          evidence: ["checks passed", "approved review"],
          riskFlags: [],
          followUp: null,
        },
        expectations: {
          recommendedTargetIn: ["none"],
          intentEquals: "no_action",
          confidenceMin: 0.8,
          evidenceContains: ["approved"],
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ValidateLocalObserverRecommendationResponseSchema.parse(await response.json());

    expect(body.valid).toBe(true);
    expect(body.failures).toEqual([]);
  });

  it("returns deterministic assertion failures for a bad recommendation", async () => {
    const response = await fetch(`${baseUrl}/api/evals/local-observer-routing/validate-recommendation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recommendation: {
          recommendedTarget: "local_model_coding",
          intent: "fix",
          confidence: 0.99,
          reason: "Use local coding.",
          evidence: ["small diff"],
          riskFlags: [],
        },
        expectations: {
          recommendedTargetNotIn: ["local_model_coding"],
          intentEquals: "ask_human",
          confidenceMax: 0.8,
          evidenceContains: ["policy"],
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = ValidateLocalObserverRecommendationResponseSchema.parse(await response.json());

    expect(body.valid).toBe(false);
    expect(body.failures.map((failure) => failure.assertionType)).toEqual([
      "recommended_target_not_in",
      "intent_equals",
      "confidence_max",
      "evidence_contains",
    ]);
  });
});
