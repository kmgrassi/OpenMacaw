import type { Express } from "express";
import { z } from "zod";

import { SessionPolicyStateResponseSchema } from "../../../../contracts/session-policy.js";
import { apiRoute, ApiRouteError, requestWorkspaceId, requireRouteParam } from "../http.js";
import { getSessionPolicyState } from "../repositories/session-policy.js";

const WorkspaceIdSchema = z.string().uuid();
const SessionThreadIdSchema = z.string().uuid();

export function registerSessionPolicyRoutes(app: Express) {
  app.get(
    "/api/sessions/:sessionThreadId/policy-state",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const rawSessionThreadId = requireRouteParam(req, "sessionThreadId");
        const workspaceId = requestWorkspaceId(req);
        const parsedSessionThreadId = SessionThreadIdSchema.safeParse(rawSessionThreadId);
        const parsedWorkspaceId = WorkspaceIdSchema.safeParse(workspaceId);

        if (!parsedSessionThreadId.success) {
          throw new ApiRouteError(400, "invalid_request", "sessionThreadId must be a UUID");
        }

        if (!parsedWorkspaceId.success) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId query parameter is required");
        }

        const response = await getSessionPolicyState({
          userId,
          workspaceId: parsedWorkspaceId.data,
          sessionThreadId: parsedSessionThreadId.data,
        });

        return res.status(200).json(SessionPolicyStateResponseSchema.parse(response));
      },
    }),
  );
}
