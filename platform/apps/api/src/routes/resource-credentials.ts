import type { Express } from "express";

import {
  GitHubAppInstallationCredentialRequestSchema,
  GitHubAppInstallationCredentialResponseSchema,
} from "../../../../contracts/resource-credentials.js";
import { ApiRouteError, apiRoute } from "../http.js";
import { saveGitHubAppInstallationCredentialForWorkspace } from "../services/resource-credentials.js";
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
}
