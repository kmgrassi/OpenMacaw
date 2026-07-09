import { describe, expect, it, vi } from "vitest";

import { resolveSessionPolicies } from "./policy-resolver.js";
import type { PolicyRow } from "../../../../contracts/policy.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const sessionThreadId = "77777777-7777-4777-8777-777777777777";

function policyRow(overrides: Partial<PolicyRow>): PolicyRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspace_id: workspaceId,
    scope: "workspace",
    agent_id: null,
    session_thread_id: null,
    kind: "block_tools",
    params: { kind: "block_tools", tools: ["shell.exec"] },
    priority: 100,
    enabled: true,
    source: "manual",
    reason: null,
    created_by_user_id: null,
    created_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function supabaseWithRows(rows: PolicyRow[]) {
  const queries: Array<{
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    then: (resolve: (value: { data: PolicyRow[]; error: null }) => void) => void;
  }> = [];
  return {
    supabase: {
      from: vi.fn(() => {
        const queryIndex = queries.length;
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          then: (resolve: (value: { data: PolicyRow[]; error: null }) => void) => {
            const data =
              queryIndex === 0
                ? rows.filter((row) => row.scope === "workspace")
                : queryIndex === 1
                  ? rows.filter((row) => row.scope === "agent")
                  : rows.filter((row) => row.scope === "session");
            resolve({ data, error: null });
          },
        };
        queries.push(query);
        return query;
      }),
    },
    queries,
  };
}

describe("resolveSessionPolicies", () => {
  it("loads enabled policies for workspace, agent, and session and orders the effective set by tier", async () => {
    const workspacePolicy = policyRow({
      id: "44444444-4444-4444-8444-444444444444",
      scope: "workspace",
      priority: 1,
    });
    const agentPolicy = policyRow({
      id: "55555555-5555-4555-8555-555555555555",
      scope: "agent",
      agent_id: agentId,
      kind: "max_tool_calls_per_session",
      params: { kind: "max_tool_calls_per_session", limit: 3 },
      priority: 10,
    });
    const sessionPolicy = policyRow({
      id: "66666666-6666-4666-8666-666666666666",
      scope: "session",
      session_thread_id: sessionThreadId,
      kind: "ask_on_shell",
      params: { kind: "ask_on_shell" },
      priority: 20,
    });
    const { supabase, queries } = supabaseWithRows([workspacePolicy, agentPolicy, sessionPolicy]);

    const resolution = await resolveSessionPolicies({
      agentId,
      workspaceId,
      sessionThreadId,
      supabase: supabase as never,
    });

    expect(supabase.from).toHaveBeenCalledTimes(3);
    expect(queries[0]?.eq).toHaveBeenCalledWith("scope", "workspace");
    expect(queries[1]?.eq).toHaveBeenCalledWith("scope", "agent");
    expect(queries[1]?.eq).toHaveBeenCalledWith("agent_id", agentId);
    expect(queries[2]?.eq).toHaveBeenCalledWith("scope", "session");
    expect(queries[2]?.eq).toHaveBeenCalledWith("session_thread_id", sessionThreadId);
    expect(resolution.workspacePolicies).toHaveLength(1);
    expect(resolution.agentPolicies).toHaveLength(1);
    expect(resolution.sessionPolicies).toHaveLength(1);
    expect(resolution.effectivePolicies.map((policy) => policy.scope)).toEqual(["session", "agent", "workspace"]);
  });
});
