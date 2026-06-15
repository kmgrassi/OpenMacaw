import type { Express } from "express";
import { z } from "zod";

import { ScheduledTaskDeliverySchema } from "../../../../contracts/scheduled-tasks.js";
import { ApiRouteError, apiRoute, requireRouteParam } from "../http.js";
import { dispatchLearningScheduledTaskDelivery } from "../services/scheduled-tasks.js";
import { requireServiceRoleBearer } from "../services/service-role-auth.js";

const LearningJobKindSchema = z.enum(["learning_reflection", "learning_distillation"]);

const LearningJobDeliverySchema = ScheduledTaskDeliverySchema.refine(
  (delivery) => delivery.kind === "learning_reflection" || delivery.kind === "learning_distillation",
  "Expected a learning delivery kind",
);

const LearningJobRequestSchema = z
  .object({
    kind: LearningJobKindSchema,
    scheduled_task_id: z.string().uuid(),
    scheduled_task_run_id: z.string().uuid(),
    scheduled_run_id: z.string().trim().min(1),
    workspace_id: z.string().uuid(),
    agent_id: z.string().uuid().optional(),
    source_work_item_id: z.string().uuid().optional(),
    scheduled_for: z.string().datetime({ offset: true }).optional(),
    delivery: LearningJobDeliverySchema,
    trace_id: z.string().trim().min(1).optional(),
  })
  .strict();

export function registerLearningRoutes(app: Express) {
  app.post(
    "/api/learning/jobs/:kind",
    apiRoute({
      bodySchema: LearningJobRequestSchema,
      invalidBodyMessage: "Learning job request is invalid",
      handler: async ({ req, res, body }) => {
        requireServiceRoleBearer(req);
        const parsedKind = LearningJobKindSchema.safeParse(
          requireRouteParam(req, "kind", "Learning job kind is required"),
        );
        if (!parsedKind.success) {
          throw new ApiRouteError(400, "learning_job_kind_unknown", "Learning job kind is not supported");
        }

        const kind = parsedKind.data;
        if (kind !== body.kind || kind !== body.delivery.kind) {
          throw new ApiRouteError(400, "learning_job_kind_mismatch", "Learning job kind must match the delivery kind", {
            pathKind: kind,
            bodyKind: body.kind,
            deliveryKind: body.delivery.kind,
          });
        }

        const delivery = body.delivery;
        if (delivery.kind !== "learning_reflection" && delivery.kind !== "learning_distillation") {
          throw new ApiRouteError(400, "learning_job_kind_unknown", "Learning job kind is not supported");
        }

        const result = await dispatchLearningScheduledTaskDelivery({
          workspaceId: body.workspace_id,
          delivery,
        });
        return res.status(202).json(result);
      },
    }),
  );
}
