import type { Express } from "express";

import {
  GitHubAppInstallationCredentialRequestSchema,
  GitHubAppInstallationCredentialResponseSchema,
  GitHubAppPullRequestListResponseSchema,
  GitHubPullRequestStateSchema,
} from "../../../../contracts/resource-credentials.js";
import { ApiRouteError, apiRoute, requireQueryParam, requireRouteParam } from "../http.js";
import {
  listInstallationPullRequests,
  saveGitHubAppInstallationCredentialForWorkspace,
} from "../services/resource-credentials.js";
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

export function registerResourceCredentialRoutes(app: Express) {
  app.post(
    "/api/resource-credentials/github-app-installations",
    apiRoute({
      requireAuth: true,
      bodySchema: GitHubAppInstallationCredentialRequestSchema,
      invalidBodyMessage: "GitHub App installation credential details are required",
      handler: async ({ body, res, userId }) => {
        await requireWorkspaceAccess(userId, body.workspaceId);
        const credential = await saveGitHubAppInstallationCredentialForWorkspace({
          userId: userId ?? null,
          credential: body,
        });

        return res.status(200).json(
          GitHubAppInstallationCredentialResponseSchema.parse({
            credential,
          }),
        );
      },
    }),
  );

  app.get(
    "/api/resource-credentials/github-app-installations/:credentialId/pulls",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const credentialId = requireRouteParam(req, "credentialId");
        const workspaceId = requireQueryParam(req, "workspaceId");
        const repo = requireQueryParam(req, "repo");
        const stateParam = req.query.state;
        const state =
          typeof stateParam === "string" && stateParam.trim().length > 0
            ? GitHubPullRequestStateSchema.parse(stateParam.trim())
            : undefined;

        await requireWorkspaceAccess(userId, workspaceId);
        const result = await listInstallationPullRequests({
          workspaceId,
          credentialId,
          repo,
          state,
        });

        return res.status(200).json(GitHubAppPullRequestListResponseSchema.parse(result));
      },
    }),
  );
}
