import type { Express, Request } from "express";

import { z } from "zod";

import {
  ManagerAgentConfigRequestSchema,
  ManagerAgentConfigResponseSchema,
  ManagerRuntimeStatusResponseSchema,
} from "../../../../contracts/manager-agent.js";
import { AgentRouteTemplates, ManagerRouteTemplates } from "../../../../contracts/routes.js";
import { apiRoute, ApiRouteError, handleApiRouteError, requireRouteParam } from "../http.js";
import { getManagerRuntimeStatus } from "../services/manager-runtime-status.js";
import { getManagerAgentConfig, updateManagerAgentConfig } from "../services/manager-agent-config.js";
import type { UpstreamResponse } from "../services/upstream.js";

const ManagerStatusQuerySchema = z.object({
  workspace_id: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
});

type RuntimeRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

function workspaceIdFromRequest(req: Request): string {
  const parsed = ManagerStatusQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiRouteError(400, "invalid_request", "workspace_id must be a valid workspace UUID", {
      issues: parsed.error.issues,
    });
  }

  const workspaceId = parsed.data.workspace_id ?? parsed.data.workspaceId;
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspace_id is required");
  }

  return workspaceId;
}

function handleManagerStatusError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "manager_status_failed",
    message: "Could not load manager runtime status",
  });
}

export function registerManagerAgentRoutes(app: Express, runtimeRequest: RuntimeRequest) {
  app.get(
    AgentRouteTemplates.schedulerConfig,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, accessToken }) {
        if (!accessToken) return;
        const config = await getManagerAgentConfig({
          accessToken,
          workspaceId: workspaceIdFromRequest(req),
          agentId: requireRouteParam(req, "agentId"),
        });
        return res.status(200).json(ManagerAgentConfigResponseSchema.parse(config));
      },
    }),
  );

  app.put(
    AgentRouteTemplates.schedulerConfig,
    apiRoute({
      requireAuth: true,
      bodySchema: ManagerAgentConfigRequestSchema,
      invalidBodyMessage: "Manager agent config is invalid",
      async handler({ req, res, body, accessToken, userId }) {
        if (!accessToken || !userId) return;
        const config = await updateManagerAgentConfig({
          accessToken,
          userId,
          workspaceId: workspaceIdFromRequest(req),
          agentId: requireRouteParam(req, "agentId"),
          request: body,
        });
        return res.status(200).json(ManagerAgentConfigResponseSchema.parse(config));
      },
    }),
  );

  app.get(
    ManagerRouteTemplates.runtimeStatus,
    apiRoute({
      requireAuth: true,
      onError: handleManagerStatusError,
      async handler({ req, res, userId }) {
        if (!userId) return;
        const workspaceId = workspaceIdFromRequest(req);
        const manager = await getManagerRuntimeStatus({
          workspaceId,
          userId,
          runtimeRequest,
        });

        return res.status(200).json(ManagerRuntimeStatusResponseSchema.parse({ manager }));
      },
    }),
  );
}
