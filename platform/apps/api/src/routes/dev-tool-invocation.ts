import type { Express } from "express";

import {
  DevToolInvocationRequestSchema,
  DevToolInvocationResponseSchema,
} from "../../../../contracts/dev-tool-invocation.js";
import { apiRoute, handleApiRouteError, requireRouteParam } from "../http.js";
import { invokeDevTool } from "../services/dev-tool-invocation.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

function handleDevToolError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "dev_tool_invocation_failed",
    message: "Dev tool invocation failed",
  });
}

export function registerDevToolInvocationRoutes(app: Express) {
  app.post(
    "/api/dev/tools/:toolSlug/invoke",
    apiRoute({
      requireAuth: true,
      bodySchema: DevToolInvocationRequestSchema,
      invalidBodyMessage: "dev tool invocation request is invalid",
      onError: handleDevToolError,
      async handler({ req, res, body, accessToken, userId }) {
        assertDevRouteAccess(req, { localhostOnly: true });
        const result = await invokeDevTool({
          accessToken,
          userId,
          toolSlug: requireRouteParam(req, "toolSlug"),
          request: body,
        });
        return res.status(200).json(DevToolInvocationResponseSchema.parse(result));
      },
    }),
  );
}
