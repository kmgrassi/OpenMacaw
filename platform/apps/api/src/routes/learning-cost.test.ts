import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerLearningCostRoutes } from "./learning-cost.js";

type Row = Record<string, unknown>;
type LearningCostTestTables = {
  workspace_members: Row[];
  workspaces: Row[];
  broker_run: Row[];
  broker_task: Row[];
  session_thread: Row[];
};

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const runId = "run-1";

const tables: LearningCostTestTables = {
  workspace_members: [],
  workspaces: [],
  broker_run: [],
  broker_task: [],
  session_thread: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  normalizeSupabaseError: (_context: string, error: unknown) => error,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.workspaces = [{ id: workspaceId, owner_user_id: userId }];
  tables.broker_run = [
    {
      run_id: runId,
      workspace_id: workspaceId,
      created_at: "2026-05-18T12:00:00.000Z",
      metadata: { learning: { costUsd: 0.05 } },
      session_thread_id: null,
    },
  ];
  tables.broker_task = [
    {
      task_id: "task-1",
      run_id: runId,
      type: "memory.search",
      created_at: "2026-05-18T12:01:00.000Z",
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      last_event: null,
    },
    {
      task_id: "task-2",
      run_id: runId,
      type: "turn",
      created_at: "2026-05-18T12:02:00.000Z",
      input_tokens: 1000,
      output_tokens: 1000,
      total_tokens: 2000,
      last_event: null,
    },
  ];
  tables.session_thread = [];
  vi.clearAllMocks();
}

async function request(path: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  });
}

describe("learning cost routes", () => {
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
    registerLearningCostRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns workspace-scoped learning telemetry for a date range", async () => {
    const response = await request(
      `/api/workspaces/${workspaceId}/learning-cost?startDate=2026-05-18&endDate=2026-05-18`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      startDate: "2026-05-18",
      endDate: "2026-05-18",
      totals: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        totalCost: 0.05,
      },
      aggregates: {
        byKind: [{ kind: "retrieval", taskCount: 1, runCount: 1 }],
        daily: [{ date: "2026-05-18", taskCount: 1, runCount: 1 }],
      },
    });
  });

  it("rejects access to another workspace", async () => {
    const response = await request(
      `/api/workspaces/${otherWorkspaceId}/learning-cost?startDate=2026-05-18&endDate=2026-05-18`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("validates date query parameters", async () => {
    const response = await request(`/api/workspaces/${workspaceId}/learning-cost?startDate=bad&endDate=2026-05-18`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
