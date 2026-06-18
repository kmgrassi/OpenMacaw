import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createLocalRuntimeTestServer, withOwnedWorkspace, workspaceId } from "./local-runtime.test-support.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

describe("local runtime route registration", () => {
  let closeServer = async () => {};
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    const server = await createLocalRuntimeTestServer();
    closeServer = server.close;
    baseUrl = server.baseUrl;
  });

  afterEach(async () => {
    await closeServer();
  });

  it("rejects local runtime token rotation for non-admin workspace members", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspaces: [{ id: workspaceId, owner_user_id: "other-owner" }],
        workspace_members: [
          { workspace_id: workspaceId, user_id: "11111111-1111-4111-8111-111111111111", role: "member" },
        ],
      }) as never,
    );

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/machine-1/rotate-token?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "workspace_admin_required",
      },
    });
  });

  it("lists a freshly heartbeating helper as online when persisted status is still offline", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
          last_error: null,
          last_error_at: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
          workspace_id: workspaceId,
        },
        {
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
          workspace_id: workspaceId,
        },
        {
          rule_id: "local-rule-1",
          kind: "local_workspace_root",
          key: "path",
          value: "/Users/me/project",
          workspace_id: workspaceId,
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          display_name: "Kevin's Mac",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          status: "offline",
        },
      ],
      local_runtime_model: [
        {
          id: "model-1",
          machine_id: "machine-1",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          capabilities: {},
          last_advertised_at: new Date().toISOString(),
        },
      ],
      agent: [],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtimes: [
        {
          id: "machine-1",
          status: "online",
          localExecution: {
            helperOnline: true,
            status: "online",
          },
          models: [
            {
              model: "qwen3-coder:30b",
            },
          ],
        },
      ],
    });
  });

  it("does not list revoked local runtime machines even when routing rules remain", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "revoked-rule-1",
          workspace_id: workspaceId,
          name: "local:revoked-model",
          runner_kind: "local_relay",
          model: "revoked-model",
          provider: "openai_compatible",
          machine_id: "revoked-machine-1",
          last_error: null,
          last_error_at: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "revoked-rule-1",
          kind: "local_machine",
          key: "id",
          value: "revoked-machine-1",
          workspace_id: workspaceId,
        },
        {
          rule_id: "revoked-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
          workspace_id: workspaceId,
        },
      ],
      local_runtime_machine: [
        {
          id: "revoked-machine-1",
          workspace_id: workspaceId,
          display_name: "Old revoked helper",
          last_seen_at: new Date().toISOString(),
          revoked_at: new Date().toISOString(),
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          status: "offline",
        },
      ],
      local_runtime_model: [
        {
          id: "revoked-model-1",
          machine_id: "revoked-machine-1",
          runner_kind: "local_relay",
          model: "revoked-model",
          provider: "openai_compatible",
          capabilities: {},
          last_advertised_at: new Date().toISOString(),
        },
      ],
      agent: [],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runtimes: [],
    });
  });

  it("test-dispatch treats a fresh heartbeat as connected before status write-through lands", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
          last_error: null,
          last_error_at: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
          workspace_id: workspaceId,
        },
        {
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
          workspace_id: workspaceId,
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          display_name: "Kevin's Mac",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          status: "offline",
        },
      ],
      local_runtime_model: [],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/machine-1/test-dispatch?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      machineId: "machine-1",
      helperConnected: true,
      modelAdvertised: false,
      dispatchSucceeded: false,
      error: {
        code: "model_unavailable",
      },
    });
  });

  it("test-dispatch sends the service-role bearer to the orchestrator diagnostics endpoint", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
          last_error: null,
          last_error_at: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
          workspace_id: workspaceId,
        },
        {
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
          workspace_id: workspaceId,
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          display_name: "Kevin's Mac",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
          status: "online",
        },
      ],
      local_runtime_model: [
        {
          id: "model-1",
          machine_id: "machine-1",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          capabilities: {},
          last_advertised_at: new Date().toISOString(),
        },
      ],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const seenAuthorizationHeaders: Array<string | undefined> = [];
    const orchestrator = createServer((req, res) => {
      seenAuthorizationHeaders.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => orchestrator.listen(0, resolve));

    const previousOrchestratorBaseUrl = process.env.ORCHESTRATOR_BASE_URL;
    const previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.ORCHESTRATOR_BASE_URL = `http://127.0.0.1:${(orchestrator.address() as AddressInfo).port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    try {
      const response = await fetch(
        `${baseUrl}/api/local-runtime/runtimes/machine-1/test-dispatch?workspaceId=${workspaceId}`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        machineId: "machine-1",
        helperConnected: true,
        modelAdvertised: true,
        dispatchSucceeded: true,
      });
      expect(seenAuthorizationHeaders).toEqual(["Bearer test-service-role-key"]);
    } finally {
      if (previousOrchestratorBaseUrl === undefined) {
        delete process.env.ORCHESTRATOR_BASE_URL;
      } else {
        process.env.ORCHESTRATOR_BASE_URL = previousOrchestratorBaseUrl;
      }
      if (previousServiceRoleKey === undefined) {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      } else {
        process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey;
      }
      orchestrator.closeAllConnections?.();
      await new Promise<void>((resolve) => orchestrator.close(() => resolve()));
    }
  });

  it("registers a model-only runtime and emits an [runner.openai_compatible] snippet", async () => {
    const db = withOwnedWorkspace({
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            workspaceRoot: "/Users/me/project",
            toolCallCapability: "native_tools",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{
        kind: string;
        runnerKind: string;
        provider: string;
        model: string;
        toolCallCapability: string | null;
      }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]).toMatchObject({
      kind: "openai_compatible",
      runnerKind: "local_relay",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      toolCallCapability: "native_tools",
    });
    expect(body.configSnippet).toContain("[runner.openai_compatible]");
    expect(body.configSnippet).toContain('model = "qwen3-coder:30b"');
    expect(body.configSnippet).not.toContain("[runner.openclaw]");
    expect(body.setupCommand).toContain('"$HELPER_BIN"');
    expect(body.setupCommand).toContain("'register'");
    expect(body.setupCommand).toContain("--openai-compatible-endpoint");
    expect(body.setupCommand).toContain("--openai-compatible-model");
    expect(body.setupCommand).toContain("--workspace-root");
    expect(body.setupCommand).toContain('"$HELPER_BIN" start');

    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        runner_kind: "local_relay",
        provider: "openai_compatible",
        model: "qwen3-coder:30b",
      }),
    ]);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: expect.arrayContaining(["openai_compatible", "local_model_coding", "planner"]),
    });
  });

  it("registers an openclaw-only runtime and emits an [runner.openclaw] snippet", async () => {
    const db = withOwnedWorkspace({
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
            apiKey: "sk-openclaw",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{
        kind: string;
        runnerKind: string;
        provider: string;
        model: string;
        toolCallCapability: string | null;
      }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]).toMatchObject({
      kind: "openclaw",
      runnerKind: "local_relay",
      provider: "openclaw",
      model: "",
      toolCallCapability: null,
    });
    expect(body.configSnippet).toContain("[runner.openclaw]");
    expect(body.configSnippet).toContain('endpoint = "http://localhost:7100"');
    expect(body.configSnippet).toContain('api_key = "sk-openclaw"');
    expect(body.configSnippet).not.toContain("[runner.openai_compatible]");
    expect(body.configSnippet).not.toContain("model =");
    expect(body.setupCommand).toContain("--openclaw-endpoint");
    expect(body.setupCommand).toContain("--openclaw-api-key");

    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        runner_kind: "local_relay",
        provider: "openclaw",
        model: null,
      }),
    ]);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: ["openclaw"],
    });
  });

  it("registers a multi-kind runtime with both openai_compatible and openclaw runners on one machine", async () => {
    const db = withOwnedWorkspace({
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            toolCallCapability: "native_tools",
          },
          {
            kind: "openclaw",
            endpoint: "http://localhost:7100",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runners: Array<{ kind: string; runnerKind: string }>;
      configSnippet: string;
      setupCommand: string;
    };
    expect(body.runners.map((runner) => runner.kind).sort()).toEqual(["openai_compatible", "openclaw"]);
    expect(body.configSnippet).toContain("[runner.openai_compatible]");
    expect(body.configSnippet).toContain("[runner.openclaw]");
    expect(body.setupCommand).toContain("--openai-compatible-endpoint");
    expect(body.setupCommand).toContain("--openclaw-endpoint");

    expect(db.routing_rule).toHaveLength(2);
    expect(db.routing_rule).toEqual(
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
    expect(db.local_runtime_machine).toHaveLength(1);
    expect(db.local_runtime_machine[0]).toMatchObject({
      workspace_id: workspaceId,
      runner_kinds: expect.arrayContaining(["openai_compatible", "local_model_coding", "planner", "openclaw"]),
    });
  });

  it("rejects a registration that omits the runners array", async () => {
    const db = withOwnedWorkspace({
      local_runtime_machine: [] as Array<Record<string, unknown>>,
      local_runtime_token: [] as Array<Record<string, unknown>>,
      routing_rule: [] as Array<Record<string, unknown>>,
      routing_rule_match: [] as Array<Record<string, unknown>>,
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://localhost:7100",
      }),
    });

    expect(response.status).toBe(400);
    expect(db.routing_rule).toEqual([]);
  });
});
