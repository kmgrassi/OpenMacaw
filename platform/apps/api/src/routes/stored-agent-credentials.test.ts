import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  storedAgentActivateRoute,
  storedAgentCredentialLaunchRoute,
  storedAgentCredentialReferenceRoute,
  storedAgentCredentialsRoute,
} from "../../../../contracts/routes.js";
import type { LauncherClient } from "../services/launcher.js";
import { listSavedCredentialsForAgentFromSupabase } from "../services/saved-credentials.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { registerStoredAgentCredentialRoutes } from "./stored-agent-credentials.js";

vi.mock("../services/saved-credentials.js", async () => {
  const actual = await vi.importActual("../services/saved-credentials.js");
  return {
    ...actual,
    listSavedCredentialsForAgentFromSupabase: vi.fn(),
  };
});

vi.mock("../services/stored-agent-management.js", async () => {
  const actual = await vi.importActual("../services/stored-agent-management.js");
  return {
    ...actual,
    listStoredAgentsFromSupabase: vi.fn(),
  };
});

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("stored agent credential routes", () => {
  let server: Server | undefined;

  beforeEach(() => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([
      {
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "Agent",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        hasCredentials: false,
        isResolved: true,
        configurationStatus: null,
        runnerKind: null,
        planningDestination: null,
        localModelCoding: null,
        customTarget: null,
      },
    ]);
    vi.mocked(listSavedCredentialsForAgentFromSupabase).mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
    server = undefined;
  });

  it("requires auth for the stored-agent credential management endpoints", async () => {
    const app = express();
    app.use(express.json());
    registerStoredAgentCredentialRoutes(app, {} as LauncherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cases: Array<{
      path: string;
      method: string;
      body?: Record<string, unknown>;
    }> = [
      {
        path: `${storedAgentCredentialsRoute("agent-1")}?workspaceId=workspace-1`,
        method: "GET",
      },
      {
        path: `${storedAgentCredentialReferenceRoute("agent-1")}?workspaceId=workspace-1`,
        method: "GET",
      },
      {
        path: storedAgentCredentialReferenceRoute("agent-1"),
        method: "PUT",
        body: { workspaceId: "workspace-1", credentialRef: null },
      },
      {
        path: storedAgentCredentialsRoute("agent-1"),
        method: "POST",
        body: { workspaceId: "workspace-1", provider: "openai", apiKey: "sk-test" },
      },
      {
        path: storedAgentCredentialLaunchRoute("agent-1", "credential-1"),
        method: "POST",
        body: { workspaceId: "workspace-1", cwd: "/tmp/workspace" },
      },
      {
        path: storedAgentActivateRoute("agent-1"),
        method: "POST",
        body: { workspaceId: "workspace-1", cwd: "/tmp/workspace" },
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`${baseUrl}${testCase.path}`, {
        method: testCase.method,
        headers: testCase.body ? { "content-type": "application/json" } : undefined,
        body: testCase.body ? JSON.stringify(testCase.body) : undefined,
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "auth_required" },
      });
    }
  });

  it("validates launch requests before invoking the route logic", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "user-1";
      }
      next();
    });
    registerStoredAgentCredentialRoutes(app, {} as LauncherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}${storedAgentCredentialLaunchRoute("agent-1", "credential-1")}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "workspaceId and cwd are required",
      },
    });
  });

  it("rejects unauthorized stored-agent credential listing before reading credential metadata", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "user-1";
      }
      next();
    });
    registerStoredAgentCredentialRoutes(app, {} as LauncherClient);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}${storedAgentCredentialsRoute("agent-1")}?workspaceId=workspace-1`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(listSavedCredentialsForAgentFromSupabase).not.toHaveBeenCalled();
  });
});
