import type { Express, Request, Response } from "express";

import type { ApiConfig } from "../config.js";
import { ApiRouteError, handleApiRouteError, handleProxyError, mapLauncherError } from "../http.js";
import { isLoopbackRequest } from "./dev-route-guard.js";
import type { LauncherClient } from "../services/launcher.js";
import { requestAgentId, resolveRuntimeTargetForAgent } from "../services/runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "../services/upstream.js";

function baseHealthPayload(ok: boolean) {
  return {
    ok,
    service: "symphony-express-server",
  };
}

function publicHealthPayload(launcherOk: boolean) {
  return {
    ...baseHealthPayload(launcherOk),
    launcher: { ok: launcherOk },
  };
}

async function buildHealthPayload(
  req: Request,
  config: ApiConfig,
  launcherClient: LauncherClient,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  const launcherResult = await launcherClient.getHealth().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

  const launcherHealth = launcherResult.ok ? launcherResult.value : mapLauncherError(launcherResult.error).body;
  const launcherOk = launcherResult.ok && launcherResult.value.ok;

  const agentId = requestAgentId(req);
  if (!agentId) {
    return {
      status: launcherOk ? 200 : 503,
      body: publicHealthPayload(launcherOk),
    };
  }

  if (!isLoopbackRequest(req)) {
    throw new ApiRouteError(
      403,
      "health_scope_forbidden",
      "Scoped runtime health is only available from loopback addresses",
    );
  }

  let target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
  let runtimeRequest = createUpstreamRequester(target.baseUrl, config.orchestratorRequestTimeoutMs);
  let orchestratorHealth: UpstreamResponse;

  try {
    orchestratorHealth = await runtimeRequest("/api/v1/health", { method: "GET" });
  } catch {
    await launcherRequest(`/agents/${encodeURIComponent(agentId)}`, { method: "GET" }).catch(() => undefined);
    target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
    runtimeRequest = createUpstreamRequester(target.baseUrl, config.orchestratorRequestTimeoutMs);
    orchestratorHealth = await runtimeRequest("/api/v1/health", { method: "GET" });
  }

  const orchestratorOk =
    orchestratorHealth.status >= 200 &&
    orchestratorHealth.status < 300 &&
    Boolean((orchestratorHealth.body as { ok?: boolean })?.ok);

  return {
    status: launcherOk && orchestratorOk ? 200 : 503,
    body: {
      ...baseHealthPayload(launcherOk && orchestratorOk),
      launcherBaseUrl: config.launcherBaseUrl,
      launcherHealth: launcherHealth,
      runtimeTarget: {
        agentId: target.agentId,
        host: target.host,
        port: target.port,
        instanceId: target.instanceId,
      },
      orchestratorHealth: orchestratorHealth.body,
    },
  };
}

export function registerHealthRoutes(
  app: Express,
  config: ApiConfig,
  launcherClient: LauncherClient,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  app.get("/health", async (req: Request, res: Response) => {
    try {
      const payload = await buildHealthPayload(req, config, launcherClient, launcherRequest);
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      if (error instanceof ApiRouteError) {
        return handleApiRouteError(res, error, {
          status: 500,
          code: "health_failed",
          message: "Health check failed",
        });
      }
      return handleProxyError(res, error);
    }
  });

  app.get("/livez", (_req: Request, res: Response) => {
    return res.status(200).json({
      ok: true,
      service: "symphony-express-server",
    });
  });

  app.get("/api/v1/health", async (req: Request, res: Response) => {
    try {
      const payload = await buildHealthPayload(req, config, launcherClient, launcherRequest);
      return res.status(payload.status).json(payload.body);
    } catch (error) {
      if (error instanceof ApiRouteError) {
        return handleApiRouteError(res, error, {
          status: 500,
          code: "health_failed",
          message: "Health check failed",
        });
      }
      return handleProxyError(res, error);
    }
  });
}
