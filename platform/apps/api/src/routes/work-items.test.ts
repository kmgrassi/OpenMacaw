import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../config.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { registerWorkItemRoutes } from "./work-items.js";

type Row = Record<string, unknown>;
type TableRows = Row[];
type WorkItemTestTables = {
  workspace_members: TableRows;
  workspaces: TableRows;
  work_items: TableRows;
  event_log: TableRows;
  webhook_delivery: TableRows;
};

const tables: WorkItemTestTables = {
  workspace_members: [],
  workspaces: [],
  work_items: [],
  event_log: [],
  webhook_delivery: [],
};
const mockClient = createMockSupabaseClient(tables);

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: () => mockClient,
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
}));

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

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const workItemId = "33333333-3333-4333-8333-333333333333";
const otherWorkItemId = "44444444-4444-4444-8444-444444444444";
const futureUntil = "2099-04-30T21:00:00.000Z";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function workItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: workItemId,
    task_id: null,
    workspace_id: workspaceId,
    plan_id: null,
    identifier: "WI-1",
    title: "Review PR",
    description: "Review the open PR.",
    instructions: "Review the open PR.",
    state: "todo",
    priority: null,
    source: "api",
    labels: [],
    depends_on: [],
    completion_gates: [],
    metadata: {},
    next_poll_at: null,
    last_polled_at: null,
    poll_cadence_seconds: 300,
    created_at: "2026-04-25T12:00:00.000Z",
    updated_at: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

function resetTables() {
  config.githubWebhookSecret = null;
  config.githubRepoWorkspaceMap = {};
  tables.workspace_members = [{ workspace_id: workspaceId, user_id: userId }];
  tables.workspaces = [];
  tables.work_items = [
    workItemRow(),
    workItemRow({
      id: otherWorkItemId,
      workspace_id: otherWorkspaceId,
      identifier: "WI-2",
      title: "Other workspace item",
    }),
  ];
  tables.event_log = [];
  tables.webhook_delivery = [];
  vi.clearAllMocks();
}

function snoozeUrl(targetWorkspaceId = workspaceId, targetWorkItemId = workItemId) {
  return `${baseUrl}/api/workspaces/${targetWorkspaceId}/work-items/${targetWorkItemId}/snooze`;
}

function wakeUrl(targetWorkspaceId = workspaceId, targetWorkItemId = workItemId) {
  return `${baseUrl}/api/workspaces/${targetWorkspaceId}/work-items/${targetWorkItemId}/wake`;
}

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      connection: "close",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function githubSignature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

let baseUrl = "";

