import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  AGENT_TOOL_GRANT_TOOL_SLUGS,
  DEFAULT_PLANNING_TOOL_SLUGS,
  SCHEDULED_TASK_TOOL_SLUGS,
} from "./services/tool-bundles.js";
import {
  type AgentRow,
  type SetupAgentPayload,
  type SetupE2eHarness,
  type SetupEnginePayload,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  createSetupE2eHarness,
} from "../test-support/setup-e2e-harness.js";

describe("PL-3 setup flow", () => {
  let harness: SetupE2eHarness | undefined;

  beforeAll(async () => {
    vi.resetModules();
    harness = await createSetupE2eHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("creates setup, proxies agents/ws, and stops cleanly", async () => {
    const currentHarness = getHarness();
    const createResponse = await fetch(`${currentHarness.apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Launch Test Agent",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        repositoryUrl: "https://github.com/example/repo",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        credentials: [
          {
            provider: "openai",
            keyName: "OPENAI_API_KEY",
            secret: "sk-test-1234",
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { agent: SetupAgentPayload; engine: SetupEnginePayload };
    expect(created.agent.id).toBeTruthy();
    expect(created.agent.type).toBe("coding");
    expect(created.engine.status).toBe("running");

    const getResponse = await fetch(`${currentHarness.apiBaseUrl}/api/setup?agentId=${created.agent.id}`, {
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
      },
    });
    expect(getResponse.status).toBe(200);
    const setup = (await getResponse.json()) as { engine: SetupEnginePayload };
    expect(setup.engine.status).toBe("running");

    const agentsResponse = await fetch(`${currentHarness.apiBaseUrl}/api/agents/${created.agent.id}`, {
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
      },
    });
    expect(agentsResponse.status).toBe(200);

    let ws: WebSocket | null = null;
    const helloFrame = await new Promise<string>((resolve, reject) => {
      ws = new WebSocket(
        `${currentHarness.apiBaseUrl.replace("http", "ws")}/ws?agent_id=${created.agent.id}&workspace_id=${TEST_WORKSPACE_ID}&session_key=agent:${created.agent.id}:main`,
        ["platform.v1", `bearer.${currentHarness.authToken}`],
      );
      const timer = setTimeout(() => reject(new Error("websocket hello timed out")), 2_000);
      ws.once("message", (message) => {
        clearTimeout(timer);
        resolve(String(message));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once("unexpected-response", (_req, response) => {
        clearTimeout(timer);
        reject(new Error(`websocket upgrade rejected: ${response.statusCode}`));
      });
    });
    expect(helloFrame).toContain("hello-ok");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws?.terminate();
        resolve();
      }, 2_000);
      ws?.once("close", () => resolve());
      ws?.once("close", () => clearTimeout(timer));
      ws?.close();
    });

    const stopResponse = await fetch(
      `${currentHarness.apiBaseUrl}/api/worker-bridge/sessions/${created.engine.instanceId}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${currentHarness.authToken}`,
        },
      },
    );
    expect(stopResponse.status).toBe(200);
    expect(currentHarness.findLatestEngine(created.agent.id)?.status).toBe("stopped");
  }, 30_000);

  it("persists planning defaults and custom targets through setup", async () => {
    const currentHarness = getHarness();
    const planningResponse = await fetch(`${currentHarness.apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Planning Agent",
        agentType: "planning",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        tracker: {
          kind: "database",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(planningResponse.status).toBe(201);
    const planning = (await planningResponse.json()) as { agent: SetupAgentPayload };
    expect(planning.agent.type).toBe("planning");
    expect(planning.agent.toolPolicy).toMatchObject({
      planning: {
        destination: "database",
        tools: [...DEFAULT_PLANNING_TOOL_SLUGS, ...SCHEDULED_TASK_TOOL_SLUGS, ...AGENT_TOOL_GRANT_TOOL_SLUGS],
      },
    });

    const customResponse = await fetch(`${currentHarness.apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Custom Agent",
        agentType: "custom",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        customTarget: {
          backend: {
            type: "openclaw_ws",
            baseUrl: "ws://127.0.0.1:7788",
            agentId: "planner-local",
          },
        },
        workflowTemplate: "default",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(customResponse.status).toBe(201);
    const custom = (await customResponse.json()) as {
      agent: { id: string; type: string; toolPolicy: unknown };
      gatewayConfig: { configJson: unknown };
    };
    expect(custom.agent.type).toBe("custom");
    expect(custom.agent.toolPolicy).toMatchObject({
      custom: {
        target_required: true,
      },
    });
    expect(custom.gatewayConfig.configJson).toMatchObject({
      backend: {
        type: "openclaw_ws",
        base_url: "ws://127.0.0.1:7788",
        agent_id: "planner-local",
      },
    });

    const updateResponse = await fetch(`${currentHarness.apiBaseUrl}/api/setup`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: custom.agent.id,
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Renamed Custom Agent",
        agentType: "custom",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as { gatewayConfig: { configJson: unknown } };
    expect(updated.gatewayConfig.configJson).toMatchObject({
      backend: {
        type: "openclaw_ws",
        base_url: "ws://127.0.0.1:7788",
        agent_id: "planner-local",
      },
    });
  }, 30_000);

  it("starts the selected planning agent through the launcher path", async () => {
    const currentHarness = getHarness();
    const agent = seedAgent({
      name: "Planning Agent",
      model_settings: { primary: "openai/gpt-5.2" },
      tool_policy: { planning: { destination: "database" } },
      type: "planning",
    });
    currentHarness.db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "planning-hash",
      config_json: {
        tracker: { kind: "database" },
        runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }],
      },
      updated_at: agent.updated_at,
      updated_by: TEST_USER_ID,
    });
    currentHarness.db.credentials.push({
      id: crypto.randomUUID(),
      agent_id: agent.id,
      workspace_id: TEST_WORKSPACE_ID,
      user_id: TEST_USER_ID,
      key_value: { provider: "openai", OPENAI_API_KEY: "sk-test", key_last4: "test" },
      created_at: agent.updated_at,
      updated_at: agent.updated_at,
    });

    const startResponse = await fetch(`${currentHarness.apiBaseUrl}/api/agents/${agent.id}/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
      },
    });

    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      data: {
        agent_id: agent.id,
        workspace_id: TEST_WORKSPACE_ID,
        status: "running",
      },
    });
    expect(currentHarness.findLatestEngine(agent.id)?.status).toBe("running");
  });

  it("starts a production local relay agent through the launcher path", async () => {
    const currentHarness = getHarness();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const agent = seedAgent({
      name: "Local Relay Manager",
      model_settings: { primary: "qwen3-coder:30b" },
      tool_policy: {},
      type: "manager",
    });
    currentHarness.db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "local-relay-hash",
      config_json: {
        runners: [{ kind: "local_relay", model: "qwen3-coder:30b", provider: "local" }],
      },
      updated_at: agent.updated_at,
      updated_by: TEST_USER_ID,
    });

    try {
      const startResponse = await fetch(`${currentHarness.apiBaseUrl}/api/agents/${agent.id}/start`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${currentHarness.authToken}`,
        },
      });

      expect(startResponse.status).toBe(200);
      await expect(startResponse.json()).resolves.toMatchObject({
        data: {
          agent_id: agent.id,
          workspace_id: TEST_WORKSPACE_ID,
          status: "running",
        },
      });
      expect(currentHarness.findLatestEngine(agent.id)?.status).toBe("running");
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns a clear error for unsupported custom runtime backends", async () => {
    const currentHarness = getHarness();
    const agent = seedAgent({
      name: "Custom Agent",
      model_settings: { primary: "openai/gpt-5.2" },
      tool_policy: {},
      type: "custom",
    });
    currentHarness.db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "custom-hash",
      config_json: {
        backend: {
          type: "openclaw_ws",
          base_url: "ws://127.0.0.1:7788",
          agent_id: "planner-local",
        },
      },
      updated_at: agent.updated_at,
      updated_by: TEST_USER_ID,
    });

    const startResponse = await fetch(`${currentHarness.apiBaseUrl}/api/agents/${agent.id}/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentHarness.authToken}`,
      },
    });

    expect(startResponse.status).toBe(422);
    await expect(startResponse.json()).resolves.toMatchObject({
      error: {
        code: "custom_runtime_unsupported",
        message: expect.any(String),
        details: {
          agent_id: agent.id,
          agent_type: "custom",
        },
      },
    });
    expect(currentHarness.findLatestEngine(agent.id)).toBeNull();
  });

  function seedAgent(overrides: Pick<AgentRow, "name" | "model_settings" | "tool_policy" | "type">): AgentRow {
    const currentHarness = getHarness();
    const agent: AgentRow = {
      id: crypto.randomUUID(),
      workspace_id: TEST_WORKSPACE_ID,
      created_by_user_id: TEST_USER_ID,
      status: "active",
      updated_at: new Date().toISOString(),
      ...overrides,
    };
    currentHarness.db.agents.push(agent);
    return agent;
  }

  function getHarness(): SetupE2eHarness {
    if (!harness) {
      throw new Error("setup e2e harness was not initialized");
    }
    return harness;
  }
});
