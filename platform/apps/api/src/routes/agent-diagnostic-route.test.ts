import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgentDiagnostic } from "../services/diagnostics/agent-diagnostic.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerAgentDiagnosticRoutes } from "./agent-diagnostic.js";

vi.mock("../services/diagnostics/agent-diagnostic.js", () => ({
  loadAgentDiagnostic: vi.fn(),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const managerAgentId = "55555555-5555-4555-8555-555555555555";

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("agent diagnostic route — auth", () => {
  let server: Server;
  let baseUrl = "";
  let runtimeRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(loadAgentDiagnostic).mockResolvedValue({
      timestamp: "2026-05-20T00:00:00.000Z",
      agentId,
      workspaceId,
      agent: {
        found: true,
        name: "Coding Agent",
        type: "coding",
        model_settings: null,
      },
    } as never);
    runtimeRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        workspace_id: workspaceId,
        agents: [
          {
            agent_id: agentId,
            runner_kind: "codex",
            status: "ready",
          },
          {
            agent_id: managerAgentId,
            runner_kind: "llm_tool_runner",
            status: "not_ready",
            reason: "credential_missing",
            details: { credential: "missing" },
          },
        ],
      },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerAgentDiagnosticRoutes(app, runtimeRequest);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("rejects unauthenticated requests with 401 auth_required", async () => {
    const response = await fetch(`${baseUrl}/api/diagnostic/agents/${agentId}?workspaceId=${workspaceId}`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(loadAgentDiagnostic).not.toHaveBeenCalled();
    expect(assertWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("rejects authenticated requests without workspaceId with 400", async () => {
    const response = await fetch(`${baseUrl}/api/diagnostic/agents/${agentId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(assertWorkspaceMembership).not.toHaveBeenCalled();
    expect(loadAgentDiagnostic).not.toHaveBeenCalled();
  });

  it("rejects non-members of the workspace with 403 workspace_forbidden", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    const response = await fetch(`${baseUrl}/api/diagnostic/agents/${agentId}?workspaceId=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(loadAgentDiagnostic).not.toHaveBeenCalled();
  });

  it("returns the diagnostic for a workspace member", async () => {
    const response = await fetch(`${baseUrl}/api/diagnostic/agents/${agentId}?workspaceId=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
    expect(loadAgentDiagnostic).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      workItemId: null,
    });
  });

  it("returns 404 when the agent is not in the authorized workspace", async () => {
    vi.mocked(loadAgentDiagnostic).mockResolvedValueOnce({
      timestamp: "2026-05-20T00:00:00.000Z",
      agentId,
      workspaceId,
      agent: {
        found: false,
        name: null,
        type: null,
        model_settings: null,
      },
    } as never);

    const response = await fetch(`${baseUrl}/api/diagnostic/agents/${agentId}?workspaceId=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
  });

  it("forwards a workItemId query param when present", async () => {
    const workItemId = "44444444-4444-4444-8444-444444444444";
    const response = await fetch(
      `${baseUrl}/api/diagnostic/agents/${agentId}?workspaceId=${workspaceId}&workItemId=${workItemId}`,
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(200);
    expect(loadAgentDiagnostic).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      workItemId,
    });
  });

  it("returns workspace agent diagnostics from the runtime batch endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/diagnostic/workspace/${workspaceId}/agents`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
    expect(runtimeRequest).toHaveBeenCalledWith(`/api/v1/diagnostic/workspace/${workspaceId}/agents`, {
      method: "GET",
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspaceId,
      agents: [
        {
          agentId,
          runnerKind: "codex",
          status: "ok",
        },
        {
          agentId: managerAgentId,
          runnerKind: "llm_tool_runner",
          status: "error",
          errorCode: "credential_missing",
          errorDetails: { credential: "missing" },
        },
      ],
    });
  });

  it("returns a structured unreachable payload when the runtime batch endpoint is down", async () => {
    runtimeRequest.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:4000"));

    const response = await fetch(`${baseUrl}/api/diagnostic/workspace/${workspaceId}/agents`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: "runtime_unreachable",
      details: "connect ECONNREFUSED 127.0.0.1:4000",
    });
  });

  it("returns a structured unreachable payload when the runtime batch endpoint returns 404", async () => {
    runtimeRequest.mockResolvedValueOnce({
      status: 404,
      headers: {},
      body: { error: "not_found" },
    });

    const response = await fetch(`${baseUrl}/api/diagnostic/workspace/${workspaceId}/agents`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: "runtime_unreachable",
      details: "Runtime diagnostic endpoint returned 404",
    });
  });

  it("returns a structured unreachable payload when the runtime batch endpoint returns an invalid body", async () => {
    runtimeRequest.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html>",
    });

    const response = await fetch(`${baseUrl}/api/diagnostic/workspace/${workspaceId}/agents`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      reason: "runtime_unreachable",
      details: "Runtime diagnostic endpoint returned an invalid response",
    });
  });
});
