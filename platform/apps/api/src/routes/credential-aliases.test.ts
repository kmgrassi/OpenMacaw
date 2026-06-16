import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CredentialRepository from "../repositories/credentials.js";
import type * as StoredAgentCredentialStateService from "../services/stored-agent-credential-state.js";
import { getCredentialRowByIdForWorkspace, upsertCredentialAlias } from "../repositories/credentials.js";
import { listWorkspaceCredentialReferenceState } from "../services/stored-agent-credential-state.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerCredentialAliasRoutes } from "./credential-aliases.js";

vi.mock("../repositories/credentials.js", async () => {
  const actual = await vi.importActual<typeof CredentialRepository>("../repositories/credentials.js");
  return {
    ...actual,
    getCredentialRowByIdForWorkspace: vi.fn(),
    upsertCredentialAlias: vi.fn(),
  };
});

vi.mock("../services/stored-agent-credential-state.js", async () => {
  const actual = await vi.importActual<typeof StoredAgentCredentialStateService>(
    "../services/stored-agent-credential-state.js",
  );
  return {
    ...actual,
    listWorkspaceCredentialReferenceState: vi.fn(),
  };
});

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("credential alias routes", () => {
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getCredentialRowByIdForWorkspace).mockResolvedValue({
      id: "credential-row-1",
      provider: "openai",
    } as Awaited<ReturnType<typeof getCredentialRowByIdForWorkspace>>);
    vi.mocked(upsertCredentialAlias).mockResolvedValue({
      workspace_id: "workspace-1",
      alias: "primary_openai",
      credential_id: "credential-row-1",
      created_at: "2026-05-23T12:00:00.000Z",
    });
    vi.mocked(listWorkspaceCredentialReferenceState).mockResolvedValue({
      credentials: [],
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
    registerCredentialAliasRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
    server = undefined;
  });

  it("requires auth for alias list and upsert endpoints", async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/credential-aliases?workspaceId=workspace-1`),
      fetch(`${baseUrl}/api/credential-aliases/primary_openai`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          credentialId: "credential-row-1",
        }),
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "auth_required" },
      });
    }
  });

  it("rejects incomplete alias requests before repository writes", async () => {
    const response = await fetch(`${baseUrl}/api/credential-aliases/primary_openai`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "workspaceId, alias, and credentialId are required",
      },
    });
    expect(upsertCredentialAlias).not.toHaveBeenCalled();
  });

  it("uses the authenticated user context for alias reads and writes", async () => {
    vi.mocked(listWorkspaceCredentialReferenceState).mockResolvedValueOnce({
      credentials: [],
      aliases: [],
      credentialByRowId: new Map(),
    });

    const response = await fetch(`${baseUrl}/api/credential-aliases/primary_openai`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        credentialId: "credential-row-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      alias: {
        workspaceId: "workspace-1",
        alias: "primary_openai",
        credentialId: "credential-row-1",
        createdAt: "2026-05-23T12:00:00.000Z",
        updatedAt: "2026-05-23T12:00:00.000Z",
        credential: null,
      },
    });
    expect(assertWorkspaceMembership).toHaveBeenCalledWith("user-1", "workspace-1");
    expect(listWorkspaceCredentialReferenceState).toHaveBeenCalledWith("workspace-1", "user-1");
  });

  it("rejects alias writes outside the caller workspace membership", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/credential-aliases/primary_openai`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        credentialId: "credential-row-1",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(upsertCredentialAlias).not.toHaveBeenCalled();
  });
});
