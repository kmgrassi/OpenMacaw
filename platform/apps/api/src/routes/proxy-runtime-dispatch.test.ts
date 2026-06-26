import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import type { LauncherClient } from "../services/launcher.js";
import type { SetupAgentRow } from "../repositories/agents.js";
import { ApiRouteError } from "../http.js";
import { registerProxyRoutes } from "./proxy.js";

const upstreamMocks = vi.hoisted(() => ({
  runtimeRequest: vi.fn(),
}));

vi.mock("../services/runtime-target.js", () => ({
  RuntimeTargetError: class RuntimeTargetError extends Error {
    statusCode = 503;
    code = "runtime_not_ready";
    retriable = true;
  },
  resolveRequestAgentId: vi.fn(
    async (req: { params?: Record<string, string>; body?: Record<string, unknown> }) =>
      req.params?.identifier ?? req.params?.id ?? (typeof req.body?.agent_id === "string" ? req.body.agent_id : null),
  ),
  resolveRuntimeTargetForAgent: vi.fn(),
}));

vi.mock("../services/execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("../services/agent-tools.js", () => ({
  getToolsForAgent: vi.fn(),
}));

vi.mock("../services/local-coding-execution-target.js", () => ({
  assertLocalCodingToolsUseRuntimeTarget: vi.fn(),
  resolveLocalCodingExecutionTarget: vi.fn(),
}));

vi.mock("../services/resource-dispatch-resolution.js", () => ({
  resolveContainerDispatchResources: vi.fn(),
}));

vi.mock("../repositories/agents.js", () => ({
  findSetupAgentById: vi.fn(),
  findStoredAgentRowById: vi.fn(),
}));

vi.mock("../services/upstream.js", () => ({
  createUpstreamRequester: vi.fn(() => upstreamMocks.runtimeRequest),
}));

