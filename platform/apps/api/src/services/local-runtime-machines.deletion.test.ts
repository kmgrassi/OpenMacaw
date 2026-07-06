import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockSupabaseClient,
  localRuntimeMachinesModule,
  supabaseClientModule,
} from "./local-runtime-machines.test-support.js";

const { deleteLocalRuntimeForWorkspace } = localRuntimeMachinesModule;
const { getServiceRoleSupabase } = supabaseClientModule;

describe("deleteLocalRuntimeForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("revokes the local runtime machine and tokens after deleting the routing rules", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          runner_kind: "local_relay",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "agent-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "agent-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "token-1",
          workspace_id: workspaceId,
          machine_id: "machine-1",
          token_hash: "hash",
          revoked_at: null,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await deleteLocalRuntimeForWorkspace(workspaceId, "machine-1");

    expect(tables.routing_rule).toEqual([]);
    expect(tables.routing_rule_match).toEqual([]);
    expect(tables.local_runtime_machine[0]?.revoked_at).toEqual(expect.any(String));
    expect(tables.local_runtime_token[0]?.revoked_at).toEqual(expect.any(String));
  });

  it("removes all routing rules tied to a multi-kind machine in one delete", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-openai",
          workspace_id: workspaceId,
          runner_kind: "local_relay",
        },
        {
          id: "rule-openclaw",
          workspace_id: workspaceId,
          runner_kind: "local_relay",
        },
      ],
      routing_rule_match: [
        {
          id: "machine-match-openai",
          workspace_id: workspaceId,
          rule_id: "rule-openai",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "machine-match-openclaw",
          workspace_id: workspaceId,
          rule_id: "rule-openclaw",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "multi-helper",
          runner_kinds: ["openai_compatible", "openclaw"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "token-1",
          workspace_id: workspaceId,
          machine_id: "machine-1",
          token_hash: "hash",
          revoked_at: null,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await deleteLocalRuntimeForWorkspace(workspaceId, "machine-1");

    expect(tables.routing_rule).toEqual([]);
    expect(tables.routing_rule_match).toEqual([]);
    expect(tables.local_runtime_machine[0]?.revoked_at).toEqual(expect.any(String));
  });
});
