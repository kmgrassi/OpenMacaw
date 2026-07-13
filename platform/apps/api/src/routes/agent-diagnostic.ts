import type { Express } from "express";

import { DiagnosticRouteTemplates } from "../../../../contracts/routes.js";
import { ApiRouteError, apiRoute, requireRouteParam } from "../http.js";
import { loadAgentDiagnostic } from "../services/diagnostics/agent-diagnostic.js";
import { loadWorkspaceAgentDiagnostic } from "../services/diagnostics/workspace-agent-diagnostic.js";
import type { UpstreamResponse } from "../services/upstream.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

type UpstreamRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

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

export function registerAgentDiagnosticRoutes(app: Express, runtimeRequest: UpstreamRequest) {
  app.get(
    DiagnosticRouteTemplates.workspaceAgents,
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }
        const workspaceId = requireRouteParam(req, "workspaceId");
        await requireWorkspaceAccess(userId, workspaceId);

        const diagnostic = await loadWorkspaceAgentDiagnostic(workspaceId, runtimeRequest);
        return res.status(200).json(diagnostic);
      },
    }),
  );

  app.get(
    DiagnosticRouteTemplates.agent,
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        const workspaceIdParam = (typeof req.query.workspaceId === "string" && req.query.workspaceId.trim()) || "";
        if (!workspaceIdParam) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        await requireWorkspaceAccess(userId, workspaceIdParam);

        const workItemIdParam = typeof req.query.workItemId === "string" ? req.query.workItemId.trim() : "";
        const diagnostic = await loadAgentDiagnostic({
          agentId: requireRouteParam(req, "agentId"),
          workspaceId: workspaceIdParam,
          workItemId: workItemIdParam || null,
        });

        return res.status(200).json(diagnostic);
      },
    }),
  );
}
