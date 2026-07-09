import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMockSupabaseClient,
  localRuntimeMachinesModule,
  runtimeTargetModule,
  supabaseClientModule,
} from "./local-runtime-machines.test-support.js";

const { testLocalRuntimeDispatchForWorkspace } = localRuntimeMachinesModule;
const { localOrchestratorRuntimeTarget, resolveRuntimeTargetForAgent, RuntimeTargetError } = runtimeTargetModule;
const { getServiceRoleSupabase } = supabaseClientModule;

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
