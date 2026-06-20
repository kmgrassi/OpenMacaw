import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerScheduledTaskRoutes } from "./scheduled-tasks.js";

type Row = Record<string, unknown>;
type ScheduledTaskTestTables = {
  workspace_members: Row[];
  workspaces: Row[];
  agent: Row[];
  work_items: Row[];
  scheduled_task: Row[];
};

const tables: ScheduledTaskTestTables = {
  workspace_members: [],
  workspaces: [],
  agent: [],
  work_items: [],
  scheduled_task: [],
};
const mockClient = createMockSupabaseClient(tables);
let throwForSupabaseContext: { context: string; error: Error } | null = null;

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  executeSupabaseRows: async (context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    if (throwForSupabaseContext?.context === context) {
      throw throwForSupabaseContext.error;
    }
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const managerAgentId = "33333333-3333-4333-8333-333333333333";
const otherManagerAgentId = "66666666-6666-4666-8666-666666666666";
const codingAgentId = "44444444-4444-4444-8444-444444444444";
const scheduledTaskId = "55555555-5555-4555-8555-555555555555";
const otherScheduledTaskId = "77777777-7777-4777-8777-777777777777";

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function scheduledTaskRow(overrides: Row = {}) {
  return {
    id: scheduledTaskId,
    workspace_id: workspaceId,
    agent_id: managerAgentId,
    source_work_item_id: null,
    created_by_user_id: userId,
    title: "Review blocked PRs",
    instructions: "Find blocked PR-related work items and move them forward.",
    enabled: true,
    schedule: { kind: "every", interval: 1, unit: "hour" },
    timezone: "Etc/UTC",
    next_run_at: "2026-05-14T13:30:00.000Z",
    last_run_at: null,
    last_run_status: null,
    last_error: null,
    delivery: { kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" },
    metadata: {},
    created_at: "2026-05-14T12:00:00.000Z",
    updated_at: "2026-05-14T12:00:00.000Z",
    ...overrides,
  };
}

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.workspaces = [];
  tables.agent = [
    { id: managerAgentId, workspace_id: workspaceId, type: "manager" },
    { id: otherManagerAgentId, workspace_id: workspaceId, type: "manager" },
    { id: codingAgentId, workspace_id: workspaceId, type: "coding" },
  ];
  tables.work_items = [];
  tables.scheduled_task = [scheduledTaskRow()];
  throwForSupabaseContext = null;
  vi.clearAllMocks();
}

async function requestJson(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("scheduled task routes", () => {
  let server: Server;

  beforeEach(async () => {
    resetTables();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerScheduledTaskRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("lists scheduled tasks for an authorized workspace", async () => {
    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduledTasks: [{ id: scheduledTaskId, workspaceId, agentId: managerAgentId }],
    });
  });

  it("lists scheduled tasks only for the selected manager agent", async () => {
    tables.scheduled_task.push(
      scheduledTaskRow({
        id: otherScheduledTaskId,
        agent_id: otherManagerAgentId,
        title: "Other manager schedule",
      }),
    );

    const response = await requestJson(
      "GET",
      `/api/workspaces/${workspaceId}/scheduled-tasks?agentId=${managerAgentId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scheduledTasks).toHaveLength(1);
    expect(body).toMatchObject({
      scheduledTasks: [{ id: scheduledTaskId, workspaceId, agentId: managerAgentId }],
    });
  });

  it("normalizes legacy one-shot schedules in list responses", async () => {
    tables.scheduled_task[0] = scheduledTaskRow({
      schedule: { at: "2026-05-14T13:30:00.000Z" },
    });

    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduledTasks: [
        {
          id: scheduledTaskId,
          schedule: { kind: "at", runAt: "2026-05-14T13:30:00.000Z" },
        },
      ],
    });
  });

  it("preserves legacy scheduled-message rows with empty delivery JSON", async () => {
    tables.scheduled_task[0] = scheduledTaskRow({
      delivery: {},
    });

    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduledTasks: [
        {
          id: scheduledTaskId,
          delivery: { kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" },
        },
      ],
    });
  });

  it("omits completed one-shot scheduled messages from list responses", async () => {
    tables.scheduled_task[0] = scheduledTaskRow({
      schedule: { at: "2026-05-14T13:30:00.000Z" },
      next_run_at: null,
    });

    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scheduledTasks: [] });
  });

  it("omits unsupported legacy learning scheduled tasks from user-facing list responses", async () => {
    tables.scheduled_task.unshift(
      scheduledTaskRow({
        id: "88888888-8888-4888-8888-888888888888",
        title: null,
        instructions: null,
        schedule: { at: "2026-05-14T13:00:00.000Z" },
        delivery: { kind: "learning_reflection", sourceRunId: "run-123" },
        next_run_at: null,
      }),
    );

    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scheduledTasks).toHaveLength(1);
    expect(body.scheduledTasks[0]).toMatchObject({
      id: scheduledTaskId,
      delivery: { kind: "scheduled_agent_message" },
    });
  });

  it("creates a scheduled task and computes nextRunAt server-side", async () => {
    tables.scheduled_task = [];

    const response = await requestJson("POST", `/api/workspaces/${workspaceId}/scheduled-tasks`, {
      agentId: managerAgentId,
      title: "Review blocked PRs",
      instructions: "Find blocked PR-related work items and move them forward.",
      schedule: { kind: "every", interval: 1, unit: "hour" },
      timezone: "Etc/UTC",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.scheduledTask).toMatchObject({
      workspaceId,
      agentId: managerAgentId,
      enabled: true,
      nextRunAt: expect.any(String),
    });
    expect(tables.scheduled_task).toHaveLength(1);
    expect(tables.scheduled_task[0]).toMatchObject({
      workspace_id: workspaceId,
      agent_id: managerAgentId,
      delivery: { kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" },
    });
  });

  it("creates a disabled scheduled task without making it active", async () => {
    tables.scheduled_task = [];

    const response = await requestJson("POST", `/api/workspaces/${workspaceId}/scheduled-tasks`, {
      agentId: managerAgentId,
      title: "Daily review",
      instructions: "Review work items.",
      enabled: false,
      schedule: { kind: "every", interval: 1, unit: "day", at: "09:00" },
      timezone: "America/New_York",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.scheduledTask.enabled).toBe(false);
    expect(tables.scheduled_task[0]?.enabled).toBe(false);
  });

  it("rejects schedules for agents outside the scheduled-task agent set", async () => {
    const response = await requestJson("POST", `/api/workspaces/${workspaceId}/scheduled-tasks`, {
      agentId: codingAgentId,
      title: "Coding schedule",
      instructions: "Do coding work.",
      schedule: { kind: "every", interval: 1, unit: "hour" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scheduled_task_agent_not_found" },
    });
  });

  it("rejects invalid timezone names as a client error", async () => {
    const response = await requestJson("POST", `/api/workspaces/${workspaceId}/scheduled-tasks`, {
      agentId: managerAgentId,
      title: "Daily review",
      instructions: "Review work items.",
      schedule: { kind: "every", interval: 1, unit: "day", at: "09:00" },
      timezone: "not/a-zone",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects cross-workspace access", async () => {
    const response = await requestJson("GET", `/api/workspaces/${otherWorkspaceId}/scheduled-tasks`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("fails closed when the scheduled_task v1 schema is not available", async () => {
    const error = new Error("Could not find the 'workspace_id' column of 'scheduled_task' in the schema cache");
    Object.assign(error, { code: "PGRST204" });
    throwForSupabaseContext = { context: "scheduled_task schema readiness", error };

    const response = await requestJson("GET", `/api/workspaces/${workspaceId}/scheduled-tasks`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scheduled_task_schema_unavailable" },
    });
  });

  it("cancels a scheduled task by disabling the row", async () => {
    const response = await requestJson(
      "POST",
      `/api/workspaces/${workspaceId}/scheduled-tasks/${scheduledTaskId}/cancel`,
      {
        reason: "User requested cancellation",
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      cancelled: true,
      scheduledTask: { id: scheduledTaskId, enabled: false, lastError: "User requested cancellation" },
    });
    expect(tables.scheduled_task[0]).toMatchObject({
      enabled: false,
      last_error: "User requested cancellation",
    });
  });

  it("marks a scheduled task due when run-now is requested", async () => {
    const response = await requestJson(
      "POST",
      `/api/workspaces/${workspaceId}/scheduled-tasks/${scheduledTaskId}/run-now?agentId=${managerAgentId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      scheduledTask: { id: scheduledTaskId, enabled: true },
      scheduledFor: expect.any(String),
    });
    expect(tables.scheduled_task[0]?.next_run_at).toBe(body.scheduledFor);
  });

  it("rejects run-now for disabled scheduled tasks", async () => {
    tables.scheduled_task[0] = scheduledTaskRow({ enabled: false });

    const response = await requestJson(
      "POST",
      `/api/workspaces/${workspaceId}/scheduled-tasks/${scheduledTaskId}/run-now?agentId=${managerAgentId}`,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "scheduled_task_disabled" },
    });
    expect(tables.scheduled_task[0]?.enabled).toBe(false);
  });

  it("dispatches scheduled agent message deliveries with a service-role bearer", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    const response = await fetch(`${baseUrl}/api/internal/scheduled-tasks/${scheduledTaskId}/dispatch`, {
      method: "POST",
      headers: {
        authorization: "Bearer service-role-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "scheduled_agent_message",
      status: "not_handled",
    });
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
});
