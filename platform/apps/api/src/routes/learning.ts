import type { Express } from "express";

import { apiRoute, requireRouteParam } from "../http.js";
import { listOperabilityRemediationView } from "../services/learning/operability-remediation.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

export function registerLearningRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/learning/operability-remediation",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const workspaceId = requireRouteParam(req, "workspaceId", "workspaceId is required");
        await assertWorkspaceMembership(userId, workspaceId);
        const threshold =
          typeof req.query.threshold === "string" ? Number.parseInt(req.query.threshold, 10) : undefined;
        const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
        return res.status(200).json(
          await listOperabilityRemediationView({
            workspaceId,
            threshold:
              typeof threshold === "number" && Number.isInteger(threshold) && threshold > 0 ? threshold : undefined,
            limit: typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined,
          }),
        );
      },
    }),
  );
}
