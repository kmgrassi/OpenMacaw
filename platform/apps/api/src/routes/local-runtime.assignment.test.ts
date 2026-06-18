import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase, getUserScopedSupabase } from "../supabase-client.js";
import { createLocalRuntimeTestServer, userId, withOwnedWorkspace, workspaceId } from "./local-runtime.test-support.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
}));

type MockTables = Parameters<typeof createMockSupabaseClient>[0];

function mockSupabase(serviceRoleDb: MockTables, userScopedDb: MockTables = serviceRoleDb) {
  vi.mocked(getServiceRoleSupabase).mockReturnValue(
    createMockSupabaseClient(withOwnedWorkspace(serviceRoleDb)) as never,
  );
  vi.mocked(getUserScopedSupabase).mockReturnValue(createMockSupabaseClient(withOwnedWorkspace(userScopedDb)) as never);
}

describe("local runtime route assignments", () => {
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

  it("rejects local runtime assignment for non-admin workspace members", async () => {
    const db = {
      workspaces: [{ id: workspaceId, owner_user_id: "other-owner" }],
      workspace_members: [{ workspace_id: workspaceId, user_id: userId, role: "member" }],
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
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "coding-agent-1",
          name: "Coding",
          workspace_id: workspaceId,
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);
    vi.mocked(getUserScopedSupabase).mockReturnValue(createMockSupabaseClient(db) as never);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "coding-agent-1" }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "workspace_admin_required",
      },
    });
  });

  it("assigns a local model to a manager agent without runner-kind filtering", async () => {
    const db = {
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
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "manager-agent-1",
          name: "Manager",
          workspace_id: workspaceId,
          type: "manager",
          model_settings: { primary: "openai/gpt-5.1" },
          tool_policy: {},
        },
      ],
      gateway_config: [] as Array<Record<string, unknown>>,
      gateway_config_versions: [] as Array<Record<string, unknown>>,
    };
    const supabase = createMockSupabaseClient(withOwnedWorkspace(db)) as never;
    vi.mocked(getServiceRoleSupabase).mockReturnValue(supabase);
    vi.mocked(getUserScopedSupabase).mockReturnValue(supabase);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "manager-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      routingRuleId: "local-rule-1",
      agentId: "manager-agent-1",
      machineId: "machine-1",
      model: "qwen3-coder:30b",
    });
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        }),
        expect.objectContaining({
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        }),
      ]),
    );
    expect(db.agent[0]).toMatchObject({
      model_settings: { primary: "qwen3-coder:30b" },
    });
    expect(db.routing_rule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent:manager-agent-1:execution-profile",
          runner_kind: "llm_tool_runner",
          provider: "local",
          model: "qwen3-coder:30b",
        }),
      ]),
    );
    const runtimeProfileRule = db.routing_rule.find((rule) => rule.name === "agent:manager-agent-1:execution-profile");
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: runtimeProfileRule?.id,
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        }),
      ]),
    );
    expect(getUserScopedSupabase).toHaveBeenCalledWith("test-token");
    expect(db.gateway_config).toEqual([
      expect.objectContaining({
        scope_type: "agent",
        scope_id: "manager-agent-1",
        version: 1,
        updated_by: userId,
        config_json: expect.objectContaining({
          tracker: expect.objectContaining({
            kind: expect.any(String),
          }),
        }),
      }),
    ]);
    expect(db.gateway_config_versions).toEqual([
      expect.objectContaining({
        gateway_config_id: db.gateway_config[0]?.id,
        version: 1,
        created_by: userId,
      }),
    ]);
  });

  it("preserves existing assignments when assigning the same local model to another agent", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
        },
      ],
      routing_rule_match: [
        {
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          name: "Planning",
          workspace_id: workspaceId,
          type: "planning",
          model_settings: {},
          tool_policy: {},
        },
        {
          id: "coding-agent-1",
          name: "Coding",
          workspace_id: workspaceId,
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };
    mockSupabase(db);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "coding-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "coding-agent-1",
        }),
      ]),
    );
  });

  it("assigns a local model through the canonical agent route with machine id", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
        },
      ],
      routing_rule_match: [
        {
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "coding-agent-1",
          name: "Coding",
          workspace_id: workspaceId,
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };
    mockSupabase(db);

    const response = await fetch(`${baseUrl}/api/agents/coding-agent-1/assign-local-model?workspaceId=${workspaceId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        machineId: "machine-1",
        localRuntimeId: "local-rule-1",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      routingRuleId: "local-rule-1",
      agentId: "coding-agent-1",
      machineId: "machine-1",
      model: "qwen3-coder:30b",
    });
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "local-rule-1",
          kind: "agent_id",
          value: "coding-agent-1",
        }),
      ]),
    );
  });

  it("preserves non-local routing matches when replacing an agent's local model assignment", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          machine_id: "machine-1",
        },
        {
          id: "old-local-rule",
          workspace_id: workspaceId,
          name: "local:llama3.1:8b",
          runner_kind: "local_relay",
          model: "llama3.1:8b",
          provider: "openai_compatible",
          machine_id: "old-machine",
        },
        {
          id: "cloud-rule-1",
          workspace_id: workspaceId,
          name: "cloud:openai:gpt-5.2",
          runner_kind: "llm_tool_runner",
          model: "openai/gpt-5.2",
          provider: "openai",
        },
      ],
      routing_rule_match: [
        {
          id: "local-machine-match",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          id: "old-local-machine-match",
          workspace_id: workspaceId,
          rule_id: "old-local-rule",
          kind: "local_machine",
          key: "id",
          value: "old-machine",
        },
        {
          id: "old-local-match",
          workspace_id: workspaceId,
          rule_id: "old-local-rule",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
        {
          id: "cloud-match",
          workspace_id: workspaceId,
          rule_id: "cloud-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "planning-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          name: "Planning",
          workspace_id: workspaceId,
          type: "planning",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };
    mockSupabase(db);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "planning-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "cloud-rule-1",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: "local-rule-1",
          value: "planning-agent-1",
        }),
      ]),
    );
    expect(db.routing_rule_match).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "old-local-rule",
          value: "planning-agent-1",
        }),
      ]),
    );
  });

  it("preserves an agent's credential-reference local_relay rule when assigning a registered runtime", async () => {
    const credentialRuleId = "credential-ref-rule";
    const registrationRuleId = "registration-rule";
    const db = {
      routing_rule: [
        {
          id: credentialRuleId,
          workspace_id: workspaceId,
          name: "agent:planning-agent-1:execution-profile",
          runner_kind: "local_relay",
          model: null,
          provider: "openclaw",
        },
        {
          id: registrationRuleId,
          workspace_id: workspaceId,
          name: "local:openclaw:machine-1",
          runner_kind: "local_relay",
          model: null,
          provider: "openclaw",
          machine_id: "machine-1",
        },
      ],
      routing_rule_match: [
        {
          id: "credential-agent-match",
          workspace_id: workspaceId,
          rule_id: credentialRuleId,
          kind: "agent_id",
          key: "id",
          value: "planning-agent-1",
        },
        {
          id: "registration-machine-match",
          workspace_id: workspaceId,
          rule_id: registrationRuleId,
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "planning-agent-1",
          name: "Planning",
          workspace_id: workspaceId,
          type: "planning",
          model_settings: {},
          tool_policy: {},
        },
      ],
    };
    mockSupabase(db);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/${registrationRuleId}/assign?workspaceId=${workspaceId}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "planning-agent-1" }),
      },
    );

    expect(response.status).toBe(201);
    expect(db.routing_rule_match).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: credentialRuleId,
          kind: "agent_id",
          value: "planning-agent-1",
        }),
        expect.objectContaining({
          rule_id: registrationRuleId,
          kind: "agent_id",
          value: "planning-agent-1",
        }),
      ]),
    );
  });

  it("unassigns a manager local model without mutating workspace gateway config", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
        {
          id: "manager-profile-rule",
          workspace_id: workspaceId,
          name: "agent:manager-agent-1:execution-profile",
          runner_kind: "llm_tool_runner",
          model: "qwen3-coder:30b",
          provider: "local",
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
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        },
        {
          id: "manager-profile-agent-match",
          workspace_id: workspaceId,
          rule_id: "manager-profile-rule",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        },
        {
          id: "manager-profile-endpoint-match",
          workspace_id: workspaceId,
          rule_id: "manager-profile-rule",
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "manager-agent-1",
          workspace_id: workspaceId,
          type: "manager",
        },
      ],
      gateway_config: [
        {
          id: "gateway-config-1",
          scope_type: "workspace",
          scope_id: workspaceId,
          version: 4,
          config_hash: "old-hash",
          config_json: {
            runners: {
              manager: {
                agent_id: "manager-agent-1",
                provider: "local",
                model: "qwen3-coder:30b",
                target_runner_kind: "local_relay",
                min_cadence_ms: 60000,
              },
              coding: { provider: "openai" },
            },
          },
          updated_by: userId,
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ] as Array<Record<string, unknown>>,
      gateway_config_versions: [] as Array<Record<string, unknown>>,
    };
    mockSupabase(db);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign/manager-agent-1?workspaceId=${workspaceId}`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(db.routing_rule_match).toEqual([
      expect.objectContaining({
        id: "local-endpoint-match",
        rule_id: "local-rule-1",
        kind: "local_endpoint",
        value: "http://127.0.0.1:11434/v1",
      }),
    ]);
    expect(db.routing_rule).toEqual([
      expect.objectContaining({
        id: "local-rule-1",
      }),
    ]);
    expect(db.gateway_config[0]).toMatchObject({
      id: "gateway-config-1",
      version: 4,
      updated_by: userId,
      config_json: {
        runners: {
          manager: {
            agent_id: "manager-agent-1",
            provider: "local",
            model: "qwen3-coder:30b",
            target_runner_kind: "local_relay",
            min_cadence_ms: 60000,
          },
          coding: { provider: "openai" },
        },
      },
    });
    expect(db.gateway_config_versions).toEqual([]);
  });

  it("unassigns a manager local model when the execution profile is still hosted", async () => {
    const db = {
      routing_rule: [
        {
          id: "local-rule-1",
          workspace_id: workspaceId,
          name: "local:qwen3-coder:30b",
          runner_kind: "local_relay",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
        },
        {
          id: "manager-profile-rule",
          workspace_id: workspaceId,
          name: "agent:manager-agent-1:execution-profile",
          runner_kind: "llm_tool_runner",
          model: "openai/gpt-5.2",
          provider: "openai",
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
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "local-rule-1",
          kind: "agent_id",
          key: "agent_id",
          value: "manager-agent-1",
        },
        {
          id: "manager-profile-agent-match",
          workspace_id: workspaceId,
          rule_id: "manager-profile-rule",
          kind: "agent_id",
          key: "id",
          value: "manager-agent-1",
        },
      ] as Array<Record<string, unknown>>,
      agent: [
        {
          id: "manager-agent-1",
          workspace_id: workspaceId,
          type: "manager",
        },
      ],
    };
    mockSupabase(db);

    const response = await fetch(
      `${baseUrl}/api/local-runtime/runtimes/runners/local-rule-1/assign/manager-agent-1?workspaceId=${workspaceId}`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-token",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(db.routing_rule_match).toEqual([
      expect.objectContaining({
        id: "local-endpoint-match",
        rule_id: "local-rule-1",
        kind: "local_endpoint",
        value: "http://127.0.0.1:11434/v1",
      }),
      expect.objectContaining({
        id: "manager-profile-agent-match",
        rule_id: "manager-profile-rule",
        kind: "agent_id",
        value: "manager-agent-1",
      }),
    ]);
    expect(db.routing_rule).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local-rule-1",
        }),
        expect.objectContaining({
          id: "manager-profile-rule",
          provider: "openai",
          model: "openai/gpt-5.2",
        }),
      ]),
    );
  });
});
