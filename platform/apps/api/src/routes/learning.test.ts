import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchLearningScheduledTaskDelivery } from "../services/scheduled-tasks.js";
import { registerLearningRoutes } from "./learning.js";

vi.mock("../services/scheduled-tasks.js", () => ({
  dispatchLearningScheduledTaskDelivery: vi.fn(),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const scheduledTaskId = "33333333-3333-4333-8333-333333333333";
const scheduledTaskRunId = "44444444-4444-4444-8444-444444444444";
const sourceWorkItemId = "55555555-5555-4555-8555-555555555555";

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function runtimePayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "learning_reflection",
    scheduled_task_id: scheduledTaskId,
    scheduled_task_run_id: scheduledTaskRunId,
    scheduled_run_id: `scheduled_${scheduledTaskRunId}`,
    workspace_id: workspaceId,
    agent_id: agentId,
    source_work_item_id: sourceWorkItemId,
    scheduled_for: "2026-06-15T12:00:00.000Z",
    delivery: {
      kind: "learning_reflection",
      sourceRunId: "run-123",
      sourceTaskId: "task-456",
    },
    trace_id: "trace-123",
    ...overrides,
  };
}

function request(kind: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/api/learning/jobs/${kind}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("learning routes", () => {
  let server: Server;

  beforeEach(async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-token";
    vi.mocked(dispatchLearningScheduledTaskDelivery).mockReset();

    const app = express();
    app.use(express.json());
    registerLearningRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("accepts the runtime learning_reflection payload shape and dispatches it", async () => {
    vi.mocked(dispatchLearningScheduledTaskDelivery).mockResolvedValueOnce({
      kind: "learning_reflection",
      status: "completed",
      result: {
        sourceRunId: "run-123",
        workspaceId,
        agentId,
        candidatesGenerated: 1,
        memoriesWritten: 1,
        memoryIds: ["memory-1"],
      },
    });

    const response = await request("learning_reflection", runtimePayload(), "service-role-token");

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      kind: "learning_reflection",
      status: "completed",
      result: { sourceRunId: "run-123", memoriesWritten: 1 },
    });
    expect(dispatchLearningScheduledTaskDelivery).toHaveBeenCalledWith({
      workspaceId,
      delivery: {
        kind: "learning_reflection",
        sourceRunId: "run-123",
        sourceTaskId: "task-456",
      },
    });
  });

  it("accepts the runtime learning_distillation payload shape and dispatches it", async () => {
    vi.mocked(dispatchLearningScheduledTaskDelivery).mockResolvedValueOnce({
      kind: "learning_distillation",
      status: "completed",
      workspaceId,
      consideredMemoryCount: 2,
      clusterCount: 1,
      candidateCount: 1,
      candidateMemoryIds: ["memory-2"],
    });

    const response = await request(
      "learning_distillation",
      runtimePayload({
        kind: "learning_distillation",
        agent_id: undefined,
        source_work_item_id: undefined,
        delivery: { kind: "learning_distillation", windowDays: 14 },
      }),
      "service-role-token",
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      kind: "learning_distillation",
      status: "completed",
      workspaceId,
      candidateCount: 1,
    });
    expect(dispatchLearningScheduledTaskDelivery).toHaveBeenCalledWith({
      workspaceId,
      delivery: { kind: "learning_distillation", windowDays: 14 },
    });
  });

  it("rejects missing service-role bearer tokens", async () => {
    const response = await request("learning_reflection", runtimePayload());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(dispatchLearningScheduledTaskDelivery).not.toHaveBeenCalled();
  });

  it("rejects path/body/delivery kind mismatches", async () => {
    const response = await request(
      "learning_reflection",
      runtimePayload({
        kind: "learning_distillation",
        delivery: { kind: "learning_distillation", windowDays: 7 },
      }),
      "service-role-token",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "learning_job_kind_mismatch" },
    });
    expect(dispatchLearningScheduledTaskDelivery).not.toHaveBeenCalled();
  });

  it("rejects unknown learning job kinds", async () => {
    const response = await request("unknown", runtimePayload(), "service-role-token");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "learning_job_kind_unknown" },
    });
    expect(dispatchLearningScheduledTaskDelivery).not.toHaveBeenCalled();
  });
});
