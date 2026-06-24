import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokeDevTool } from "../services/dev-tool-invocation.js";
import { registerDevToolInvocationRoutes } from "./dev-tool-invocation.js";

vi.mock("../services/dev-tool-invocation.js", () => ({
  invokeDevTool: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const toolId = "44444444-4444-4444-8444-444444444444";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("dev tool invocation routes", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let app: express.Express;
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = "development";
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerDevToolInvocationRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await closeServer(server);
  });

  it("requires auth", async () => {
    const response = await fetch(`${baseUrl}/api/dev/tools/shell.exec/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, workspaceId, input: { path: "package.json" } }),
    });

    expect(response.status).toBe(401);
    expect(invokeDevTool).not.toHaveBeenCalled();
  });

  it("is unavailable outside development", async () => {
    process.env.NODE_ENV = "production";

    const response = await fetch(`${baseUrl}/api/dev/tools/shell.exec/invoke`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ agentId, workspaceId, input: { path: "package.json" } }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(invokeDevTool).not.toHaveBeenCalled();
  });

  it("invokes a dev tool with camelCase request fields", async () => {
    vi.mocked(invokeDevTool).mockResolvedValue({
      agentId,
      workspaceId,
      toolId,
      toolSlug: "shell.exec",
      toolCallId: "dev-tool-call",
      executionProfile: {
        runnerKind: "local_model_coding",
        provider: "local",
        model: "qwen",
        missing: [],
      },
      observation: {
        toolCallId: "dev-tool-call",
        correlationId: null,
        eventType: "dev_tool_invocation",
        messageKind: "tool_result",
        toolSlug: "shell.exec",
        status: "completed",
        approvalState: "not_required",
        commandActions: ["read"],
        arguments: { path: "package.json" },
        result: { ok: true, status: 200, output: "{}" },
        outputSummary: "{}",
        errorCode: null,
        errorMessage: null,
        startedAt: "2026-05-12T12:00:00.000Z",
        completedAt: "2026-05-12T12:00:00.010Z",
        durationMs: 10,
      },
    });

    const response = await fetch(`${baseUrl}/api/dev/tools/shell.exec/invoke`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ agentId, workspaceId, input: { path: "package.json" } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentId,
      workspaceId,
      toolSlug: "shell.exec",
      observation: {
        status: "completed",
        commandActions: ["read"],
      },
    });
    expect(invokeDevTool).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      toolSlug: "shell.exec",
      request: {
        agentId,
        workspaceId,
        input: { path: "package.json" },
      },
    });
  });
});
