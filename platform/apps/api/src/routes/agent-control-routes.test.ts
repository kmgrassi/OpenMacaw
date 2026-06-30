import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentControlMessageRow } from "../../../../contracts/agent-control.js";
import type { LauncherOrchestrator } from "../../../../contracts/launcher.js";
import type { WorkerBridgeSessionRow } from "../../../../contracts/worker-bridge.js";
import type { LauncherClient } from "../services/launcher.js";
import { registerProxyRoutes } from "./proxy.js";

vi.mock("../services/agent-control.js", () => ({
  assertAgentControlAccess: vi.fn(),
  createAgentControlMessage: vi.fn(),
  createAgentRemediation: vi.fn(),
  logAgentRemediationRequested: vi.fn(),
  mapAgentControlMessage: vi.fn((value: unknown) => {
    const row = value as AgentControlMessageRow;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      targetAgentId: row.target_agent_id,
      observerAgentId: row.observer_agent_id,
      kind: row.kind,
      action: row.action,
      subject: row.subject,
      body: row.body,
      metadata: row.metadata,
      status: row.status,
      dispatchStatus: row.dispatch_status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    };
  }),
  updateAgentControlMessageDispatchStatus: vi.fn(),
}));

vi.mock("../services/runtime-prepare.js", () => ({
  assertRuntimePrepareSupported: vi.fn(),
}));

vi.mock("../services/runtime-dispatch-context.js", () => ({
  attachRuntimeDispatchContext: vi.fn((body: unknown, context: unknown) => {
    const source = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const dispatchContext =
      context && typeof context === "object" && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
    return {
      ...source,
      execution_profile: dispatchContext.executionProfile,
      workspace_policy: dispatchContext.workspacePolicy,
      policies: dispatchContext.policies,
      execution_target: dispatchContext.executionTarget,
      tool_assignments: dispatchContext.toolAssignments,
    };
  }),
  buildRuntimeDispatchContext: vi.fn(),
}));

vi.mock("../repositories/skills.js", () => ({
  resolveApprovedSkillsSnapshot: vi.fn(),
}));

vi.mock("../services/agent-tools/access.js", () => ({
  assertAgentAccess: vi.fn(),
}));

vi.mock("./stored-agent-credentials/authz.js", () => ({
  assertCredentialReferenceBelongsToWorkspace: vi.fn(),
}));

const {
  assertAgentControlAccess,
  createAgentControlMessage,
  createAgentRemediation,
  mapAgentControlMessage,
  updateAgentControlMessageDispatchStatus,
} = vi.mocked(await import("../services/agent-control.js"));
const { assertRuntimePrepareSupported } = vi.mocked(await import("../services/runtime-prepare.js"));
const { attachRuntimeDispatchContext, buildRuntimeDispatchContext } = vi.mocked(
  await import("../services/runtime-dispatch-context.js"),
);
const { resolveApprovedSkillsSnapshot } = vi.mocked(await import("../repositories/skills.js"));
const { assertAgentAccess } = vi.mocked(await import("../services/agent-tools/access.js"));
const { assertCredentialReferenceBelongsToWorkspace } = vi.mocked(await import("./stored-agent-credentials/authz.js"));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const observerAgentId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function controlRow(overrides: Partial<AgentControlMessageRow> = {}): AgentControlMessageRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    workspace_id: workspaceId,
    target_agent_id: targetAgentId,
    observer_agent_id: observerAgentId,
    kind: "handoff",
    action: null,
    subject: "handoff",
    body: "continue this work",
    metadata: {},
    status: "queued",
    dispatch_status: null,
    created_by_user_id: userId,
    created_at: "2026-04-26T09:00:00.000Z",
    ...overrides,
  } as const;
}

