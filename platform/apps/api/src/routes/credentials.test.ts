import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertCredentialAlias } from "../repositories/credentials.js";
import {
  saveInlineCredentialForAgentInSupabase,
  saveModelProviderCredentialForWorkspaceInSupabase,
  type ResolvedSavedCredential,
} from "../services/saved-credentials.js";
import { listWorkspaceCredentialReferenceState } from "../services/stored-agent-credential-state.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { syncCredentialIntoRoutingRuleForAgent } from "../services/stored-agent-routing.js";
import { validateModelProviderCredential } from "../services/model-catalog.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerCredentialRoutes } from "./credentials.js";

vi.mock("../repositories/credentials.js", () => ({
  upsertCredentialAlias: vi.fn(),
}));

vi.mock("../services/saved-credentials.js", () => ({
  saveInlineCredentialForAgentInSupabase: vi.fn(),
  saveModelProviderCredentialForWorkspaceInSupabase: vi.fn(),
}));

vi.mock("../services/stored-agent-credential-state.js", () => ({
  listWorkspaceCredentialReferenceState: vi.fn(),
}));

vi.mock("../services/stored-agent-management.js", () => ({
  listStoredAgentsFromSupabase: vi.fn(),
}));

vi.mock("../services/stored-agent-routing.js", () => ({
  syncCredentialIntoRoutingRuleForAgent: vi.fn(),
}));

