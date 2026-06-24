import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import type * as SupabaseClientModule from "../supabase-client.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type { LauncherClient } from "../services/launcher.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerAgentObservationRoutes } from "./agent-observation.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SupabaseClientModule>();
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const targetAgentId = "44444444-4444-4444-8444-444444444444";
const observerAgentId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function agent(id: string, type: "planning" | "coding", workspace = workspaceId) {
  return {
    id,
    workspace_id: workspace,
    name: type === "planning" ? "Planning Agent" : "Coding Agent",
    status: "ready",
    type,
    context: null,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: userId,
    updated_at: "2026-04-26T12:00:00.000Z",
  };
}

describe("agent observation routes", () => {
  let server: Server;
  let baseUrl = "";
  let launcherClient: LauncherClient;

  beforeEach(async () => {
    launcherClient = {
      getAgent: vi.fn().mockResolvedValue({
        data: {
          id: targetAgentId,
          name: "Coding Agent",
          workspace_id: workspaceId,
          project_id: null,
          description: null,
          slug: null,
          status: "running",
          type: "coding",
          session_id: "session-1",
          context: null,
          is_active: true,
          model_settings: {},
          tool_policy: {},
          has_credentials: true,
          created_at: null,
          updated_at: null,
        },
      }),
    } as unknown as LauncherClient;

    vi.mocked(findSetupAgentById).mockImplementation(async (_accessToken, id) => {
      if (id === targetAgentId) return agent(targetAgentId, "coding");
      if (id === observerAgentId) return agent(observerAgentId, "planning");
      return null;
    });

    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        workspace_members: [{ workspace_id: workspaceId, user_id: userId }],
        workspaces: [],
        engine_instance: [
          {
            instance_id: "engine-1",
            agent_id: targetAgentId,
            status: "running",
            last_health_at: "2026-04-26T12:05:00.000Z",
            updated_at: "2026-04-26T12:05:00.000Z",
          },
        ],
        gateway_config_state: [
          {
            scope_type: "agent",
            scope_id: targetAgentId,
            sync_status: "synced",
            sync_error: null,
            last_apply_status: "applied",
            last_apply_error: null,
            last_apply_at: "2026-04-26T12:00:00.000Z",
            synced_at: "2026-04-26T12:00:00.000Z",
          },
        ],
        broker_run: [
          {
            run_id: "run-1",
            agent_id: targetAgentId,
            status: "failed",
            started_at: "2026-04-26T12:01:00.000Z",
            completed_at: "2026-04-26T12:02:00.000Z",
            updated_at: "2026-04-26T12:02:00.000Z",
            created_at: "2026-04-26T12:01:00.000Z",
            error: "provider_rate_limited",
            terminal_reason: "model call failed",
          },
        ],
        broker_task: [
          {
            task_id: "task-1",
            run_id: "run-1",
            status: "failed",
            type: "model",
            last_event: "model_call_failed",
            last_event_at: "2026-04-26T12:02:00.000Z",
            error: "provider_rate_limited",
            updated_at: "2026-04-26T12:02:00.000Z",
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
    registerAgentObservationRoutes(app, launcherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("returns summarized health and events for a planning observer in the same workspace", async () => {
    const response = await fetch(
      `${baseUrl}/api/agents/${targetAgentId}/observe?observerAgentId=${observerAgentId}&limit=5`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.targetAgent).toMatchObject({
      id: targetAgentId,
      workspaceId,
      agentType: "coding",
    });
    expect(body.observerAgentId).toBe(observerAgentId);
    expect(body.health.status).toBe("degraded");
    expect(body.health.lastFailure).toMatchObject({
      severity: "error",
      source: "runtime",
      runId: "run-1",
    });
    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "run_failed", error: "provider_rate_limited" }),
        expect.objectContaining({ event: "tool_call_failed", taskId: "task-1" }),
      ]),
    );
  });

  it("rejects observers outside the target workspace", async () => {
    vi.mocked(findSetupAgentById).mockImplementation(async (_accessToken, id) => {
      if (id === targetAgentId) return agent(targetAgentId, "coding", workspaceId);
      if (id === observerAgentId) return agent(observerAgentId, "planning", otherWorkspaceId);
      return null;
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/observe`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ observerAgentId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "agent_observation_forbidden" },
    });
  });

  it("returns a server error when workspace membership lookup fails", async () => {
    vi.mocked(getServiceRoleSupabase).mockImplementation(() => {
      throw new Error("Supabase workspace_members query failed (503)");
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/observe`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_membership_check_failed" },
    });
    expect(launcherClient.getAgent).not.toHaveBeenCalled();
  });

  it("rejects non-planning observers", async () => {
    vi.mocked(findSetupAgentById).mockImplementation(async (_accessToken, id) => {
      if (id === targetAgentId) return agent(targetAgentId, "coding");
      if (id === observerAgentId) return agent(observerAgentId, "coding");
      return null;
    });

    const response = await fetch(`${baseUrl}/api/agents/${targetAgentId}/observe`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ observerAgentId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "agent_observation_forbidden" },
    });
  });
});
