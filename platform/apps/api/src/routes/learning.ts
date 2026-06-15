import type { Express } from "express";
import { z } from "zod";

import { apiRoute, requireRouteParam } from "../http.js";
import { listOperabilityRemediationView } from "../services/learning/operability-remediation.js";
import { reflectRunToMemories } from "../services/learning/reflector.js";
import { requireServiceRoleBearer } from "../services/service-role-auth.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

const LearningReflectionJobRequestSchema = z.object({
  sourceTaskId: z.string().trim().min(1).nullable().optional(),
});

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

  app.post(
    "/api/learning/jobs/:sourceRunId/reflection",
    apiRoute({
      bodySchema: LearningReflectionJobRequestSchema,
      invalidBodyMessage: "Learning reflection job request is invalid",
      handler: async ({ req, res, body }) => {
        requireServiceRoleBearer(req);
        const sourceRunId = requireRouteParam(req, "sourceRunId", "sourceRunId is required");
        const result = await reflectRunToMemories({
          sourceRunId,
          sourceTaskId: body.sourceTaskId ?? null,
        });
        return res.status(202).json({ reflection: result });
      },
    }),
  );
}
