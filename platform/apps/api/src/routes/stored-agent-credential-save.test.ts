import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storedAgentCredentialsRoute } from "../../../../contracts/routes.js";
import type { LauncherClient } from "../services/launcher.js";
import { validateCredentialRecord } from "../services/credential-validation.js";
import { saveInlineCredentialForAgentInSupabase } from "../services/saved-credentials.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { registerStoredAgentCredentialRoutes } from "./stored-agent-credentials.js";

vi.mock("../services/credential-validation.js", () => ({
  validateCredentialRecord: vi.fn(),
}));

vi.mock("../services/saved-credentials.js", async () => {
  const actual = await vi.importActual("../services/saved-credentials.js");
  return {
    ...actual,
    saveInlineCredentialForAgentInSupabase: vi.fn(),
  };
});

vi.mock("../services/stored-agent-management.js", async () => {
  const actual = await vi.importActual("../services/stored-agent-management.js");
  return {
    ...actual,
    listStoredAgentsFromSupabase: vi.fn(),
  };
});

vi.mock("../services/execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn().mockResolvedValue({
    missing: [],
    agent: null,
  }),
}));

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("stored agent credential save route", () => {
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(validateCredentialRecord).mockResolvedValue({
      ok: true,
      provider: "openai",
      model: null,
      checkedAt: "2026-06-05T00:00:00.000Z",
      status: null,
      code: null,
      message: "ok",
    });
    vi.mocked(saveInlineCredentialForAgentInSupabase).mockResolvedValue({
      id: "credential-row-1:OPENAI_API_KEY",
      credentialRowId: "credential-row-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      provider: "openai",
      label: "OpenAI API key",
      envVar: "OPENAI_API_KEY",
      updatedAt: "2026-06-05T00:00:00.000Z",
      validationState: "ok",
      validatedAt: "2026-06-05T00:00:00.000Z",
      launchableKind: "codex",
      secretValue: "sk-test",
      secretRef: null,
      aliases: [],
      endpoint: null,
      apiVersion: null,
      oauth: null,
    });
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([
      {
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "Agent",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        hasCredentials: false,
        isResolved: true,
        configurationStatus: null,
        runnerKind: null,
        planningDestination: null,
        localModelCoding: null,
        customTarget: null,
      },
    ]);

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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
    server = undefined;
  });

  it("rejects unauthorized agent credential saves before persisting the secret", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}${storedAgentCredentialsRoute("agent-1")}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        provider: "openai",
        apiKey: "sk-test",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(saveInlineCredentialForAgentInSupabase).not.toHaveBeenCalled();
    expect(validateCredentialRecord).not.toHaveBeenCalled();
  });
});
