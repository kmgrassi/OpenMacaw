import type { Express } from "express";

import { registerAgentControlRoutes } from "./agent-control.js";
import { registerAgentLiveIoRoutes } from "./agent-live-io.js";
import { registerAgentProxyRoutes } from "./agent-proxy.js";
import type { LauncherClient } from "../services/launcher.js";
import type { UpstreamResponse } from "../services/upstream.js";

export function registerProxyRoutes(
  app: Express,
  launcherClient: LauncherClient,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  requestTimeoutMs: number,
) {
  registerAgentControlRoutes(app, launcherClient);
  registerAgentLiveIoRoutes(app, launcherRequest, requestTimeoutMs);
  registerAgentProxyRoutes(app, launcherRequest, requestTimeoutMs);
}
