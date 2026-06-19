import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRouteError } from "../http.js";
import { clearModelCatalogCacheForTests } from "../services/model-catalog.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { assertWorkspaceAdminAccess } from "../services/workspace-access.js";
import { saveModelProviderCredentialForWorkspaceInSupabase } from "../services/saved-credentials.js";
import { registerModelCatalogRoutes } from "./models.js";

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

vi.mock("../services/workspace-access.js", () => ({
  assertWorkspaceAdminAccess: vi.fn(),
}));

vi.mock("../services/saved-credentials.js", () => ({
  saveModelProviderCredentialForWorkspaceInSupabase: vi.fn(),
}));

const realFetch = globalThis.fetch;

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("model catalog routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    clearModelCatalogCacheForTests();
    delete process.env.OPENAI_API_KEY;
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(assertWorkspaceAdminAccess).mockResolvedValue(undefined);
    vi.mocked(saveModelProviderCredentialForWorkspaceInSupabase).mockResolvedValue(null as never);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "11111111-1111-4111-8111-111111111111";
      }
      next();
    });
    registerModelCatalogRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    clearModelCatalogCacheForTests();
    await closeServer(server);
  });

  it("requires bearer auth", async () => {
    const response = await fetch(`${baseUrl}/api/models`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_required",
        message: "Supabase access token is required",
      },
    });
  });

  it("requires workspace context for provider connection state", async () => {
    const response = await fetch(`${baseUrl}/api/model-providers`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "workspaceId is required",
      },
    });
  });

  it("rejects provider credential writes from non-members", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValueOnce(new Error("not authorized for workspace"));

    const response = await fetch(`${baseUrl}/api/model-providers/openai/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        apiKey: "sk-test",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
    expect(saveModelProviderCredentialForWorkspaceInSupabase).not.toHaveBeenCalled();
  });

  it("rejects provider credential writes from non-admin members", async () => {
    vi.mocked(assertWorkspaceAdminAccess).mockRejectedValueOnce(
      new ApiRouteError(
        403,
        "workspace_admin_required",
        "Authenticated user must be a workspace admin to manage workspace credentials",
      ),
    );

    const response = await fetch(`${baseUrl}/api/model-providers/openai/credentials`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        apiKey: "sk-test",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_admin_required" },
    });
    expect(saveModelProviderCredentialForWorkspaceInSupabase).not.toHaveBeenCalled();
  });

  it("returns provider models when a provider credential is configured", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
      return Response.json({
        data: [{ id: "gpt-test-model", context_window: 128000 }],
      });
    });

    const response = await fetch(`${baseUrl}/api/models`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai/gpt-test-model",
          provider: "openai",
          source: "provider",
          contextWindow: 128000,
        }),
      ]),
    );
    expect(body.fetchedAt).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to curated models when provider discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
    });

    const response = await fetch(`${baseUrl}/api/models`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai/gpt-5.2",
          source: "curated",
        }),
      ]),
    );
    expect(body.errors).toEqual([
      expect.objectContaining({
        provider: "openai",
        code: "provider_unavailable",
      }),
    ]);
  });

  it("does not expose globally configured env provider models for workspace-scoped catalog requests", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      return Response.json({
        data: [{ id: "gpt-env-only-model" }],
      });
    });

    const response = await fetch(`${baseUrl}/api/models?workspaceId=workspace-1`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toEqual([]);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "credential_lookup_failed",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves cached provider models without refetching", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      return Response.json({
        data: [{ id: "gpt-cache-model" }],
      });
    });

    await fetch(`${baseUrl}/api/models`, {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await fetch(`${baseUrl}/api/models`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai/gpt-cache-model",
          source: "cache",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
