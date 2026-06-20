import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listOperabilityRemediationView } from "../services/learning/operability-remediation.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { registerLearningRoutes } from "./learning.js";

vi.mock("../services/learning/operability-remediation.js", () => ({
  listOperabilityRemediationView: vi.fn(),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "11111111-1111-4111-8111-111111111111";

let baseUrl = "";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("learning routes", () => {
  let server: Server;

  beforeEach(async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-token";
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(listOperabilityRemediationView).mockResolvedValue({
      threshold: 2,
      recurringIssues: [],
      recentAutonomousGrants: [],
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerLearningRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("returns the operability remediation observability view", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/learning/operability-remediation?threshold=3&limit=10`,
      { headers: { authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(200);
    expect(assertWorkspaceMembership).toHaveBeenCalledWith(userId, workspaceId);
    expect(listOperabilityRemediationView).toHaveBeenCalledWith({
      workspaceId,
      threshold: 3,
      limit: 10,
    });
    await expect(response.json()).resolves.toEqual({
      threshold: 2,
      recurringIssues: [],
      recentAutonomousGrants: [],
    });
  });
});
