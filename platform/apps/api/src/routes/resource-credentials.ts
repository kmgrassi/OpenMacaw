import type { Express } from "express";

import {
  GitHubAppInstallationCredentialRequestSchema,
  GitHubAppInstallationCredentialResponseSchema,
  GitHubAppPullRequestListResponseSchema,
  GitHubPullRequestStateSchema,
} from "../../../../contracts/resource-credentials.js";
import { ApiRouteError, apiRoute, requireQueryParam, requireRouteParam } from "../http.js";
import {
  GitHubAppCredentialError,
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

// Surface GitHub App configuration problems (not installed, repo not in the
// installation, missing permission, bad key) with their status + an actionable
// `remediation` so callers — and ultimately the agent — can tell the user
// exactly what to do.
function asGitHubAppRouteError(error: unknown): ApiRouteError {
  if (error instanceof GitHubAppCredentialError) {
    return new ApiRouteError(error.status, error.code, error.message, {
      ...(error.remediation ? { remediation: error.remediation } : {}),
    });
  }
  throw error;
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
        let state: ReturnType<typeof GitHubPullRequestStateSchema.parse> | undefined;
        if (typeof stateParam === "string" && stateParam.trim().length > 0) {
          const parsedState = GitHubPullRequestStateSchema.safeParse(stateParam.trim());
          if (!parsedState.success) {
            throw new ApiRouteError(400, "invalid_pull_request_state", "state must be one of: open, closed, all");
          }
          state = parsedState.data;
        }

        await requireWorkspaceAccess(userId, workspaceId);
        const result = await listInstallationPullRequests({
          workspaceId,
          credentialId,
          repo,
          state,
        }).catch((error) => {
          throw asGitHubAppRouteError(error);
        });

        return res.status(200).json(GitHubAppPullRequestListResponseSchema.parse(result));
      },
    }),
  );
}