vi.mock("../services/model-catalog.js", () => ({
  validateModelProviderCredential: vi.fn(),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function savedCredential(overrides: Partial<ResolvedSavedCredential> = {}): ResolvedSavedCredential {
  return {
    id: "credential-row-1:OPENAI_API_KEY",
    credentialRowId: "credential-row-1",
    agentId: null,
    workspaceId: "workspace-1",
    provider: "openai",
    label: "OpenAI API key ••••test",
    envVar: "OPENAI_API_KEY",
    updatedAt: "2026-05-13T00:00:00.000Z",
    validationState: "unknown",
    validatedAt: null,
    launchableKind: "codex" as const,
    secretValue: "sk-test",
    secretRef: null,
    aliases: ["OPENAI_API_KEY"],
    endpoint: null,
    apiVersion: null,
    oauth: null,
    ...overrides,
  };
}

describe("credential routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(validateModelProviderCredential).mockResolvedValue({
      ok: true,
      modelCount: 1,
      checkedAt: "2026-05-13T00:00:00.000Z",
      error: null,
    });
    vi.mocked(upsertCredentialAlias).mockResolvedValue(null);
    vi.mocked(syncCredentialIntoRoutingRuleForAgent).mockImplementation(
      async () => undefined as unknown as Awaited<ReturnType<typeof syncCredentialIntoRoutingRuleForAgent>>,
    );
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
    vi.mocked(saveModelProviderCredentialForWorkspaceInSupabase).mockResolvedValue(savedCredential());
    vi.mocked(saveInlineCredentialForAgentInSupabase).mockResolvedValue(
      savedCredential({
        agentId: "agent-1",
        id: "credential-row-2:OPENAI_API_KEY",
        credentialRowId: "credential-row-2",
      }),
    );
    vi.mocked(listWorkspaceCredentialReferenceState).mockResolvedValue({
      credentials: [savedCredential()],
      aliases: [],
      credentialByRowId: new Map(),
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "user-1";
      }
      next();
    });
    registerCredentialRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("saves workspace API-key credentials through the unified endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        key: { format: "api_key", provider: "openai", secret: "sk-test" },
        alias: "default-openai",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credential: expect.objectContaining({
        credentialRowId: "credential-row-1",
        provider: "openai",
      }),
    });
    expect(validateModelProviderCredential).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: "sk-test",
      endpoint: undefined,
      apiVersion: undefined,
    });
    expect(saveModelProviderCredentialForWorkspaceInSupabase).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "openai",
      apiKey: "sk-test",
      endpoint: undefined,
      apiVersion: undefined,
      validationState: "ok",
      validatedAt: "2026-05-13T00:00:00.000Z",
    });
    expect(upsertCredentialAlias).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      alias: "default-openai",
      credentialId: "credential-row-1",
    });
  });

  it("rejects agent credential writes when the target agent is outside the caller scope", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "agent", workspaceId: "workspace-1", agentId: "agent-1" },
        key: { format: "api_key", provider: "openai", secret: "sk-test" },
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(saveInlineCredentialForAgentInSupabase).not.toHaveBeenCalled();
  });

  it("lists workspace credentials through the unified endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/credentials?workspaceId=workspace-1`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        expect.objectContaining({
          credentialRowId: "credential-row-1",
          provider: "openai",
        }),
      ],
    });
    expect(assertWorkspaceMembership).toHaveBeenCalledWith("user-1", "workspace-1");
    expect(listWorkspaceCredentialReferenceState).toHaveBeenCalledWith("workspace-1", "user-1");
  });

  it("rejects workspace credential reads outside the caller workspace membership", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/credentials?workspaceId=workspace-1`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(listWorkspaceCredentialReferenceState).not.toHaveBeenCalled();
  });

  it("rejects workspace credential writes outside the caller workspace membership", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        key: { format: "api_key", provider: "openai", secret: "sk-test" },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(saveModelProviderCredentialForWorkspaceInSupabase).not.toHaveBeenCalled();
  });

  it("saves tracker workspace credentials without model-provider validation", async () => {
    vi.mocked(saveModelProviderCredentialForWorkspaceInSupabase).mockResolvedValueOnce(
      savedCredential({
        id: "credential-row-linear:LINEAR_API_KEY",
        credentialRowId: "credential-row-linear",
        provider: "linear",
        label: "Linear API key ••••test",
        envVar: "LINEAR_API_KEY",
        launchableKind: null,
      }),
    );

    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        key: { format: "api_key", provider: "linear", secret: "lin-test" },
        alias: "default-linear",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credential: expect.objectContaining({
        credentialRowId: "credential-row-linear",
        provider: "linear",
        envVar: "LINEAR_API_KEY",
        launchableKind: null,
      }),
    });
    expect(validateModelProviderCredential).not.toHaveBeenCalled();
    expect(saveModelProviderCredentialForWorkspaceInSupabase).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "linear",
      apiKey: "lin-test",
      endpoint: undefined,
      apiVersion: undefined,
      validationState: "unknown",
      validatedAt: null,
    });
    expect(upsertCredentialAlias).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      alias: "default-linear",
      credentialId: "credential-row-linear",
    });
  });

  it("looks up agent scope with the caller access token before syncing agent credentials", async () => {
    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "agent", workspaceId: "workspace-1", agentId: "agent-1" },
        key: { format: "api_key", provider: "openai", secret: "sk-test" },
      }),
    });

    expect(response.status).toBe(200);
    expect(listStoredAgentsFromSupabase).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId: "user-1",
    });
  });

  it("rejects non-model agent-scoped API-key credentials", async () => {
    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "agent", workspaceId: "workspace-1", agentId: "agent-1" },
        key: { format: "api_key", provider: "github", secret: "ghp-test" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unsupported_credential_provider",
      },
    });
    expect(validateModelProviderCredential).not.toHaveBeenCalled();
    expect(saveInlineCredentialForAgentInSupabase).not.toHaveBeenCalled();
    expect(syncCredentialIntoRoutingRuleForAgent).not.toHaveBeenCalled();
  });

  it("saves agent-scoped API-key credentials and syncs the routing rule", async () => {
    const response = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: { kind: "agent", workspaceId: "workspace-1", agentId: "agent-1" },
        key: { format: "api_key", provider: "openai", secret: "sk-test" },
      }),
    });

    expect(response.status).toBe(200);
    expect(validateModelProviderCredential).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: "sk-test",
      endpoint: undefined,
      apiVersion: undefined,
    });
    expect(saveInlineCredentialForAgentInSupabase).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      provider: "openai",
      apiKey: "sk-test",
      validationState: "ok",
      validatedAt: "2026-05-13T00:00:00.000Z",
    });
    expect(syncCredentialIntoRoutingRuleForAgent).toHaveBeenCalledWith({
      agent: {
        id: "agent-1",
        workspaceId: "workspace-1",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
      },
      credentialId: "credential-row-2",
      provider: "openai",
    });
  });
});
