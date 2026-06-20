import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exchangeOpenAICodexDeviceCode,
  pollOpenAICodexDeviceCode,
  requestOpenAICodexDeviceCode,
  resolveCodexAuthIdentity,
} from "../services/oauth/openai-codex.js";
import {
  saveOpenAICodexAccessTokenCredentialForAgent,
  saveOpenAICodexOAuthCredentialForAgent,
  type ResolvedSavedCredential,
} from "../services/saved-credentials.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { syncCredentialIntoRoutingRuleForAgent } from "../services/stored-agent-routing.js";
import { registerCredentialOAuthRoutes } from "./credentials-oauth.js";

vi.mock("../services/oauth/openai-codex.js", () => ({
  OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS: 10 * 60 * 1000,
  requestOpenAICodexDeviceCode: vi.fn(),
  pollOpenAICodexDeviceCode: vi.fn(),
  exchangeOpenAICodexDeviceCode: vi.fn(),
  resolveCodexAuthIdentity: vi.fn(),
}));

vi.mock("../services/saved-credentials.js", () => ({
  saveOpenAICodexAccessTokenCredentialForAgent: vi.fn(),
  saveOpenAICodexOAuthCredentialForAgent: vi.fn(),
}));

vi.mock("../services/stored-agent-management.js", () => ({
  listStoredAgentsFromSupabase: vi.fn(),
}));

vi.mock("../services/stored-agent-routing.js", () => ({
  syncCredentialIntoRoutingRuleForAgent: vi.fn(),
}));

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function savedCredential(overrides: Partial<ResolvedSavedCredential> = {}): ResolvedSavedCredential {
  return {
    id: "credential-row-1:OPENAI_CODEX",
    credentialRowId: "credential-row-1",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "openai_codex",
    label: "ChatGPT OAuth",
    envVar: "OPENAI_API_KEY",
    updatedAt: "2026-06-05T00:00:00.000Z",
    validationState: "ok",
    validatedAt: "2026-06-05T00:00:00.000Z",
    launchableKind: "codex",
    secretValue: "",
    secretRef: null,
    aliases: [],
    endpoint: null,
    apiVersion: null,
    oauth: null,
    ...overrides,
  };
}

describe("credential OAuth routes", () => {
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
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
    vi.mocked(requestOpenAICodexDeviceCode).mockResolvedValue({
      deviceAuthId: "device-auth-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://example.com/verify",
      expiresInMs: 600000,
      intervalMs: 1000,
    });
    vi.mocked(pollOpenAICodexDeviceCode).mockResolvedValue({
      status: "authorized",
      authorizationCode: "auth-code",
      codeVerifier: "code-verifier",
    });
    vi.mocked(exchangeOpenAICodexDeviceCode).mockResolvedValue({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_900_000_000_000,
    });
    vi.mocked(resolveCodexAuthIdentity).mockReturnValue({
      email: "user@example.com",
      accountId: "acct_123",
      chatgptPlanType: "plus",
    });
    vi.mocked(saveOpenAICodexOAuthCredentialForAgent).mockResolvedValue(savedCredential());
    vi.mocked(saveOpenAICodexAccessTokenCredentialForAgent).mockResolvedValue(savedCredential());
    vi.mocked(syncCredentialIntoRoutingRuleForAgent).mockResolvedValue(undefined as never);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const authorization = req.header("authorization");
      if (authorization === "Bearer owner-token") {
        req.userId = "user-1";
      } else if (authorization === "Bearer other-token") {
        req.userId = "user-2";
      }
      next();
    });
    registerCredentialOAuthRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
    server = undefined;
  });

  it("rejects OAuth start when the target agent is outside the caller scope", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/api/credentials/openai-codex/oauth/start`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(requestOpenAICodexDeviceCode).not.toHaveBeenCalled();
  });

  it("binds OAuth sessions to the user that started them", async () => {
    const startResponse = await fetch(`${baseUrl}/api/credentials/openai-codex/oauth/start`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    });

    expect(startResponse.status).toBe(200);
    const startBody = (await startResponse.json()) as { sessionId: string };

    const pollResponse = await fetch(`${baseUrl}/api/credentials/openai-codex/oauth/poll`, {
      method: "POST",
      headers: {
        authorization: "Bearer other-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: startBody.sessionId,
      }),
    });

    expect(pollResponse.status).toBe(404);
    await expect(pollResponse.json()).resolves.toMatchObject({
      error: { code: "oauth_session_not_found" },
    });
    expect(saveOpenAICodexOAuthCredentialForAgent).not.toHaveBeenCalled();
  });
});
