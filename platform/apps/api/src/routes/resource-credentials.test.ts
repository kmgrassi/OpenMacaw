import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveGitHubAppInstallationCredentialForWorkspace } from "../services/resource-credentials.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerResourceCredentialRoutes } from "./resource-credentials.js";

vi.mock("../services/resource-credentials.js", () => ({
  saveGitHubAppInstallationCredentialForWorkspace: vi.fn(),
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

describe("resource credential routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(saveGitHubAppInstallationCredentialForWorkspace).mockResolvedValue({
      credentialId: "credential-1",
      workspaceId: "workspace-1",
      provider: "github",
      format: "github_app_installation",
      displayName: "GitHub App",
      appId: "123",
      installationId: "456",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      privateKeyStored: true,
      privateKeySecretRef: null,
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "user-1";
      }
      next();
    });
    registerResourceCredentialRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("stores GitHub App installation credentials and returns metadata only", async () => {
    const response = await fetch(`${baseUrl}/api/resource-credentials/github-app-installations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        appId: "123",
        installationId: "456",
        displayName: "GitHub App",
        privateKey: "mock-github-app-private-key",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("mock-github-app-private-key");
    expect(body).toEqual({
      credential: expect.objectContaining({
        credentialId: "credential-1",
        provider: "github",
        format: "github_app_installation",
        privateKeyStored: true,
        privateKeySecretRef: null,
      }),
    });
    expect(saveGitHubAppInstallationCredentialForWorkspace).toHaveBeenCalledWith({
      userId: "user-1",
      credential: expect.objectContaining({
        workspaceId: "workspace-1",
        appId: "123",
        installationId: "456",
      }),
    });
  });

  it("requires exactly one private key source", async () => {
    const response = await fetch(`${baseUrl}/api/resource-credentials/github-app-installations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        appId: "123",
        installationId: "456",
      }),
    });

    expect(response.status).toBe(400);
    expect(saveGitHubAppInstallationCredentialForWorkspace).not.toHaveBeenCalled();
  });

  it("rejects GitHub App credential writes outside the caller workspace membership", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/resource-credentials/github-app-installations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        appId: "123",
        installationId: "456",
        privateKey: "mock-github-app-private-key",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(saveGitHubAppInstallationCredentialForWorkspace).not.toHaveBeenCalled();
  });

  it("rejects unsupported custom GitHub base URLs", async () => {
    const response = await fetch(`${baseUrl}/api/resource-credentials/github-app-installations`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        appId: "123",
        installationId: "456",
        apiBaseUrl: "https://attacker.example",
        privateKey: "mock-github-app-private-key",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
      },
    });
    expect(saveGitHubAppInstallationCredentialForWorkspace).not.toHaveBeenCalled();
  });
});
