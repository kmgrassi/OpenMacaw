import type { Express } from "express";

import {
  DevAgentTriggerMessageRequestSchema,
  DevAgentTriggerMessageResponseSchema,
} from "../../../../contracts/dev-agent-trigger-message.js";
import { apiRoute, requireRouteParam } from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { triggerDevAgentMessage } from "../services/dev-agent-trigger-message.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

export function registerDevAgentTriggerMessageRoutes(app: Express, launcherClient: LauncherClient) {
  app.post(
    "/api/dev/agents/:agentId/trigger-message",
    apiRoute({
      bodySchema: DevAgentTriggerMessageRequestSchema,
      invalidBodyMessage: "workspaceId and message are required",
      requireAuth: true,
      handler: async ({ req, res, body, accessToken, userId }) => {
        assertDevRouteAccess(req, {
          allowNonProduction: true,
          disabledCode: "dev_endpoint_disabled",
          disabledMessage: "Dev agent trigger endpoint is disabled",
        });

        const result = await triggerDevAgentMessage({
          accessToken,
          userId,
          agentId: requireRouteParam(req, "agentId"),
          workspaceId: body.workspaceId,
          message: body.message,
          sessionKey: body.sessionKey,
          waitMs: body.waitMs,
          launcherClient,
        });

        return res.status(202).json(DevAgentTriggerMessageResponseSchema.parse(result));
      },
    }),
  );
}
