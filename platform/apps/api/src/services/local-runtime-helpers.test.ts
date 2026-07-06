import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase, getUserScopedSupabase } from "../supabase-client.js";
import { assignLocalModelToAgent } from "./local-runtime-helpers.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

describe("local runtime helper assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects assignment before service-role writes when the agent is outside the requested workspace", async () => {
    const serviceTables = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: "workspace-1",
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "local-machine-match",
          workspace_id: "workspace-1",
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
      agent: [],
    };
    const userTables = {
      agent: [
        {
          id: "agent-1",
          name: "Coding",
          workspace_id: "workspace-2",
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };

    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(serviceTables) as never);
    vi.mocked(getUserScopedSupabase).mockReturnValue(createMockSupabaseClient(userTables) as never);

    await expect(
      assignLocalModelToAgent({
        workspaceId: "workspace-1",
        localRuntimeId: "local-rule-1",
        machineId: "machine-1",
        agentId: "agent-1",
        auth: {
          accessToken: "test-token",
          userId: "user-1",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_not_found",
    });

    expect(getUserScopedSupabase).toHaveBeenCalledWith("test-token");
    expect(getServiceRoleSupabase).not.toHaveBeenCalled();
    expect(serviceTables.routing_rule_match).toEqual([
      expect.objectContaining({
        kind: "local_machine",
        value: "machine-1",
      }),
    ]);
  });

  it("rejects malformed machine-match rows instead of trusting the query shape", async () => {
    const serviceTables = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: "workspace-1",
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "local-machine-match",
          workspace_id: "workspace-1",
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: 42,
        },
      ],
      agent: [],
    };
    const userTables = {
      agent: [
        {
          id: "agent-1",
          name: "Coding",
          workspace_id: "workspace-1",
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };

    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(serviceTables) as never);
    vi.mocked(getUserScopedSupabase).mockReturnValue(createMockSupabaseClient(userTables) as never);

    await expect(
      assignLocalModelToAgent({
        workspaceId: "workspace-1",
        localRuntimeId: "local-rule-1",
        agentId: "agent-1",
        auth: {
          accessToken: "test-token",
          userId: "user-1",
        },
      }),
    ).rejects.toMatchObject({
      name: "SupabaseRowParseError",
      code: "invalid_supabase_row",
    });
  });
});
