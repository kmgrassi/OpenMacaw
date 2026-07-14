import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCredentialRowByIdForWorkspace } from "../repositories/credentials.js";
import { markCredentialInvalid } from "../services/credential-validation.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerCredentialValidationRoutes } from "./credential-validation.js";

vi.mock("../repositories/credentials.js", () => ({
  getCredentialRowByIdForWorkspace: vi.fn(),
}));

vi.mock("../services/credential-validation.js", () => ({
  markCredentialInvalid: vi.fn(),
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

describe("credential validation routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getCredentialRowByIdForWorkspace).mockResolvedValue({
      id: "credential-1",
      workspace_id: "workspace-1",
    } as never);
    vi.mocked(markCredentialInvalid).mockResolvedValue({
      id: "credential-1",
      validated_at: "2026-07-14T12:00:00.000Z",
    } as never);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "user-1";
      }
      next();
    });
    registerCredentialValidationRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("requires workspace membership before revoking a credential", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/credentials/credential-1/revocation`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        credentialId: "credential-1",
        workspaceId: "workspace-1",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(getCredentialRowByIdForWorkspace).not.toHaveBeenCalled();
    expect(markCredentialInvalid).not.toHaveBeenCalled();
  });

  it("revokes a credential for an authorized workspace member", async () => {
    const response = await fetch(`${baseUrl}/api/credentials/credential-1/revocation`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        credentialId: "credential-1",
        workspaceId: "workspace-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentialId: "credential-1",
      validationState: "invalid",
      validatedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(assertWorkspaceMembership).toHaveBeenCalledWith("user-1", "workspace-1");
    expect(getCredentialRowByIdForWorkspace).toHaveBeenCalledWith("credential-1", "workspace-1");
    expect(markCredentialInvalid).toHaveBeenCalledWith({
      credentialId: "credential-1",
      workspaceId: "workspace-1",
    });
  });
});
