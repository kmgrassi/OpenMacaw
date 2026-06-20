import type { Express } from "express";

import { SkillListQuerySchema, SkillResponseSchema, SkillUpdateRequestSchema } from "../../../../contracts/skills.js";
import { ApiRouteError, apiRoute, handleApiRouteError } from "../http.js";
import { listSkillsForWorkspace, updateSkillForWorkspace } from "../repositories/skills.js";
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

export function registerSkillRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/skills",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        if (!workspaceId) throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        if (!userId) throw new ApiRouteError(401, "auth_required", "Supabase access token is required");

        const parsed = SkillListQuerySchema.safeParse({
          agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
          status: typeof req.query.status === "string" ? req.query.status : undefined,
          limit: typeof req.query.limit === "string" ? req.query.limit : undefined,
        });
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid skill query", parsed.error.flatten());
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await listSkillsForWorkspace(workspaceId, parsed.data));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "skills_read_failed",
          message: "Could not read skills",
        }),
    }),
  );

  app.patch(
    "/api/workspaces/:workspaceId/skills/:skillId",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        const skillId = req.params.skillId?.trim() ?? "";
        if (!workspaceId) throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        if (!skillId) throw new ApiRouteError(400, "invalid_request", "skillId is required");
        if (!userId) throw new ApiRouteError(401, "auth_required", "Supabase access token is required");

        const parsed = SkillUpdateRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid skill update", parsed.error.flatten());
        }

        await requireWorkspaceAccess(userId, workspaceId);
        const skill = await updateSkillForWorkspace({
          workspaceId,
          skillId,
          patch: parsed.data,
        });
        return res.status(200).json(SkillResponseSchema.parse({ skill }));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "skill_update_failed",
          message: "Could not update skill",
        }),
    }),
  );
}
