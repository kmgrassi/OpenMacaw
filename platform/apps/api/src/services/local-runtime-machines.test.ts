import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as RuntimeTargetModule from "./runtime-target.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("./runtime-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeTargetModule>();
  return {
    ...actual,
    resolveRuntimeTargetForAgent: vi.fn(),
    localOrchestratorRuntimeTarget: vi.fn(),
  };
});

const {
  deleteLocalRuntimeForWorkspace,
  getLocalRuntimeConfigForWorkspace,
  listLocalRuntimesForWorkspace,
  registerLocalRuntimeForWorkspace,
  testLocalRuntimeDispatchForWorkspace,
} = await import("./local-runtime-machines.js");
const { localOrchestratorRuntimeTarget, resolveRuntimeTargetForAgent, RuntimeTargetError } =
  await import("./runtime-target.js");

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

describe("testLocalRuntimeDispatchForWorkspace", () => {
  const workspaceId = "workspace-1";
  const launcherRequest = vi.fn();
  let previousServiceRoleKey: string | undefined;

  function dispatchTables({
    assignedAgentId = null,
    advertisedModel = "qwen3-coder:30b",
  }: { assignedAgentId?: string | null; advertisedModel?: string } = {}) {
    return {
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
          value: "http://127.0.0.1:11434/v1",
        },
        ...(assignedAgentId
          ? [
              {
                id: "agent-match",
                workspace_id: workspaceId,
                rule_id: "rule-1",
                kind: "agent_id",
                key: "agent_id",
                value: assignedAgentId,
              },
            ]
          : []),
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          user_id: "user-1",
          display_name: "Kevin's MacBook",
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
        },
      ],
      local_runtime_model: [
        {
          id: "model-1",
          machine_id: "machine-1",
          runner_kind: "openai_compatible",
          model: advertisedModel,
          provider: "openai_compatible",
          capabilities: {},
          last_advertised_at: new Date().toISOString(),
        },
      ],
      agent: [] as Array<Record<string, unknown>>,
    };
  }

  function runtimeTarget(baseUrl: string) {
    return {
      agentId: "agent-1",
      host: "orchestrator",
      port: 4000,
      workspaceId,
      instanceId: "local-orchestrator",
      startedAt: new Date(0).toISOString(),
      baseUrl,
      wsUrl: `${baseUrl.replace(/^http/i, "ws")}/ws`,
    };
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    if (previousServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey;
    }
  });

  it("falls back to the shared local orchestrator target when no agent is assigned", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(dispatchTables()) as never);
    vi.mocked(localOrchestratorRuntimeTarget).mockReturnValue(runtimeTarget("http://orchestrator.test:4000"));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      helperConnected: true,
      modelAdvertised: true,
      dispatchSucceeded: true,
    });

    expect(resolveRuntimeTargetForAgent).not.toHaveBeenCalled();
    expect(localOrchestratorRuntimeTarget).toHaveBeenCalledWith({ workspaceId });
    expect(fetchMock).toHaveBeenCalled();
    const diagnosticUrl = new URL(fetchMock.mock.calls[0]![0]);
    expect(diagnosticUrl.origin).toBe("http://orchestrator.test:4000");
    expect(diagnosticUrl.pathname).toBe("/api/v1/local-runtime/health");
    expect(diagnosticUrl.searchParams.get("target_runner_kind")).toBe("openai_compatible");
    expect(diagnosticUrl.searchParams.get("workspace_id")).toBe(workspaceId);
    expect(diagnosticUrl.searchParams.get("machine_id")).toBe("machine-1");
  });

  it("resolves the runtime target for the machine's assigned agent", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient(dispatchTables({ assignedAgentId: "agent-1" })) as never,
    );
    vi.mocked(resolveRuntimeTargetForAgent).mockResolvedValue(runtimeTarget("http://agent-runtime.test:4100"));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      dispatchSucceeded: true,
    });

    expect(resolveRuntimeTargetForAgent).toHaveBeenCalledWith("agent-1", launcherRequest);
    expect(localOrchestratorRuntimeTarget).not.toHaveBeenCalled();
    const diagnosticUrl = new URL(fetchMock.mock.calls[0]![0]);
    expect(diagnosticUrl.origin).toBe("http://agent-runtime.test:4100");
  });

  it("carries the upstream status and body in the error detail when diagnostics answer non-JSON", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(dispatchTables()) as never);
    vi.mocked(localOrchestratorRuntimeTarget).mockReturnValue(runtimeTarget("http://orchestrator.test:4000"));
    const fetchMock = vi.fn(async () => new Response("<!DOCTYPE html><html>load balancer</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      dispatchSucceeded: false,
      error: {
        code: "runtime_diagnostic_failed",
        detail: {
          httpStatus: 200,
          endpoint: "http://orchestrator.test:4000/api/v1/local-runtime/health",
          rawMessage: "<!DOCTYPE html><html>load balancer</html>",
        },
      },
    });
  });

  it("surfaces the degraded reason and JSON body from diagnostics", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(dispatchTables()) as never);
    vi.mocked(localOrchestratorRuntimeTarget).mockReturnValue(runtimeTarget("http://orchestrator.test:4000"));
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, status: "degraded", reason: "target_runner_not_registered" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest);
    expect(result).toMatchObject({
      dispatchSucceeded: false,
      error: {
        code: "target_runner_not_registered",
        detail: { httpStatus: 200 },
      },
    });
    expect(result.error?.detail?.rawMessage).toContain("target_runner_not_registered");
  });

  it("maps runtime target resolution failures to a structured error", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient(dispatchTables({ assignedAgentId: "agent-1" })) as never,
    );
    vi.mocked(resolveRuntimeTargetForAgent).mockRejectedValue(
      new RuntimeTargetError({
        statusCode: 404,
        code: "runtime_not_found",
        message: "No running runtime found for agent agent-1.",
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      dispatchSucceeded: false,
      error: {
        code: "runtime_not_found",
        message: "No running runtime found for agent agent-1.",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the dial error when the diagnostics endpoint is unreachable", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(dispatchTables()) as never);
    vi.mocked(localOrchestratorRuntimeTarget).mockReturnValue(runtimeTarget("http://orchestrator.test:4000"));
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      dispatchSucceeded: false,
      error: {
        code: "runtime_unreachable",
        detail: {
          endpoint: "http://orchestrator.test:4000/api/v1/local-runtime/health",
          dialError: "connect ECONNREFUSED",
        },
      },
    });
  });

  it("fails before probing when the configured model is no longer advertised", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient(dispatchTables({ advertisedModel: "llama3.1:8b" })) as never,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLocalRuntimeDispatchForWorkspace(workspaceId, "machine-1", launcherRequest),
    ).resolves.toMatchObject({
      helperConnected: true,
      modelAdvertised: false,
      dispatchSucceeded: false,
      error: {
        code: "model_unavailable",
        message: "Model is not advertised by this helper.",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
