import type { Express } from "express";

import {
  LearningMemoryStatusResponseSchema,
  LearningProviderWarningTelemetryRequestSchema,
} from "../../../../contracts/learning-memory.js";
import { ApiRouteError, apiRoute, handleApiRouteError, requireRouteParam } from "../http.js";
import { logEvent } from "../logger.js";
import { workspaceHasEmbeddedMemories } from "../repositories/learning-memory.js";
import { getWorkspaceSettingsRow } from "../repositories/workspace-settings.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

async function requireWorkspaceAccess(userId: string, workspaceId: string) {
  try {
    await assertWorkspaceMembership(userId, workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) {
      throw new ApiRouteError(
        403,
        "workspace_forbidden",
        "Authenticated user is not authorized for the requested workspace",
      );
    }
    throw error;
  }
}

export function registerLearningMemoryRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/learning/memory-status",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const workspaceId = requireRouteParam(req, "workspaceId");
        await requireWorkspaceAccess(userId ?? "", workspaceId);
        const [settingsRow, hasEmbeddedMemories] = await Promise.all([
          getWorkspaceSettingsRow(workspaceId),
          workspaceHasEmbeddedMemories(workspaceId),
        ]);
        return res.status(200).json(
          LearningMemoryStatusResponseSchema.parse({
            workspaceId,
            learningEnabled: settingsRow?.learning_enabled ?? false,
            hasEmbeddedMemories,
          }),
        );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "learning_memory_status_failed",
          message: "Could not read learning memory status",
        }),
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/learning/provider-warning-events",
    apiRoute({
      requireAuth: true,
      bodySchema: LearningProviderWarningTelemetryRequestSchema,
      invalidBodyMessage: "Provider warning telemetry request is invalid",
      handler: async ({ req, res, body, userId }) => {
        const workspaceId = requireRouteParam(req, "workspaceId");
        if (body.workspaceId !== workspaceId) {
          throw new ApiRouteError(400, "workspace_id_mismatch", "Workspace id does not match the route");
        }
        await requireWorkspaceAccess(userId ?? "", workspaceId);

        logEvent({
          event: "learning_provider_change_warning",
          user_id: userId,
          workspace_id: workspaceId,
          agent_id: body.agentId,
          from_provider: body.fromProvider,
          to_provider: body.toProvider,
          action: body.action,
        });
        return res.status(202).json({ accepted: true });
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "learning_provider_warning_telemetry_failed",
          message: "Could not record provider warning telemetry",
        }),
    }),
  );
}
