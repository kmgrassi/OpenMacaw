import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerSessionPolicyRoutes } from "./session-policy.js";

type Row = Record<string, unknown>;
type Tables = {
  workspace_members: Row[];
  session_thread: Row[];
  policy_session_state: Row[];
};

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionThreadId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";

const tables: Tables = {
  workspace_members: [],
  session_thread: [],
  policy_session_state: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
}));

let baseUrl = "";

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.session_thread = [{ id: sessionThreadId, workspace_id: workspaceId }];
  tables.policy_session_state = [
    {
      workspace_id: workspaceId,
      session_thread_id: sessionThreadId,
      key: "accrued_cost_usd",
      value_numeric: "0.075",
      value_json: null,
      updated_at: "2026-06-30T14:00:00.000Z",
    },
    {
      workspace_id: workspaceId,
      session_thread_id: sessionThreadId,
      key: "risk_points",
      value_numeric: 4,
      value_json: null,
      updated_at: "2026-06-30T14:01:00.000Z",
    },
    {
      workspace_id: workspaceId,
      session_thread_id: sessionThreadId,
      key: "cost_budget_asked_thresholds",
      value_numeric: null,
      value_json: [0.05],
      updated_at: "2026-06-30T14:02:00.000Z",
    },
  ];
  vi.clearAllMocks();
}

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(path: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
  });
}

describe("session policy routes", () => {
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
    registerSessionPolicyRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns live counters and raw state for a session", async () => {
    const response = await request(`/api/sessions/${sessionThreadId}/policy-state?workspaceId=${workspaceId}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionThreadId,
      workspaceId,
      counters: {
        toolCallCount: 0,
        accruedCostUsd: 0.075,
        riskPoints: 4,
      },
      state: [
        { key: "accrued_cost_usd", valueNumeric: 0.075 },
        { key: "cost_budget_asked_thresholds", valueJson: [0.05] },
        { key: "risk_points", valueNumeric: 4 },
      ],
    });
  });

  it("requires workspace membership", async () => {
    const response = await request(`/api/sessions/${sessionThreadId}/policy-state?workspaceId=${otherWorkspaceId}`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("requires a workspaceId query parameter", async () => {
    const response = await request(`/api/sessions/${sessionThreadId}/policy-state`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
