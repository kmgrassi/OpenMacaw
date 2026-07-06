import express from "express";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../config.js";
import { registerHealthRoutes } from "./health.js";

const config: ApiConfig = {
  port: 0,
  host: "127.0.0.1",
  orchestratorBaseUrl: "http://127.0.0.1:4000",
  orchestratorWsUrl: "ws://127.0.0.1:4000",
  launcherBaseUrl: "http://127.0.0.1:4100",
  orchestratorRequestTimeoutMs: 500,
  launcherRequestTimeoutMs: 500,
  corsOrigins: "http://127.0.0.1:5173",
  wsUpgradePath: "/ws",
  wsConnectTimeoutMs: 500,
  workItemDefaultWorkspaceId: null,
  githubWebhookSecret: "github-secret",
  githubRepoWorkspaceMap: {},
  linearWebhookSecret: "linear-secret",
  linearApiKey: null,
  linearProjectWorkspaceMap: {},
  linearTeamWorkspaceMap: {},
};

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("health routes", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("blocks scoped runtime health details from non-loopback addresses", async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", {
        configurable: true,
        value: "203.0.113.10",
      });
      next();
    });

    const launcherClient = {
      getHealth: vi.fn().mockResolvedValue({ ok: true }),
    };
    const launcherRequest = vi.fn();

    registerHealthRoutes(app, config, launcherClient as never, launcherRequest);

    server = createServer(app);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/health?agentId=agent-1`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "health_scope_forbidden",
      },
    });
    expect(launcherRequest).not.toHaveBeenCalled();
  });
});
