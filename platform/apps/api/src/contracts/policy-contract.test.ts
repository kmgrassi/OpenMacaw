import { describe, expect, it } from "vitest";

import { PolicyRowSchema, PolicySchema, RuntimePolicySchema } from "../../../../contracts/policy.js";

const policyId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

describe("policy contract", () => {
  it("validates API policy params against their policy kind", () => {
    expect(
      PolicySchema.safeParse({
        id: policyId,
        workspaceId,
        scope: "agent",
        agentId,
        sessionThreadId: null,
        kind: "max_tool_calls_per_session",
        params: { limit: 5 },
        priority: 0,
        enabled: true,
        source: "manual",
        reason: null,
        createdByUserId: null,
        createdAt: "2026-06-30T12:00:00.000Z",
      }).success,
    ).toBe(true);

    expect(
      PolicySchema.safeParse({
        id: policyId,
        workspaceId,
        scope: "agent",
        agentId,
        sessionThreadId: null,
        kind: "max_tool_calls_per_session",
        params: { tools: ["shell.exec"] },
        priority: 0,
        enabled: true,
        source: "manual",
        reason: null,
        createdByUserId: null,
        createdAt: "2026-06-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates DB policy row params against their policy kind", () => {
    expect(
      PolicyRowSchema.safeParse({
        id: policyId,
        workspace_id: workspaceId,
        scope: "workspace",
        agent_id: null,
        session_thread_id: null,
        kind: "block_tools",
        params: { tools: ["apply_patch"] },
        priority: 0,
        enabled: true,
        source: "system",
        reason: null,
        created_by_user_id: null,
        created_at: "2026-06-30T12:00:00.000Z",
      }).success,
    ).toBe(true);

    expect(
      PolicyRowSchema.safeParse({
        id: policyId,
        workspace_id: workspaceId,
        scope: "workspace",
        agent_id: null,
        session_thread_id: null,
        kind: "block_tools",
        params: { limit: 5 },
        priority: 0,
        enabled: true,
        source: "system",
        reason: null,
        created_by_user_id: null,
        created_at: "2026-06-30T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates runtime policy params against their policy kind", () => {
    expect(
      RuntimePolicySchema.safeParse({
        id: policyId,
        workspaceId,
        scope: "agent",
        agentId,
        sessionThreadId: null,
        kind: "cost_budget",
        params: { maxCostUsd: 25, askThresholdsUsd: [10] },
        priority: 0,
        source: "manual",
        reason: null,
      }).success,
    ).toBe(true);

    expect(
      RuntimePolicySchema.safeParse({
        id: policyId,
        workspaceId,
        scope: "agent",
        agentId,
        sessionThreadId: null,
        kind: "cost_budget",
        params: { limit: 5 },
        priority: 0,
        source: "manual",
        reason: null,
      }).success,
    ).toBe(false);
  });
});