describe("work item routes", () => {
  let server: Server;

  beforeEach(async () => {
    resetTables();

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buffer) => {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
        },
      }),
    );
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerWorkItemRoutes(app, config);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("maps unauthorized workspace access to a 403 response", async () => {
    tables.workspace_members = [];

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/work-items`, {
      headers: { authorization: "Bearer test-token", connection: "close" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("snoozes a work item with an explicit until timestamp and writes an event", async () => {
    const response = await postJson(snoozeUrl(), {
      workspaceId,
      workItemId,
      until: futureUntil,
      reason: "review later",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workItem).toMatchObject({
      id: workItemId,
      nextPollAt: futureUntil,
      lastPolledAt: null,
      pollCadenceSeconds: 300,
      snooze: {
        indefinite: false,
        reason: "review later",
        snoozedBy: { kind: "user", userId },
      },
    });
    expect(tables.work_items.find((row) => row.id === workItemId)?.next_poll_at).toBe(futureUntil);
    expect(tables.event_log).toHaveLength(1);
    expect(tables.event_log[0]).toMatchObject({
      workspace_id: workspaceId,
      work_item_id: workItemId,
      kind: "work_item.snoozed",
      source: "platform_api",
    });
  });

  it("snoozes a work item with seconds by resolving a future nextPollAt", async () => {
    const before = Date.now();
    const response = await postJson(snoozeUrl(), {
      workspaceId,
      workItemId,
      seconds: 120,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const nextPollAt = Date.parse(body.workItem.nextPollAt);
    expect(nextPollAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(nextPollAt).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it("snoozes a work item indefinitely with the sentinel timestamp", async () => {
    const response = await postJson(snoozeUrl(), {
      workspaceId,
      workItemId,
      indefinite: true,
      reason: "waiting on external input",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workItem.nextPollAt).toBe("9999-01-01T00:00:00.000Z");
    expect(body.workItem.snooze).toMatchObject({
      indefinite: true,
      reason: "waiting on external input",
    });
  });

  it("rejects snooze requests without a target time mode", async () => {
    const response = await postJson(snoozeUrl(), {
      workspaceId,
      workItemId,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(tables.event_log).toHaveLength(0);
  });

  it("rejects snooze requests with an until timestamp in the past", async () => {
    const response = await postJson(snoozeUrl(), {
      workspaceId,
      workItemId,
      until: "2020-01-01T00:00:00.000Z",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_snooze_until" },
    });
  });

  it("wakes a snoozed work item and writes a woken event", async () => {
    tables.work_items = [workItemRow({ next_poll_at: futureUntil })];

    const response = await postJson(wakeUrl(), {
      workspaceId,
      workItemId,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workItem).toMatchObject({
      id: workItemId,
      nextPollAt: null,
      snooze: null,
    });
    expect(tables.work_items[0]?.next_poll_at).toBeNull();
    expect(tables.event_log).toHaveLength(1);
    expect(tables.event_log[0]).toMatchObject({
      workspace_id: workspaceId,
      work_item_id: workItemId,
      kind: "work_item.woken",
    });
  });

  it("returns 403 before snoozing an item in a workspace the user cannot access", async () => {
    const response = await postJson(snoozeUrl(otherWorkspaceId, otherWorkItemId), {
      workspaceId: otherWorkspaceId,
      workItemId: otherWorkItemId,
      until: futureUntil,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(tables.work_items.find((row) => row.id === otherWorkItemId)?.next_poll_at).toBeNull();
    expect(tables.event_log).toHaveLength(0);
  });

  it("lists work items with snooze projection fields", async () => {
    tables.work_items = [workItemRow({ next_poll_at: futureUntil })];
    tables.event_log = [
      {
        id: "event-1",
        workspace_id: workspaceId,
        work_item_id: workItemId,
        kind: "work_item.snoozed",
        source: "platform_api",
        raw_payload: null,
        payload: {
          actor: { kind: "user", user_id: userId },
          reason: "after lunch",
          until: futureUntil,
          indefinite: false,
          snoozed_at: "2026-04-30T12:00:00.000Z",
        },
        created_at: "2026-04-30T12:00:00.000Z",
      },
    ];

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/work-items`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workItems[0]).toMatchObject({
      id: workItemId,
      nextPollAt: futureUntil,
      lastPolledAt: null,
      pollCadenceSeconds: 300,
      snooze: {
        indefinite: false,
        reason: "after lunch",
        snoozedAt: "2026-04-30T12:00:00.000Z",
        snoozedBy: { kind: "user", userId },
      },
    });
  });

  it("clears snooze projection when the latest state event is a wake", async () => {
    tables.work_items = [workItemRow({ next_poll_at: futureUntil })];
    tables.event_log = [
      {
        id: "event-1",
        workspace_id: workspaceId,
        work_item_id: workItemId,
        kind: "work_item.snoozed",
        source: "platform_api",
        raw_payload: null,
        payload: {
          actor: { kind: "user", user_id: userId },
          reason: "after lunch",
          until: futureUntil,
          indefinite: false,
          snoozed_at: "2026-04-30T12:00:00.000Z",
        },
        created_at: "2026-04-30T12:00:00.000Z",
      },
      {
        id: "event-2",
        workspace_id: workspaceId,
        work_item_id: workItemId,
        kind: "work_item.woken",
        source: "platform_api",
        raw_payload: null,
        payload: {
          actor: { kind: "user", user_id: userId },
          woken_at: "2026-04-30T13:00:00.000Z",
        },
        created_at: "2026-04-30T13:00:00.000Z",
      },
    ];

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/work-items`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workItems[0]).toMatchObject({
      id: workItemId,
      nextPollAt: futureUntil,
      snooze: null,
    });
  });

  it("skips replayed GitHub webhook deliveries after the first successful claim", async () => {
    config.githubWebhookSecret = "github-secret";
    config.githubRepoWorkspaceMap = { "openmacaw/repo": workspaceId };
    tables.work_items.push(
      workItemRow({
        id: "55555555-5555-4555-8555-555555555555",
        source: "github",
        title: "Old auth bug title",
        metadata: { external_id: "openmacaw/repo:issue:17" },
        "metadata->>external_id": "openmacaw/repo:issue:17",
      }),
    );

    const payload = JSON.stringify({
      action: "opened",
      repository: {
        full_name: "openmacaw/repo",
        html_url: "https://github.com/openmacaw/repo",
      },
      issue: {
        number: 17,
        title: "Fix auth bug",
        body: "Investigate duplicate webhook processing.",
        state: "open",
        html_url: "https://github.com/openmacaw/repo/issues/17",
        labels: [],
      },
    });
    const headers = {
      connection: "close",
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature("github-secret", payload),
    };

    const first = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(first.status).toBe(202);
    expect(tables.work_items).toHaveLength(3);
    expect(tables.webhook_delivery).toHaveLength(1);

    const replay = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers,
      body: payload,
    });

    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      accepted: true,
      skipped: true,
      reason: "duplicate_delivery",
    });
    expect(tables.work_items).toHaveLength(3);
    expect(tables.webhook_delivery).toHaveLength(1);
  });

  it("skips GitHub webhook replays even when the attacker changes the unsigned delivery header", async () => {
    config.githubWebhookSecret = "github-secret";
    config.githubRepoWorkspaceMap = { "openmacaw/repo": workspaceId };
    tables.work_items.push(
      workItemRow({
        id: "66666666-6666-4666-8666-666666666666",
        source: "github",
        title: "Old replay-safe title",
        metadata: { external_id: "openmacaw/repo:issue:23" },
        "metadata->>external_id": "openmacaw/repo:issue:23",
      }),
    );

    const payload = JSON.stringify({
      action: "opened",
      repository: {
        full_name: "openmacaw/repo",
        html_url: "https://github.com/openmacaw/repo",
      },
      issue: {
        number: 23,
        title: "Replay-safe webhook ingest",
        body: "Reject forged redeliveries that reuse a captured signed body.",
        state: "open",
        html_url: "https://github.com/openmacaw/repo/issues/23",
        labels: [],
      },
    });

    const first = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-original",
        "x-hub-signature-256": githubSignature("github-secret", payload),
      },
      body: payload,
    });
    expect(first.status).toBe(202);
    expect(tables.work_items).toHaveLength(3);
    expect(tables.webhook_delivery).toHaveLength(1);

    const replay = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-forged-replay",
        "x-hub-signature-256": githubSignature("github-secret", payload),
      },
      body: payload,
    });

    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      accepted: true,
      skipped: true,
      reason: "duplicate_delivery",
    });
    expect(tables.work_items).toHaveLength(3);
    expect(tables.webhook_delivery).toHaveLength(1);
  });

  it("releases the GitHub delivery claim when downstream processing fails", async () => {
    config.githubWebhookSecret = "github-secret";
    config.githubRepoWorkspaceMap = { "openmacaw/repo": workspaceId };
    tables.work_items.push({
      id: "bad-existing-row",
      workspace_id: workspaceId,
      title: "Bad row shape",
      source: "github",
      metadata: { external_id: "openmacaw/repo:issue:18" },
      "metadata->>external_id": "openmacaw/repo:issue:18",
    });

    const payload = JSON.stringify({
      action: "opened",
      repository: {
        full_name: "openmacaw/repo",
        html_url: "https://github.com/openmacaw/repo",
      },
      issue: {
        number: 18,
        title: "Another auth bug",
        body: "Trigger a downstream processing failure.",
        state: "open",
        html_url: "https://github.com/openmacaw/repo/issues/18",
        labels: [],
      },
    });
    const response = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-fail-1",
        "x-hub-signature-256": githubSignature("github-secret", payload),
      },
      body: payload,
    });

    expect(response.status).toBe(502);
    expect(tables.webhook_delivery).toHaveLength(0);
  });
});
