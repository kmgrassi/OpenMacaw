import { describe, expect, it } from "vitest";
import type { AgentPolicySettingsResponse } from "../../../../../contracts/policy";
import { editableAgentPolicies } from "./AgentPoliciesPanel";

const workspacePolicy = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  scope: "workspace" as const,
  agentId: null,
  sessionThreadId: null,
  kind: "ask_on_shell" as const,
  params: { kind: "ask_on_shell" as const },
  priority: 0,
  enabled: true,
  source: "manual" as const,
  reason: null,
  createdByUserId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

const agentPolicy = {
  ...workspacePolicy,
  id: "44444444-4444-4444-8444-444444444444",
  scope: "agent" as const,
  agentId: "55555555-5555-4555-8555-555555555555",
};

describe("editableAgentPolicies", () => {
  it("returns only agent-tier policies", () => {
    const settings = {
      availableKinds: [],
      workspacePolicies: [workspacePolicy],
      agentPolicies: [agentPolicy],
      sessionPolicies: [],
      effectivePolicies: [],
    } satisfies AgentPolicySettingsResponse;

    expect(editableAgentPolicies(settings)).toEqual([agentPolicy]);
  });
});
