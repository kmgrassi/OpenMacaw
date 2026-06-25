import {
  GitHubAppInstallationCredentialListResponseSchema,
  GitHubAppInstallationCredentialResponseSchema,
  GitHubAppPullRequestListResponseSchema,
  type GitHubAppInstallationCredential,
  type GitHubAppPullRequestListResponse,
  type GitHubPullRequestState,
} from "../../../../contracts/resource-credentials";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type {
  GitHubAppInstallationCredential,
  GitHubAppPullRequestListResponse,
  GitHubPullRequestState,
} from "../../../../contracts/resource-credentials";

export async function listGitHubAppInstallationCredentials(
  workspaceId: string,
): Promise<GitHubAppInstallationCredential[]> {
  const body = await apiFetch(
    `${ROUTES.githubAppInstallations}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: GitHubAppInstallationCredentialListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load GitHub App connections (${status})`,
    },
  );
  return body.credentials;
}

export async function saveGitHubAppInstallationCredential(input: {
  workspaceId: string;
  appId: string;
  installationId: string;
  privateKey: string;
  displayName?: string;
}): Promise<GitHubAppInstallationCredential> {
  const body = await apiFetch(ROUTES.githubAppInstallations, {
    method: "POST",
    body: {
      workspaceId: input.workspaceId,
      appId: input.appId,
      installationId: input.installationId,
      privateKey: input.privateKey,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
    schema: GitHubAppInstallationCredentialResponseSchema,
    defaultErrorMessage: (status) =>
      `Failed to save GitHub App connection (${status})`,
  });
  return body.credential;
}

export async function listGitHubAppPullRequests(input: {
  credentialId: string;
  workspaceId: string;
  repo: string;
  state?: GitHubPullRequestState;
}): Promise<GitHubAppPullRequestListResponse> {
  const params = new URLSearchParams({
    workspaceId: input.workspaceId,
    repo: input.repo,
    ...(input.state ? { state: input.state } : {}),
  });
  return apiFetch(
    `${ROUTES.githubAppInstallationPulls(input.credentialId)}?${params.toString()}`,
    {
      method: "GET",
      schema: GitHubAppPullRequestListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to list pull requests (${status})`,
    },
  );
}
