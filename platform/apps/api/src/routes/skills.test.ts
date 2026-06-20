import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerSkillRoutes } from "./skills.js";

type Row = Record<string, unknown>;
type TableRows = Row[];
type SkillTestTables = {
  workspace_members: TableRows;
  workspaces: TableRows;
  skill: TableRows;
};

const tables: SkillTestTables = {
  workspace_members: [],
  workspaces: [],
  skill: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const agentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function skillRow(overrides: Row = {}) {
  return {
    id: skillId,
    workspace_id: workspaceId,
    agent_id: agentId,
    name: "api-debugging",
    description: "Check API logs and route validation when requests fail.",
    body: "Use route tests and API logs before changing contracts.",
    status: "draft",
    copied_from_skill_id: null,
    created_by_agent_id: otherAgentId,
    created_by_user_id: null,
    source_run_id: "66666666-6666-4666-8666-666666666666",
    created_at: "2026-06-20T12:00:00.000Z",
    updated_at: "2026-06-20T12:00:00.000Z",
    ...overrides,
  };
}

function resetTables() {
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.workspaces = [];
  tables.skill = [
    skillRow(),
    skillRow({
      id: "77777777-7777-4777-8777-777777777777",
      agent_id: otherAgentId,
      name: "planner-handoff",
      status: "approved",
      updated_at: "2026-06-21T12:00:00.000Z",
    }),
    skillRow({
      id: "88888888-8888-4888-8888-888888888888",
      workspace_id: otherWorkspaceId,
      name: "other-workspace",
    }),
  ];
  vi.clearAllMocks();
}

let baseUrl = "";

describe("skill routes", () => {
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
    registerSkillRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("lists skills for an authorized workspace", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/skills`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skills).toHaveLength(2);
    expect(body.skills[0]).toMatchObject({
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId,
      agentId: otherAgentId,
      status: "approved",
    });
  });

  it("filters skills by agent and status", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/skills?agentId=${agentId}&status=draft`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({
      id: skillId,
      name: "api-debugging",
      status: "draft",
    });
  });

  it("updates skill review fields and status", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "api-route-debugging",
        description: "Debug API routes through tests and logs.",
        body: "Read the route contract, add a regression test, then change behavior.",
        status: "approved",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skill).toMatchObject({
      id: skillId,
      name: "api-route-debugging",
      status: "approved",
      description: "Debug API routes through tests and logs.",
    });
    expect(tables.skill[0]).toMatchObject({
      name: "api-route-debugging",
      status: "approved",
    });
  });

  it("rejects unauthorized workspace access", async () => {
    tables.workspace_members = [];

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/skills`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
