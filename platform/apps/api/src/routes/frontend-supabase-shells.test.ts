import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentDashboardResponseSchema, RUN_HISTORY_PAGE_SIZE } from "../../../../contracts/agent-dashboard.js";
import { PlanReviewListResponseSchema } from "../../../../contracts/plans.js";
import {
  StoredAgentCreateRequestSchema,
  StoredAgentGatewayConfigUpdateRequestSchema,
} from "../../../../contracts/stored-agent-management.js";
import type { ApiConfig } from "../config.js";
import type { LauncherClient } from "../services/launcher.js";
import { registerAgentDashboardRoutes } from "./agent-dashboard.js";
import { registerPlanRoutes } from "./plans.js";
import { registerStoredAgentRoutes } from "./stored-agents.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const config: ApiConfig = {
  port: 0,
  host: "127.0.0.1",
  orchestratorBaseUrl: "http://127.0.0.1:4000",
  orchestratorWsUrl: "ws://127.0.0.1:4000",
  launcherBaseUrl: "http://127.0.0.1:4100",
  orchestratorRequestTimeoutMs: 500,
  launcherRequestTimeoutMs: 500,
  corsOrigins: "http://127.0.0.1:5173",
  wsUpgradePath: "/ws",
  wsConnectTimeoutMs: 500,
  workItemDefaultWorkspaceId: null,
  githubWebhookSecret: null,
  githubRepoWorkspaceMap: {},
  linearWebhookSecret: null,
  linearApiKey: null,
  linearProjectWorkspaceMap: {},
  linearTeamWorkspaceMap: {},
};

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createShellApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  registerAgentDashboardRoutes(app);
  registerPlanRoutes(app, config, async () => ({ status: 501, body: {}, headers: {} }));
  registerStoredAgentRoutes(app, {} as LauncherClient);
  return app;
}

describe("frontend Supabase API route shells", () => {
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.resetAllMocks();
    const listening = await listen(createShellApp());
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("parses the dashboard, plan review, and stored-agent contract payloads needed by current frontend callers", () => {
    expect(RUN_HISTORY_PAGE_SIZE).toBe(8);
    expect(
      AgentDashboardResponseSchema.parse({
        latestRun: {
          runId: "run-1",
          agentId,
          attempt: 1,
          createdAt: "2026-04-26T12:00:00.000Z",
          startedAt: null,
          completedAt: null,
          status: "running",
          error: null,
          terminalReason: null,
          trackerKind: "linear",
          trackerIssueKey: "ABC-123",
          issueIdentifier: "ABC-123",
          issueState: "started",
          updatedAt: "2026-04-26T12:00:00.000Z",
        },
        tasks: [
          {
            taskId: "task-1",
            runId: "run-1",
            attempt: 1,
            status: "completed",
            type: "tool",
            inputTokens: 12,
            outputTokens: 34,
            totalTokens: 46,
            lastEvent: "done",
            lastEventAt: "2026-04-26T12:01:00.000Z",
            error: null,
            updatedAt: "2026-04-26T12:01:00.000Z",
          },
        ],
        configState: {
          scopeType: "agent",
          scopeId: agentId,
          syncStatus: "synced",
          syncError: null,
          lastApplyStatus: "applied",
          lastApplyError: null,
          lastApplyAt: "2026-04-26T12:02:00.000Z",
          lastAppliedVersion: 2,
        },
      }),
    ).toMatchObject({ latestRun: { runId: "run-1" }, tasks: [{ taskId: "task-1" }] });

    expect(
      PlanReviewListResponseSchema.parse({
        plans: [
          {
            id: "plan-1",
            name: "Review plan",
            description: null,
            status: "pending",
            type: "implementation",
            createdAt: "2026-04-26T12:00:00.000Z",
            updatedAt: "2026-04-26T12:00:00.000Z",
            evidence: [{ path: "apps/api/src/app.ts", line: 12, snippet: "register", label: "route" }],
            tasks: [
              {
                id: "task-1",
                workspaceId,
                planId: "plan-1",
                name: "Add route",
                description: null,
                state: "todo",
                priority: null,
                labels: ["api"],
                metadata: {},
                createdAt: "2026-04-26T12:00:00.000Z",
                updatedAt: "2026-04-26T12:00:00.000Z",
                evidence: [],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ plans: [{ id: "plan-1" }] });

    expect(
      StoredAgentCreateRequestSchema.parse({
        name: "Custom runtime",
        workspaceId,
        type: "custom",
        customTarget: {
          backendType: "openai_compatible",
          baseUrl: "http://127.0.0.1:4100",
          agentId: "custom-agent",
        },
      }),
    ).toMatchObject({ name: "Custom runtime", type: "custom" });

    expect(
      StoredAgentGatewayConfigUpdateRequestSchema.parse({
        backend: {
          type: "openai_compatible",
          baseUrl: "http://127.0.0.1:4100",
          agentId: "custom-agent",
        },
      }),
    ).toMatchObject({ backend: { baseUrl: "http://127.0.0.1:4100", agentId: "custom-agent" } });
  });

  it("registers authenticated shell routes for dashboard and plan review reads", async () => {
    const headers = { authorization: "Bearer test-token" };

    const eventsResponse = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}/events`, { headers });
    expect(eventsResponse.status).toBe(200);
    await expect(eventsResponse.json()).resolves.toEqual({ events: [] });

    const planReviewsResponse = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/plan-reviews`, { headers });
    expect(planReviewsResponse.status).toBe(502);
    await expect(planReviewsResponse.json()).resolves.toMatchObject({
      error: { code: "plan_reviews_failed" },
    });
  });

  it("registers authenticated shell routes for custom gateway config", async () => {
    const headers = {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    };

    const configResponse = await fetch(`${baseUrl}/api/stored-agents/${agentId}/gateway-config`, { headers });
    expect(configResponse.status).toBe(501);

    const updateConfigResponse = await fetch(`${baseUrl}/api/stored-agents/${agentId}/gateway-config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        backend: {
          type: "openai_compatible",
          baseUrl: "http://127.0.0.1:4100",
          agentId: "custom-agent",
        },
      }),
    });
    expect(updateConfigResponse.status).toBe(501);
  });

  it("requires auth on the new shell routes", async () => {
    const response = await fetch(`${baseUrl}/api/agent-dashboard/${agentId}`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });
});
