import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApp, shouldRequireJwtAuth } from "./app.js";

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
  githubWebhookSecret: "github-secret",
  githubRepoWorkspaceMap: {},
  linearWebhookSecret: "linear-secret",
  linearApiKey: null,
  linearProjectWorkspaceMap: {},
  linearTeamWorkspaceMap: {},
};

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function mockStdoutWrite() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

type StdoutWriteSpy = ReturnType<typeof mockStdoutWrite>;

function parseLogLines(writeSpy: StdoutWriteSpy) {
  return writeSpy.mock.calls
    .flatMap(([chunk]) => String(chunk).trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("API auth routing", () => {
  let server: ReturnType<typeof createServer> | undefined;
  let stdoutWrite: StdoutWriteSpy | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    stdoutWrite?.mockRestore();
    stdoutWrite = undefined;
  });

  it("requires JWT auth for app API routes but not signed webhook ingress", async () => {
    expect(shouldRequireJwtAuth({ path: "/work-items" } as never)).toBe(true);
    expect(shouldRequireJwtAuth({ method: "POST", path: "/memory/items" } as never)).toBe(false);
    expect(
      shouldRequireJwtAuth({
        method: "POST",
        path: "/work-items/33333333-3333-4333-8333-333333333333/cutovers",
      } as never),
    ).toBe(false);
    expect(shouldRequireJwtAuth({ path: "/webhooks/github" } as never)).toBe(false);
    expect(shouldRequireJwtAuth({ path: "/webhooks/linear" } as never)).toBe(false);
    expect(
      shouldRequireJwtAuth({
        path: "/internal/scheduled-tasks/11111111-1111-4111-8111-111111111111/dispatch",
      } as never),
    ).toBe(false);

    server = createServer(createApp(config));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const manualResponse = await fetch(`${baseUrl}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", title: "Manual item" }),
    });
    expect(manualResponse.status).toBe(401);
    await expect(manualResponse.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });

    const webhookResponse = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(webhookResponse.status).toBe(401);
    await expect(webhookResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_signature" },
    });

    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const internalDispatchResponse = await fetch(
      `${baseUrl}/api/internal/scheduled-tasks/11111111-1111-4111-8111-111111111111/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "11111111-1111-4111-8111-111111111111" }),
      },
    );
    expect(internalDispatchResponse.status).toBe(401);
    await expect(internalDispatchResponse.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("returns and preserves request correlation headers", async () => {
    server = createServer(createApp(config));
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/livez`, {
      headers: {
        "x-trace-id": "trc-client",
        "x-request-id": "req-client",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).toBe("trc-client");
    expect(response.headers.get("x-request-id")).toBe("req-client");
  });

  it("allows and exposes correlation headers for browser clients", async () => {
    server = createServer(createApp(config));
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/livez`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-trace-id,x-request-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Trace-Id");
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Request-Id");
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Trace-Id, X-Request-Id");
  });

  it("logs request lifecycle records with route, status, duration, and correlation context", async () => {
    stdoutWrite = mockStdoutWrite();
    server = createServer(createApp(config));
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/livez`, {
      headers: {
        "x-trace-id": "trc-lifecycle",
        "x-request-id": "req-lifecycle",
      },
    });
    expect(response.status).toBe(200);

    const logs = parseLogLines(stdoutWrite);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "request_started",
          method: "GET",
          path: "/livez",
          trace_id: "trc-lifecycle",
          request_id: "req-lifecycle",
        }),
        expect.objectContaining({
          event: "request_completed",
          method: "GET",
          path: "/livez",
          route_pattern: "/livez",
          status_code: 200,
          trace_id: "trc-lifecycle",
          request_id: "req-lifecycle",
        }),
      ]),
    );

    const completed = logs.find((log) => log.event === "request_completed");
    expect(completed?.duration_ms).toEqual(expect.any(Number));
  });

  it("preserves middleware HTTP error status (e.g. JSON parse failures stay 400, not 500)", async () => {
    stdoutWrite = mockStdoutWrite();
    server = createServer(createApp(config));
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/work-items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-token",
      },
      body: "{not valid json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("entity.parse.failed");

    const logs = parseLogLines(stdoutWrite);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "request_failed",
          level: "warn",
          status_code: 400,
          failure_class: "client_error",
        }),
      ]),
    );
    expect(logs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "request_failed",
          status_code: 500,
        }),
      ]),
    );
  });

  it("logs 4xx request failures separately with response error code and workspace context", async () => {
    stdoutWrite = mockStdoutWrite();
    server = createServer(createApp(config));
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", title: "Manual item" }),
    });
    expect(response.status).toBe(401);

    const logs = parseLogLines(stdoutWrite);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "request_failed",
          level: "warn",
          method: "POST",
          path: "/api/work-items",
          status_code: 401,
          failure_class: "client_error",
          error_code: "auth_required",
          workspace_id: "workspace-1",
        }),
      ]),
    );
  });

  it("requires JWT auth for workspace diagnostic routes mounted under /api", async () => {
    server = createServer(createApp(config));
    const port = await listen(server);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/diagnostic/workspace/22222222-2222-4222-8222-222222222222/agents`,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });
});
