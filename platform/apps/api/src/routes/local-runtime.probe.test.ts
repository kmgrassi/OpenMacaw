import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createLocalRuntimeTestServer, userId, withOwnedWorkspace, workspaceId } from "./local-runtime.test-support.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

describe("local runtime route probes", () => {
  let closeServer = async () => {};
  let baseUrl = "";
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const server = await createLocalRuntimeTestServer();
    closeServer = server.close;
    baseUrl = server.baseUrl;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await closeServer();
  });

  it("rejects arbitrary endpoint probes outside development", async () => {
    process.env.NODE_ENV = "production";
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspaces: [{ id: workspaceId, owner_user_id: userId }],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes/probe?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
      },
    });
  });

  it("rejects probe requests for workspaces the caller does not belong to", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient({ workspaces: [] }) as never);

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes/probe?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "workspace_forbidden",
      },
    });
  });

  it("rejects probe requests for non-loopback endpoints", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspaces: [{ id: workspaceId, owner_user_id: userId }],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes/probe?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://169.254.169.254/latest/meta-data",
        model: "qwen3-coder:30b",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "Local runtime probe request is invalid",
      },
    });
  });

  it("accepts probe requests for bracketed IPv6 loopback endpoints", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspaces: [{ id: workspaceId, owner_user_id: userId }],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/local-runtime/runtimes/probe?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://[::1]:11434/v1",
        model: "qwen3-coder:30b",
      }),
    });

    expect(response.status).not.toBe(400);
  });

  it("probes a registered local runner from relay liveness instead of server-side localhost", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "local-endpoint-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
        {
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          display_name: "qwen3-coder:30b@localhost:11434",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
        },
      ],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/probe?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3-coder:30b",
      reachable: true,
      modelFound: true,
      error: null,
    });
  });

  it("does not report registered local runner reachable from stale registration-time runner kinds", async () => {
    const db = withOwnedWorkspace({
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
      ],
      routing_rule_match: [
        {
          id: "local-endpoint-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
        {
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ],
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          display_name: "qwen3-coder:30b@localhost:11434",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: [],
        },
      ],
    });
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/probe?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3-coder:30b",
      reachable: false,
      modelFound: false,
      error: "Helper is online, but it is not advertising openai_compatible",
    });
  });
});
