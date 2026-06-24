import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

import { registerLocalDirectoryRoutes } from "./local-directory.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("../services/stored-agent-management.js", () => ({
  listStoredAgentsFromSupabase: vi.fn(),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("authorization") === "Bearer test-token") {
      req.userId = userId;
    }
    next();
  });
  registerLocalDirectoryRoutes(app);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("local directory routes", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const started = await createTestServer();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await closeServer(server);
  });

  it("rejects workspace path reads for agents outside the caller's scope", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient({ agent: [] }) as never);
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/api/local/agents/${agentId}/workspace-path`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
  });

  it("rejects workspace path updates before validating arbitrary filesystem paths for unauthorized agents", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient({ agent: [] }) as never);
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([]);

    const response = await fetch(`${baseUrl}/api/local/agents/${agentId}/workspace-path`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "/definitely/not/a/real/directory" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_not_found" },
    });
  });

  it("updates an authorized agent workspace path with a workspace-scoped service-role write", async () => {
    const db = {
      agent: [
        {
          id: agentId,
          workspace_id: workspaceId,
          tool_policy: {},
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(db) as never);
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValueOnce([
      {
        id: agentId,
        workspaceId,
        name: "Coding agent",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        hasCredentials: true,
        isResolved: true,
        configurationStatus: null,
        runnerKind: null,
        planningDestination: null,
        localModelCoding: null,
        customTarget: null,
      },
    ]);

    const response = await fetch(`${baseUrl}/api/local/agents/${agentId}/workspace-path`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: process.cwd() }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentId,
      workspacePath: process.cwd(),
      actor: userId,
    });
    expect(db.agent[0]?.tool_policy).toMatchObject({
      executionTarget: {
        kind: "local_helper",
        workspace_root: process.cwd(),
      },
    });
  });
});
