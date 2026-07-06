import { describe, expect, it } from "vitest";

import {
  CreateSessionPolicyRequestSchema,
  PolicySchema,
  UpsertAgentPolicyRequestSchema,
} from "../../../../contracts/policy.js";

describe("policy contract", () => {
  it("validates request params against the selected policy kind", () => {
    expect(
      UpsertAgentPolicyRequestSchema.safeParse({
        workspaceId: "workspace-1",
        kind: "cost_budget",
        params: { max_cost_usd: 10, ask_thresholds_usd: [5] },
      }).success,
    ).toBe(true);

    expect(
      UpsertAgentPolicyRequestSchema.safeParse({
        workspaceId: "workspace-1",
        kind: "cost_budget",
        params: { limit: 5 },
      }).success,
    ).toBe(false);

    expect(
      CreateSessionPolicyRequestSchema.safeParse({
        workspaceId: "workspace-1",
        kind: "block_tools",
        params: { limit: 5 },
      }).success,
    ).toBe(false);
  });

  it("validates response params against the selected policy kind", () => {
    expect(
      PolicySchema.safeParse({
        id: "policy-1",
        workspaceId: "workspace-1",
        scope: "agent",
        agentId: "agent-1",
        sessionThreadId: null,
        kind: "max_tool_calls_per_session",
        params: { tools: ["shell.exec"] },
        priority: 0,
        enabled: true,
        source: "manual",
        reason: null,
        createdByUserId: null,
        createdAt: "2026-06-30T12:00:00.000Z",
        updatedAt: null,
      }).success,
    ).toBe(false);
  });
});
