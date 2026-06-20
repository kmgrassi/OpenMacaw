import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClient from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerAgentDashboardRoutes } from "./agent-dashboard.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseClient>()),
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";

const runRow = {
  run_id: "run-1",
  agent_id: agentId,
  workspace_id: workspaceId,
  attempt: 1,
  created_at: "2026-04-26T12:00:00.000Z",
  started_at: "2026-04-26T12:00:01.000Z",
  completed_at: null,
  status: "running",
  error: null,
  terminal_reason: null,
  tracker_kind: "linear",
  tracker_issue_key: "ENG-1",
  issue_identifier: "ENG-1",
  issue_state: "In Progress",
  updated_at: "2026-04-26T12:00:02.000Z",
};

const dashboardRun = {
  runId: "run-1",
  agentId,
  attempt: 1,
  createdAt: "2026-04-26T12:00:00.000Z",
  startedAt: "2026-04-26T12:00:01.000Z",
  completedAt: null,
  status: "running",
  error: null,
  terminalReason: null,
  trackerKind: "linear",
  trackerIssueKey: "ENG-1",
  issueIdentifier: "ENG-1",
  issueState: "In Progress",
  updatedAt: "2026-04-26T12:00:02.000Z",
};

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function agent(workspace = workspaceId) {
  return {
    id: agentId,
    workspace_id: workspace,
    name: "Coding Agent",
    status: "ready",
    type: "coding" as const,
    context: null,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: userId,
    updated_at: "2026-04-26T12:00:00.000Z",
  };
}

describe("agent dashboard routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(findSetupAgentById).mockResolvedValue(agent());
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        broker_run: [runRow],
        broker_task: [
          {
            task_id: "task-1",
            run_id: "run-1",
            attempt: 1,
            status: "completed",
            type: "model",
            input_tokens: 12,
            output_tokens: 34,
            total_tokens: 46,
            last_event: "completed",
            last_event_at: "2026-04-26T12:01:00.000Z",
            error: null,
            updated_at: "2026-04-26T12:01:00.000Z",
          },
        ],
        agent_tool_call_event: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            workspace_id: workspaceId,
            agent_id: agentId,
            run_id: "run-1",
            task_id: "task-1",
            tool_call_id: "call-shell-1",
            correlation_id: "corr-run-1",
            sequence: 1,
            event_type: "command.completed",
            message_kind: "tool_result",
            tool_slug: "shell.exec",
            status: "completed",
            approval_state: "not_required",
            command_actions: ["search"],
            arguments: { command: "rg TODO" },
            result: { exit_code: 0 },
            output_summary: "Found 2 matches",
            patch_summary: null,
            file_changes: [],
            error_code: null,
            error_message: null,
            started_at: "2026-04-26T12:00:30.000Z",
            completed_at: "2026-04-26T12:00:31.000Z",
            duration_ms: 1000,
            created_at: "2026-04-26T12:00:30.000Z",
            updated_at: "2026-04-26T12:00:31.000Z",
          },
        ],
        gateway_config_state: [
          {
            scope_type: "agent",
            scope_id: agentId,
            sync_status: "synced",
            sync_error: null,
            last_apply_status: "applied",
            last_apply_error: null,
            last_apply_at: "2026-04-26T12:00:00.000Z",
            last_applied_version: 2,
          },
        ],
      }) as never,
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerAgentDashboardRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("requires bearer auth", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/latest-run`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("returns the latest run for an authorized workspace member", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/latest-run`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: dashboardRun });
    expect(findSetupAgentById).toHaveBeenCalledWith("test-token", agentId);
  });

  it("returns paginated run history with the exact count", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/runs`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [dashboardRun], total: 1 });
  });

  it("only returns tasks for visible runs on the requested agent", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ runIds: ["run-1", "run-2"] }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ taskId: "task-1", runId: "run-1" });
    expect(body.tasks[0].toolEvents).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        toolSlug: "shell.exec",
        messageKind: "tool_result",
        toolCallId: "call-shell-1",
        correlationId: "corr-run-1",
        commandActions: ["search"],
        outputSummary: "Found 2 matches",
        durationMs: 1000,
      }),
    ]);
  });

  it("persists a local coding tool event for a visible run and task", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/tool-events`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        taskId: "task-1",
        toolCallId: "call-patch-1",
        correlationId: "corr-secret-sk-abcdef123456",
        sequence: 2,
        eventType: "patch.completed",
        messageKind: "tool_result",
        toolSlug: "apply_patch",
        status: "completed",
        approvalState: "approved",
        commandActions: [],
        arguments: { files: ["README.md"], apiKey: "sk-abcdef123456" },
        result: { changed_files: 1, stdout: "token sk-abcdef123456" },
        patchSummary: "Updated README.md with sk-abcdef123456",
        fileChanges: [{ path: "README.md", action: "modified" }],
        startedAt: "2026-04-26T12:02:00.000Z",
        completedAt: "2026-04-26T12:02:01.000Z",
        durationMs: 1000,
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      event: {
        workspaceId,
        agentId,
        runId: "run-1",
        taskId: "task-1",
        toolCallId: "call-patch-1",
        sequence: 2,
        toolSlug: "apply_patch",
        status: "completed",
        approvalState: "approved",
        patchSummary: "Updated README.md with [redacted]",
        arguments: { files: ["README.md"], apiKey: "[redacted]" },
        result: { changed_files: 1, stdout: "token [redacted]" },
        durationMs: 1000,
      },
    });
  });

  it("rejects tool events when the run workspace no longer matches the agent workspace", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        broker_run: [{ ...runRow, workspace_id: otherWorkspaceId }],
        broker_task: [
          {
            task_id: "task-1",
            run_id: "run-1",
            attempt: 1,
            status: "completed",
            type: "model",
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            last_event: "completed",
            last_event_at: "2026-04-26T12:01:00.000Z",
            error: null,
            updated_at: "2026-04-26T12:01:00.000Z",
          },
        ],
        agent_tool_call_event: [],
        gateway_config_state: [],
      }) as never,
    );

    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/tool-events`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        taskId: "task-1",
        eventType: "command.completed",
        toolSlug: "shell.exec",
        status: "completed",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "broker_run_workspace_mismatch" },
    });
  });

  it("rejects a requested workspace that does not match the agent", async () => {
    const response = await fetch(
      `${baseUrl}/api/agent-dashboard/${agentId}/gateway-config-state?workspaceId=${otherWorkspaceId}`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_dashboard_forbidden" },
    });
  });

  it("rejects users outside the agent workspace", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValue(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/latest-run`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