function workerBridgeSessionRow(overrides: Partial<WorkerBridgeSessionRow> = {}): WorkerBridgeSessionRow {
  return {
    id: "session-1",
    kind: "codex",
    command: "codex",
    cwd: "/tmp/work",
    status: "running",
    started_at: "2026-04-26T09:00:00.000Z",
    stopped_at: null,
    exit_status: null,
    env_keys: ["NODE_ENV"],
    credential_keys: ["OPENAI_API_KEY"],
    agent_id: targetAgentId,
    workspace_id: workspaceId,
    credential_id: "credential-1",
    ...overrides,
  };
}

function orchestratorRow(overrides: Partial<LauncherOrchestrator> = {}): LauncherOrchestrator {
  return {
    id: "orch-1",
    port: 4101,
    config: {},
    started_at: "2026-04-26T09:00:00.000Z",
    status: "running",
    reused: false,
    agent_id: targetAgentId,
    workspace_id: workspaceId,
    ...overrides,
  };
}

describe("agent control routes", () => {
  let server: Server | undefined;
  let baseUrl = "";
  const launcherClient = {
    startAgent: vi.fn(),
    listOrchestrators: vi.fn(),
    stopOrchestrator: vi.fn(),
  } as unknown as LauncherClient;

  beforeEach(async () => {
    vi.resetAllMocks();
    assertAgentControlAccess.mockResolvedValue(undefined);
    mapAgentControlMessage.mockImplementation((value: unknown) => {
      const row = value as AgentControlMessageRow;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        targetAgentId: row.target_agent_id,
        observerAgentId: row.observer_agent_id,
        kind: row.kind,
        action: row.action,
        subject: row.subject,
        body: row.body,
        metadata: row.metadata,
        status: row.status,
        dispatchStatus: row.dispatch_status,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at,
      };
    });
    updateAgentControlMessageDispatchStatus.mockResolvedValue(null);
    assertRuntimePrepareSupported.mockResolvedValue({
      agentId: targetAgentId,
      agentType: "coding",
      workspaceId,
      localRuntime: false,
    });
    buildRuntimeDispatchContext.mockResolvedValue({
      executionProfile: { runnerKind: "llm_tool_runner" },
      workspacePolicy: { allowNetworking: true },
      policies: [],
      executionTarget: { kind: "local_helper" },
      toolAssignments: [{ name: "git.run" }],
    } as never);
    attachRuntimeDispatchContext.mockImplementation((body: unknown, context: unknown) => {
      const source = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const dispatchContext =
        context && typeof context === "object" && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
      return {
        ...source,
        execution_profile: dispatchContext.executionProfile,
        workspace_policy: dispatchContext.workspacePolicy,
        policies: dispatchContext.policies,
        execution_target: dispatchContext.executionTarget,
        tool_assignments: dispatchContext.toolAssignments,
      };
    });
    resolveApprovedSkillsSnapshot.mockResolvedValue({
      version: 1,
      agentId: targetAgentId,
      workspaceId,
      skills: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "api-debugging",
          description: "Debug API failures",
          body: "Inspect logs before editing.",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });
    assertAgentAccess.mockResolvedValue({ agent: { id: targetAgentId }, workspaceId } as never);
    assertCredentialReferenceBelongsToWorkspace.mockResolvedValue("credential-1");
    launcherClient.startAgent = vi.fn();
    launcherClient.listOrchestrators = vi.fn();
    launcherClient.stopOrchestrator = vi.fn();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = userId;
      next();
    });
    registerProxyRoutes(app, launcherClient, vi.fn(), 500);

    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("creates structured agent-to-agent messages before the proxy wildcard", async () => {
    createAgentControlMessage.mockResolvedValue(controlRow());

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        body: "continue this work",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: {
        targetAgentId,
        observerAgentId,
        body: "continue this work",
      },
    });
    expect(createAgentControlMessage).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId, observerAgentId }));
  });

  it("starts launcher-managed agents with approved skills snapshot", async () => {
    launcherClient.startAgent = vi.fn().mockResolvedValue({
      status: 202,
      data: { data: orchestratorRow({ id: "orch-started" }) },
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/start`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ trace_id: "trace-1" }),
    });

    expect(response.status).toBe(202);
    expect(resolveApprovedSkillsSnapshot).toHaveBeenCalledWith({ agentId: targetAgentId, workspaceId });
    expect(launcherClient.startAgent).toHaveBeenCalledWith(
      targetAgentId,
      expect.objectContaining({
        trace_id: "trace-1",
        skills_snapshot: expect.objectContaining({
          version: 1,
          skills: [expect.objectContaining({ name: "api-debugging" })],
        }),
      }),
    );
  });

  it("queues non-restart remediation requests without launcher dispatch", async () => {
    createAgentRemediation.mockResolvedValue(controlRow({ kind: "control", action: "request_credentials" }));

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/remediations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        action: "request_credentials",
        reason: "missing provider key",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        attempted: false,
        status: "queued",
      },
      remediation: {
        action: "request_credentials",
      },
    });
    expect(launcherClient.startAgent).not.toHaveBeenCalled();
  });

  it("keeps restart dispatch successful when status persistence fails after launcher start", async () => {
    createAgentRemediation.mockResolvedValue(controlRow({ kind: "control", action: "restart" }));
    updateAgentControlMessageDispatchStatus.mockRejectedValue(new Error("supabase unavailable"));
    launcherClient.startAgent = vi.fn().mockResolvedValue({
      status: 202,
      data: {
        data: {
          id: "orch-1",
          port: 4101,
          config: {},
          started_at: "2026-04-26T09:00:00.000Z",
          status: "running",
          reused: false,
          agent_id: targetAgentId,
          workspace_id: workspaceId,
        },
      },
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/remediations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        observerAgentId,
        action: "restart",
        reason: "stuck runtime",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      dispatch: {
        attempted: true,
        status: "dispatched_status_update_failed",
      },
      remediation: {
        action: "restart",
        status: "accepted",
        dispatchStatus: "dispatched",
      },
    });
  });

  it("recovers a stuck runtime by stopping the current orchestrator and starting a fresh one", async () => {
    launcherClient.listOrchestrators = vi.fn().mockResolvedValue({
      data: [
        orchestratorRow({ id: "orch-current" }),
        orchestratorRow({ id: "orch-other-agent", agent_id: "other-agent" }),
      ],
    });
    launcherClient.stopOrchestrator = vi.fn().mockResolvedValue({
      status: 200,
      data: { data: orchestratorRow({ id: "orch-current", status: "stopped" }) },
    });
    launcherClient.startAgent = vi.fn().mockResolvedValue({
      status: 201,
      data: { data: orchestratorRow({ id: "orch-fresh", reused: false }) },
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/runtime/recover`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        mode: "restart_runtime",
        reason: "manual local model test recovery",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      agentId: targetAgentId,
      workspaceId,
      mode: "restart_runtime",
      stoppedCount: 1,
      stopped: [{ id: "orch-current", status: "stopped" }],
      restarted: { id: "orch-fresh", reused: false },
    });
    expect(launcherClient.stopOrchestrator).toHaveBeenCalledWith("orch-current");
    expect(buildRuntimeDispatchContext).toHaveBeenCalledWith({
      accessToken: "test-token",
      requesterUserId: userId,
      agentId: targetAgentId,
      requestBody: expect.objectContaining({
        workspaceId,
        recovery: expect.objectContaining({
          mode: "restart_runtime",
          stopped_orchestrator_ids: ["orch-current"],
        }),
      }),
    });
    expect(attachRuntimeDispatchContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        recovery: expect.objectContaining({
          mode: "restart_runtime",
          stopped_orchestrator_ids: ["orch-current"],
        }),
      }),
      expect.objectContaining({
        executionProfile: { runnerKind: "llm_tool_runner" },
        toolAssignments: [{ name: "git.run" }],
      }),
    );
    expect(launcherClient.startAgent).toHaveBeenCalledWith(
      targetAgentId,
      expect.objectContaining({
        workspaceId,
        execution_profile: expect.objectContaining({
          runnerKind: "llm_tool_runner",
        }),
        tool_assignments: [{ name: "git.run" }],
        recovery: expect.objectContaining({
          mode: "restart_runtime",
          stopped_orchestrator_ids: ["orch-current"],
        }),
      }),
    );
  });

  it("reports a recovery failure when a matching orchestrator cannot be stopped", async () => {
    launcherClient.listOrchestrators = vi.fn().mockResolvedValue({
      data: [orchestratorRow({ id: "orch-current" })],
    });
    launcherClient.stopOrchestrator = vi.fn().mockRejectedValue(new Error("launcher unavailable"));

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/runtime/recover`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        mode: "restart_runtime",
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "runtime_recovery_stop_failed",
        details: {
          stopErrors: [{ id: "orch-current", error: "launcher unavailable" }],
        },
      },
    });
    expect(launcherClient.startAgent).not.toHaveBeenCalled();
  });

  it("maps worker bridge session rows to camelCase responses", async () => {
    launcherClient.listWorkerBridgeSessions = vi.fn().mockResolvedValue({
      data: [workerBridgeSessionRow()],
    });

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [
        {
          id: "session-1",
          startedAt: "2026-04-26T09:00:00.000Z",
          stoppedAt: null,
          exitStatus: null,
          envKeys: ["NODE_ENV"],
          credentialKeys: ["OPENAI_API_KEY"],
          agentId: targetAgentId,
          workspaceId,
          credentialId: "credential-1",
        },
      ],
    });
  });

  it("requires auth before listing worker bridge sessions", async () => {
    launcherClient.listWorkerBridgeSessions = vi.fn().mockResolvedValue({
      data: [],
    });

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("filters worker bridge sessions the caller is not authorized to access", async () => {
    launcherClient.listWorkerBridgeSessions = vi.fn().mockResolvedValue({
      data: [
        workerBridgeSessionRow({ id: "visible-session" }),
        workerBridgeSessionRow({
          id: "hidden-session",
          agent_id: null,
          workspace_id: null,
        }),
      ],
    });

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{ id: "visible-session" }],
    });
  });

  it("rejects worker bridge launches without an authorized identity scope", async () => {
    launcherClient.createWorkerBridgeSession = vi.fn();

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "codex",
        cwd: "/tmp/work",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "worker_bridge_identity_required" },
    });
    expect(launcherClient.createWorkerBridgeSession).not.toHaveBeenCalled();
  });

  it("authorizes worker bridge launches against the requested agent workspace and credential", async () => {
    launcherClient.createWorkerBridgeSession = vi.fn().mockResolvedValue({
      status: 201,
      data: {
        data: workerBridgeSessionRow(),
      },
    });

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "codex",
        agent_id: targetAgentId,
        workspace_id: workspaceId,
        credential_id: "credential-1",
      }),
    });

    expect(response.status).toBe(201);
    expect(assertAgentAccess).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId: targetAgentId,
      workspaceId,
    });
    expect(assertCredentialReferenceBelongsToWorkspace).toHaveBeenCalledWith({
      workspaceId,
      credentialRef: { type: "credential_id", value: "credential-1" },
    });
  });

  it("rejects identity-scoped worker bridge launches that try to override cwd", async () => {
    launcherClient.createWorkerBridgeSession = vi.fn();

    const response = await fetch(`${baseUrl}/api/worker-bridge/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "codex",
        agent_id: targetAgentId,
        workspace_id: workspaceId,
        credential_id: "credential-1",
        cwd: "/tmp/other-workspace",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "worker_bridge_identity_workspace_forbidden" },
    });
    expect(launcherClient.createWorkerBridgeSession).not.toHaveBeenCalled();
  });
});
