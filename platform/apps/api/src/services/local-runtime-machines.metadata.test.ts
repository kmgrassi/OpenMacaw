import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockSupabaseClient,
  localRuntimeMachinesModule,
  supabaseClientModule,
} from "./local-runtime-machines.test-support.js";

const { getLocalRuntimeConfigForWorkspace, listLocalRuntimesForWorkspace } = localRuntimeMachinesModule;
const { getServiceRoleSupabase } = supabaseClientModule;

describe("listLocalRuntimesForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects malformed routing metadata rows instead of trusting casted projections", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
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
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: null,
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(listLocalRuntimesForWorkspace(workspaceId)).rejects.toMatchObject({
      name: "SupabaseRowParseError",
      code: "invalid_supabase_row",
    });
  });

  it("ignores nullable match keys when a caller asks for a specific key", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
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
          id: "legacy-null-key-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_workspace_root",
          key: null,
          value: "/tmp/legacy",
        },
        {
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(listLocalRuntimesForWorkspace(workspaceId)).resolves.toMatchObject({
      runtimes: [
        {
          id: "machine-1",
          runners: [
            {
              id: "rule-1",
              endpoint: "http://127.0.0.1:11434/v1",
            },
          ],
        },
      ],
    });
  });
});

describe("getLocalRuntimeConfigForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects malformed required endpoint metadata instead of silently dropping a runner", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          last_seen_at: null,
          revoked_at: null,
        },
      ],
      routing_rule: [
        {
          id: "rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
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
          id: "endpoint-match",
          workspace_id: workspaceId,
          rule_id: "rule-1",
          kind: "local_endpoint",
          key: "url",
          value: null,
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(getLocalRuntimeConfigForWorkspace(workspaceId, "machine-1")).rejects.toMatchObject({
      name: "SupabaseRowParseError",
      code: "invalid_supabase_row",
    });
  });
});
