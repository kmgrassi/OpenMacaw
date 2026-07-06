import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockSupabaseClient,
  localRuntimeMachinesModule,
  supabaseClientModule,
} from "./local-runtime-machines.test-support.js";

const { registerLocalRuntimeForWorkspace } = localRuntimeMachinesModule;
const { getServiceRoleSupabase } = supabaseClientModule;

describe("registerLocalRuntimeForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("adds local model coding and planner support when reusing an existing machine", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [],
      routing_rule: [],
      routing_rule_match: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine[0]?.runner_kinds).toEqual([
      "openai_compatible",
      "local_model_coding",
      "planner",
    ]);
  });

  it("registers a new openclaw-only machine with runner_kinds: ['openclaw']", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine).toHaveLength(1);
    expect(tables.local_runtime_machine[0]).toMatchObject({
      runner_kinds: ["openclaw"],
    });
    expect(tables.routing_rule).toHaveLength(1);
    expect(tables.routing_rule[0]).toMatchObject({
      runner_kind: "local_relay",
      provider: "openclaw",
      model: null,
    });
  });

  it("registers a multi-kind machine with one routing rule per runner", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine).toHaveLength(1);
    expect(tables.local_runtime_machine[0]?.runner_kinds).toEqual(
      expect.arrayContaining(["openai_compatible", "local_model_coding", "planner", "openclaw"]),
    );
    expect(tables.routing_rule).toHaveLength(2);
    expect(tables.routing_rule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner_kind: "local_relay",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
        }),
        expect.objectContaining({
          runner_kind: "local_relay",
          provider: "openclaw",
          model: null,
        }),
      ]),
    );
  });

  it("revokes other active workspace machines and tokens when registering a machine", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "current-machine",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
        {
          id: "old-machine",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "llama3.1:8b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
        {
          id: "other-workspace-machine",
          workspace_id: "workspace-2",
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [
        {
          id: "current-token",
          workspace_id: workspaceId,
          machine_id: "current-machine",
          token_hash: "current",
          revoked_at: null,
        },
        {
          id: "old-token",
          workspace_id: workspaceId,
          machine_id: "old-machine",
          token_hash: "old",
          revoked_at: null,
        },
        {
          id: "other-workspace-token",
          workspace_id: "workspace-2",
          machine_id: "other-workspace-machine",
          token_hash: "other",
          revoked_at: null,
        },
      ],
      routing_rule: [],
      routing_rule_match: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.local_runtime_machine.find((machine) => machine.id === "current-machine")?.revoked_at).toBeNull();
    expect(tables.local_runtime_machine.find((machine) => machine.id === "old-machine")?.revoked_at).toEqual(
      expect.any(String),
    );
    expect(
      tables.local_runtime_machine.find((machine) => machine.id === "other-workspace-machine")?.revoked_at,
    ).toBeNull();
    expect(tables.local_runtime_token.find((token) => token.id === "old-token")?.revoked_at).toEqual(
      expect.any(String),
    );
    expect(tables.local_runtime_token.find((token) => token.id === "current-token")?.revoked_at).toBeNull();
    expect(tables.local_runtime_token.find((token) => token.id === "other-workspace-token")?.revoked_at).toBeNull();
  });

  it("repairs workspace-root local runtime rules with the registered machine id", async () => {
    const workspaceId = "workspace-1";
    const userId = "user-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: userId,
          display_name: "qwen3-coder:30b@127.0.0.1:11434",
          runner_kinds: ["openai_compatible"],
          revoked_at: null,
        },
      ],
      local_runtime_token: [],
      routing_rule: [
        {
          id: "existing-rule",
          workspace_id: workspaceId,
          name: "local:qwen",
          runner_kind: "local_relay",
          enabled: true,
        },
      ],
      routing_rule_match: [
        {
          id: "workspace-root-match",
          workspace_id: workspaceId,
          rule_id: "existing-rule",
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await registerLocalRuntimeForWorkspace({
      workspaceId,
      userId,
      request: {
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      },
    });

    expect(tables.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "existing-rule",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        }),
      ]),
    );
  });
});