const { resolveRequestAgentId, resolveRuntimeTargetForAgent } = vi.mocked(
  await import("../services/runtime-target.js"),
);
const { resolveExecutionProfile } = vi.mocked(await import("../services/execution-profile-resolver.js"));
const { getToolsForAgent } = vi.mocked(await import("../services/agent-tools.js"));
const { assertLocalCodingToolsUseRuntimeTarget, resolveLocalCodingExecutionTarget } = vi.mocked(
  await import("../services/local-coding-execution-target.js"),
);
const { resolveContainerDispatchResources } = vi.mocked(await import("../services/resource-dispatch-resolution.js"));
const { findSetupAgentById, findStoredAgentRowById } = vi.mocked(await import("../repositories/agents.js"));

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const credentialId = "44444444-4444-4444-8444-444444444444";
const toolId = "55555555-5555-4555-8555-555555555555";
const grantId = "66666666-6666-4666-8666-666666666666";
const resourceId = "77777777-7777-4777-8777-777777777777";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function localCodingProfile(): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "coding" },
    profile: {
      agentId,
      workspaceId,
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      credentialRef: { type: "credential_id", value: credentialId },
      fallbacks: [],
      modelTierFloor: "any",
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
        interrupt: true,
      },
    },
    missing: [],
    source: {
      routingRuleId: "66666666-6666-4666-8666-666666666666",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

function plannerLocalProfile(): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "planning" },
    profile: {
      agentId,
      workspaceId,
      role: "planning",
      runnerKind: "planner",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      fallbacks: [],
      modelTierFloor: "any",
      toolProfile: "planning",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
        interrupt: false,
      },
    },
    missing: [],
    source: {
      routingRuleId: "66666666-6666-4666-8666-666666666666",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

function shellTool() {
  return {
    id: toolId,
    workspaceId: null,
    slug: "shell.exec",
    name: "Run Shell Command",
    description: "Execute a shell command in the workspace.",
    parameters: { type: "object", properties: {} },
    examples: [],
    executionKind: "shell",
    runnerKind: "local_model_coding",
    enabled: true,
  };
}

function plannerTool() {
  return {
    id: toolId,
    workspaceId: null,
    slug: "create_plan",
    name: "Create Plan",
    description: "Create a planning record.",
    parameters: { type: "object", properties: {} },
    examples: [],
    executionKind: "database",
    runnerKind: "planner",
    enabled: true,
  };
}

function setupAgent(toolPolicy: SetupAgentRow["tool_policy"] = {}): SetupAgentRow {
  return {
    id: agentId,
    workspace_id: workspaceId,
    name: "Coding Agent",
    status: "active",
    type: "coding",
    context: null,
    model_settings: {},
    tool_policy: toolPolicy,
    created_by_user_id: userId,
    updated_at: "2026-04-29T12:00:00.000Z",
  };
}

describe("runtime dispatch proxy contract", () => {
  let apiServer: Server | undefined;
  let baseUrl = "";
  let capturedBody: Record<string, unknown> | null = null;
  let runtimeStatus = 202;
  let runtimeBody: unknown = { run_id: "run-1", status: "queued" };
  let launcherRequest: ReturnType<typeof vi.fn>;
  let previousSupabaseUrl: string | undefined;
  let previousSupabaseServiceRoleKey: string | undefined;

  function resetContainerRoutingEnv() {
    delete process.env.CONTAINER_EXECUTION_ROUTING_MODE;
    delete process.env.CONTAINER_EXECUTION_ALLOWLIST_WORKSPACE_IDS;
    delete process.env.CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE;
  }

  function enableContainerRouting() {
    process.env.CONTAINER_EXECUTION_ROUTING_MODE = "container_default";
  }

  beforeEach(async () => {
    resetContainerRoutingEnv();
    previousSupabaseUrl = process.env.SUPABASE_URL;
    previousSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";
    vi.clearAllMocks();
    capturedBody = null;
    runtimeStatus = 202;
    runtimeBody = { run_id: "run-1", status: "queued" };
    launcherRequest = vi.fn().mockResolvedValue({ status: 200, body: { ok: true }, headers: {} });
    upstreamMocks.runtimeRequest.mockImplementation(async (_path: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : {};
      return { status: runtimeStatus, body: runtimeBody, headers: {} };
    });

    resolveRequestAgentId.mockResolvedValue(agentId);
    findStoredAgentRowById.mockResolvedValue({
      id: agentId,
      workspace_id: workspaceId,
      name: "Coding Agent",
      type: "coding",
      context: null,
      model_settings: {},
      tool_policy: {},
    });
    resolveExecutionProfile.mockResolvedValue(localCodingProfile());
    getToolsForAgent.mockResolvedValue([shellTool()]);
    assertLocalCodingToolsUseRuntimeTarget.mockReturnValue(undefined);
    resolveLocalCodingExecutionTarget.mockResolvedValue({
      kind: "local_helper",
      workspaceId,
      runnerKind: "local_model_coding",
      machineId: "77777777-7777-4777-8777-777777777777",
      workspaceRootRef: "local_runtime_machine:77777777-7777-4777-8777-777777777777",
    });
    resolveContainerDispatchResources.mockResolvedValue([
      {
        grantId,
        resourceId,
        resourceType: "git_repository",
        provider: "github",
        providerUrl: "https://github.com/kmgrassi/parallel-agent-platform.git",
        displayName: "parallel-agent-platform",
        alias: "parallel-agent-platform",
        credentialRef: null,
        accessMode: "read",
        requirement: "required",
        repositoryRef: {
          type: "git_ref",
          branch: "main",
          ref: "refs/heads/main",
          commitSha: "3165d7c",
        },
        networkPolicy: {
          mode: "allowlist",
          allowedHosts: ["github.com"],
        },
      },
    ]);
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        workspacePolicy: {
          sandbox: "read_only",
          approvalPolicy: "never",
        },
      }),
    );

    resolveRuntimeTargetForAgent.mockResolvedValue({
      agentId,
      workspaceId,
      host: "127.0.0.1",
      port: 4100,
      instanceId: "runtime-1",
      startedAt: "2026-04-28T12:00:00.000Z",
      baseUrl: `http://127.0.0.1:4100/agents/${agentId}/runtime`,
      wsUrl: `ws://127.0.0.1:4100/agents/${agentId}/runtime/ws`,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
    registerProxyRoutes(app, {} as LauncherClient, launcherRequest, 500);

    apiServer = createServer(app);
    const apiPort = await listen(apiServer);
    baseUrl = `http://127.0.0.1:${apiPort}`;
  });

  afterEach(async () => {
    await closeServer(apiServer);
    apiServer = undefined;
    resetContainerRoutingEnv();
    if (previousSupabaseUrl === undefined) {
      delete process.env.SUPABASE_URL;
    } else {
      process.env.SUPABASE_URL = previousSupabaseUrl;
    }
    if (previousSupabaseServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = previousSupabaseServiceRoleKey;
    }
  });

  it("passes local model coding profile, workspace policy, and tools to runtime dispatch", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId, prompt: "change the README" }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toEqual({ run_id: "run-1", status: "queued" });
    expect(capturedBody).toMatchObject({
      prompt: "change the README",
      agent_id: agentId,
      execution_profile: {
        runnerKind: "local_model_coding",
        provider: "openai_compatible",
        model: "qwen2.5-coder:latest",
        toolDefinitions: [{ slug: "shell.exec" }],
      },
      workspace_policy: {
        sandbox: "read_only",
        approvalPolicy: "never",
      },
      execution_target: {
        kind: "local_helper",
        workspaceId,
        runnerKind: "local_model_coding",
        machineId: "77777777-7777-4777-8777-777777777777",
      },
      tool_assignments: [{ slug: "shell.exec", runnerKind: "local_model_coding" }],
    });
    expect(resolveLocalCodingExecutionTarget).toHaveBeenCalledWith({
      workspaceId,
      runnerKind: "local_model_coding",
      workspaceRoot: null,
    });
  });

  it("adds runtime agent identifiers for local model coding run dispatch", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "change the README" }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(capturedBody).toMatchObject({
      prompt: "change the README",
      agent_id: agentId,
      workspace_id: workspaceId,
      execution_profile: {
        agentId,
        workspaceId,
        runnerKind: "local_model_coding",
      },
    });
  });

  it("passes planner local profile and planner tools to runtime dispatch", async () => {
    resolveExecutionProfile.mockResolvedValue(plannerLocalProfile());
    getToolsForAgent.mockResolvedValue([plannerTool()]);
    findSetupAgentById.mockResolvedValue(setupAgent());
    resolveLocalCodingExecutionTarget.mockResolvedValue({
      kind: "local_helper",
      workspaceId,
      runnerKind: "planner",
      machineId: "77777777-7777-4777-8777-777777777777",
      workspaceRootRef: "local_runtime_machine:77777777-7777-4777-8777-777777777777",
    });

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId, prompt: "draft a plan" }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(capturedBody).toMatchObject({
      prompt: "draft a plan",
      agent_id: agentId,
      execution_profile: {
        runnerKind: "planner",
        provider: "local",
        model: "qwen2.5-coder:7b",
        toolDefinitions: [{ slug: "create_plan", runnerKind: "planner" }],
      },
      workspace_policy: {
        sandbox: "read_only",
        approvalPolicy: "never",
      },
      execution_target: {
        kind: "local_helper",
        workspaceId,
        runnerKind: "planner",
        machineId: "77777777-7777-4777-8777-777777777777",
      },
      tool_assignments: [{ slug: "create_plan", runnerKind: "planner" }],
    });
    expect(assertLocalCodingToolsUseRuntimeTarget).not.toHaveBeenCalled();
    expect(resolveLocalCodingExecutionTarget).toHaveBeenCalledWith({
      workspaceId,
      runnerKind: "planner",
      workspaceRoot: null,
    });
  });

  it("fails before dispatch when no local coding execution target is registered", async () => {
    resolveLocalCodingExecutionTarget.mockRejectedValueOnce(
      new ApiRouteError(
        409,
        "local_coding_execution_target_missing",
        "No local runtime relay is registered for local coding in this workspace",
        { workspace_id: workspaceId },
      ),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId, prompt: "change the README" }),
    });

    expect(response.status, await response.clone().text()).toBe(409);
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("normalizes local coding runtime errors for API consumers", async () => {
    runtimeStatus = 500;
    runtimeBody = {
      error_code: "workspace_policy_violation",
      message: "shell command is outside the workspace policy",
      details: { command: "rm -rf /tmp/outside" },
    };

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId, prompt: "clean temp files" }),
    });

    expect(response.status, await response.clone().text()).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "workspace_policy_violation",
        message: "shell command is outside the workspace policy",
        details: { command: "rm -rf /tmp/outside" },
      },
    });
  });

  it("rejects runtime proxy requests for agents outside the caller scope", async () => {
    findStoredAgentRowById.mockResolvedValueOnce(null);

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status, await response.clone().text()).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "agent_not_found",
        message: "Agent was not found",
      },
    });
    expect(resolveRuntimeTargetForAgent).not.toHaveBeenCalled();
  });

  it("passes container execution target metadata through runtime dispatch", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "refactor setup resolver",
        dispatchMetadata: {
          sessionId: "session-42",
          resources: [
            {
              resourceId,
              alias: "platform",
              requirement: "required",
              repositoryRef: {
                type: "git_ref",
                branch: "main",
                ref: "refs/heads/main",
                commitSha: "3165d7c",
              },
            },
          ],
          limits: {
            timeoutMs: 120000,
            maxCpuCores: 2,
            maxMemoryMb: 4096,
            maxDiskMb: 8192,
            maxProcessCount: 64,
          },
          artifactRetention: {
            retainDays: 14,
            storeCommandOutput: true,
            storePatchArtifact: true,
          },
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["registry.npmjs.org", "github.com"],
          },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(capturedBody).toMatchObject({
      execution_target: {
        kind: "container",
        metadata: {
          workspaceId,
          sessionId: "session-42",
          resources: [
            {
              grantId,
              resourceId,
              resourceType: "git_repository",
              providerUrl: "https://github.com/kmgrassi/parallel-agent-platform.git",
              repositoryRef: {
                type: "git_ref",
                branch: "main",
              },
            },
          ],
        },
      },
    });
    expect(resolveContainerDispatchResources).toHaveBeenCalledWith({
      accessToken: "test-token",
      workspaceId,
      agentId,
      dispatchMetadata: expect.objectContaining({
        resources: [
          expect.objectContaining({
            resourceId,
            alias: "platform",
          }),
        ],
      }),
      fallbackNetworkPolicy: {
        mode: "allowlist",
        allowedHosts: ["registry.npmjs.org", "github.com"],
      },
    });
  });

  it("rejects local workspace roots on container dispatch before contacting runtime", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
          workspace_root: "/Users/dev/project",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "run coding task in container",
        dispatchMetadata: {
          sessionId: "session-42",
          resources: [{ resourceId }],
          limits: {
            timeoutMs: 120000,
            maxCpuCores: 2,
            maxMemoryMb: 4096,
            maxDiskMb: 8192,
            maxProcessCount: 64,
          },
          artifactRetention: {
            retainDays: 14,
            storeCommandOutput: true,
            storePatchArtifact: true,
          },
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["github.com"],
          },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "container_local_workspace_root_forbidden",
      },
    });
    expect(resolveContainerDispatchResources).not.toHaveBeenCalled();
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("rejects container dispatch when required target metadata is missing", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "run coding task in container",
      }),
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "container_dispatch_metadata_missing",
      },
    });
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("rejects container dispatch when no repository ref is available for bootstrap", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "run coding task in container",
        dispatchMetadata: {
          sessionId: "session-42",
          resources: [{ resourceId }],
          limits: {
            timeoutMs: 120000,
            maxCpuCores: 2,
            maxMemoryMb: 4096,
            maxDiskMb: 8192,
            maxProcessCount: 64,
          },
          artifactRetention: {
            retainDays: 14,
            storeCommandOutput: true,
            storePatchArtifact: true,
          },
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["github.com"],
          },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "container_bootstrap_resource_missing",
      },
    });
    expect(resolveContainerDispatchResources).not.toHaveBeenCalled();
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("rejects workspace snapshots for production container bootstrap", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "run coding task in container",
        dispatchMetadata: {
          sessionId: "session-42",
          resources: [
            {
              resourceId,
              repositoryRef: {
                type: "workspace_snapshot",
              },
            },
          ],
          limits: {
            timeoutMs: 120000,
            maxCpuCores: 2,
            maxMemoryMb: 4096,
            maxDiskMb: 8192,
            maxProcessCount: 64,
          },
          artifactRetention: {
            retainDays: 14,
            storeCommandOutput: true,
            storePatchArtifact: true,
          },
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["github.com"],
          },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "container_workspace_snapshot_not_supported",
      },
    });
    expect(resolveContainerDispatchResources).not.toHaveBeenCalled();
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed optional container metadata objects when present", async () => {
    enableContainerRouting();
    findSetupAgentById.mockResolvedValue(
      setupAgent({
        executionTarget: {
          kind: "container",
        },
      }),
    );

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "run coding task in container",
        dispatchMetadata: {
          sessionId: "session-42",
          repositorySource: {
            type: "git_ref",
            repositoryUrl: "https://github.com/kmgrassi/parallel-agent-platform.git",
            branch: "main",
            ref: "refs/heads/main",
            commitSha: "3165d7c",
          },
          limits: {
            timeoutMs: 120000,
            maxCpuCores: 2,
            maxMemoryMb: 4096,
            maxDiskMb: 8192,
            maxProcessCount: 64,
          },
          artifactRetention: {
            retainDays: 14,
            storeCommandOutput: true,
            storePatchArtifact: true,
          },
          artifactStore: [],
          reviewHandoff: [],
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["registry.npmjs.org", "github.com"],
          },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "container_dispatch_metadata_missing",
        details: {
          field: "artifactStore",
          issue: "must be an object when present",
        },
      },
    });
    expect(upstreamMocks.runtimeRequest).not.toHaveBeenCalled();
  });
});
