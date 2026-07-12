import { describe, expect, it } from "vitest";

import { EscalationReasonKindSchema } from "../../../../contracts/escalation.js";
import {
  POLICY_KIND_REGISTRY,
  POLICY_KINDS,
  PolicyParamsSchema,
  PolicyRowSchema,
  PolicySchema,
  PolicyVerdictSchema,
} from "../../../../contracts/policy.js";

const policyId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const sessionThreadId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

describe("policy contract", () => {
  it("registers every policy kind with a matching params schema", () => {
    expect(Object.keys(POLICY_KIND_REGISTRY).sort()).toEqual([...POLICY_KINDS].sort());

    for (const kind of POLICY_KINDS) {
      expect(POLICY_KIND_REGISTRY[kind].kind).toBe(kind);
      expect(POLICY_KIND_REGISTRY[kind].eventTypes.length).toBeGreaterThan(0);
    }
  });

  it("parses policy verdicts", () => {
    expect(PolicyVerdictSchema.parse("allow")).toBe("allow");
    expect(PolicyVerdictSchema.parse("deny")).toBe("deny");
    expect(PolicyVerdictSchema.parse("ask")).toBe("ask");
    expect(PolicyVerdictSchema.safeParse("abstain").success).toBe(false);
  });

  it.each([
    [
      "max_tool_calls_per_session",
      { kind: "max_tool_calls_per_session", limit: 5 },
      { kind: "max_tool_calls_per_session", limit: 0 },
    ],
    [
      "cost_budget",
      {
        kind: "cost_budget",
        max_cost_usd: 10,
        ask_thresholds_usd: [2.5, 5],
      },
      {
        kind: "cost_budget",
        max_cost_usd: 10,
        ask_thresholds_usd: [12],
      },
    ],
    ["ask_on_shell", { kind: "ask_on_shell" }, { kind: "ask_on_shell", tools: ["shell.exec"] }],
    ["ask_on_tool", { kind: "ask_on_tool", tools: ["shell.exec"] }, { kind: "ask_on_tool", tools: [] }],
    ["block_tools", { kind: "block_tools", tools: ["apply_patch"] }, { kind: "block_tools", tools: [""] }],
    [
      "risk_score",
      {
        kind: "risk_score",
        guarded_tools: ["shell.exec"],
        threshold: 10,
        weights: { destructive_action: 4 },
      },
      {
        kind: "risk_score",
        guarded_tools: ["shell.exec"],
        threshold: -1,
        weights: { destructive_action: 4 },
      },
    ],
  ])("validates %s params", (_kind, valid, invalid) => {
    expect(PolicyParamsSchema.safeParse(valid).success).toBe(true);
    expect(PolicyParamsSchema.safeParse(invalid).success).toBe(false);
  });

  it("parses API-shaped policies", () => {
    const parsed = PolicySchema.parse({
      id: policyId,
      workspaceId,
      scope: "agent",
      agentId,
      sessionThreadId: null,
      kind: "block_tools",
      params: { kind: "block_tools", tools: ["shell.exec"] },
      priority: 10,
      enabled: true,
      source: "manual",
      reason: "No shell access for this agent.",
      createdByUserId: userId,
      createdAt: "2026-06-30T12:00:00.000Z",
    });

    expect(parsed.scope).toBe("agent");
    expect(parsed.params.kind).toBe("block_tools");
  });

  it("rejects API-shaped policies when params kind does not match the policy kind", () => {
    const result = PolicySchema.safeParse({
      id: policyId,
      workspaceId,
      scope: "agent",
      agentId,
      sessionThreadId: null,
      kind: "block_tools",
      params: { kind: "ask_on_tool", tools: ["shell.exec"] },
      priority: 10,
      enabled: true,
      source: "manual",
      reason: null,
      createdByUserId: userId,
      createdAt: "2026-06-30T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("parses DB-shaped policy rows", () => {
    const parsed = PolicyRowSchema.parse({
      id: policyId,
      workspace_id: workspaceId,
      scope: "session",
      agent_id: null,
      session_thread_id: sessionThreadId,
      kind: "max_tool_calls_per_session",
      params: { kind: "max_tool_calls_per_session", limit: 20 },
      priority: 0,
      enabled: true,
      source: "system",
      reason: null,
      created_by_user_id: userId,
      created_at: "2026-06-30T12:00:00.000Z",
    });

    expect(parsed.session_thread_id).toBe(sessionThreadId);
  });

  it("accepts offset timestamps returned by Supabase", () => {
    const parsed = PolicyRowSchema.parse({
      id: policyId,
      workspace_id: workspaceId,
      scope: "agent",
      agent_id: agentId,
      session_thread_id: null,
      kind: "max_tool_calls_per_session",
      params: { kind: "max_tool_calls_per_session", limit: 20 },
      priority: 0,
      enabled: true,
      source: "manual",
      reason: null,
      created_by_user_id: userId,
      created_at: "2026-06-30T12:00:00+00",
      updated_at: "2026-06-30T12:01:00+00",
    });

    expect(parsed.updated_at).toBe("2026-06-30T12:01:00+00:00");
  });

  it("rejects DB-shaped policy rows when params kind does not match the policy kind", () => {
    const result = PolicyRowSchema.safeParse({
      id: policyId,
      workspace_id: workspaceId,
      scope: "session",
      agent_id: null,
      session_thread_id: sessionThreadId,
      kind: "ask_on_tool",
      params: { kind: "block_tools", tools: ["apply_patch"] },
      priority: 0,
      enabled: true,
      source: "system",
      reason: null,
      created_by_user_id: userId,
      created_at: "2026-06-30T12:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("includes policy_ask in escalation reason kinds", () => {
    expect(EscalationReasonKindSchema.parse("policy_ask")).toBe("policy_ask");
  });
});
