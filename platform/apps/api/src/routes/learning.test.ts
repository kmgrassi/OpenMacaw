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

vi.mock("../services/learning/reflector.js", () => ({
  reflectRunToMemories: vi.fn(),
}));

vi.mock("../services/work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("learning routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
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
