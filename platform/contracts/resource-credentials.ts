import { z } from "zod";

export const ResourceCredentialProviderSchema = z.enum(["github"]);

export const GitHubAppInstallationCredentialRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    appId: z.union([z.string().trim().min(1), z.number().int().positive()]),
    installationId: z.union([
      z.string().trim().min(1),
      z.number().int().positive(),
    ]),
    displayName: z.string().trim().min(1).max(120).optional(),
    apiBaseUrl: z.string().trim().url().optional(),
    webBaseUrl: z.string().trim().url().optional(),
    privateKey: z.string().trim().min(1).optional(),
    privateKeySecretRef: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => Boolean(value.privateKey) !== Boolean(value.privateKeySecretRef),
    {
      message: "Exactly one of privateKey or privateKeySecretRef is required",
      path: ["privateKey"],
    },
  );

export const GitHubAppInstallationCredentialSchema = z.object({
  credentialId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  provider: z.literal("github"),
  format: z.literal("github_app_installation"),
  displayName: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  apiBaseUrl: z.string().trim().url(),
  webBaseUrl: z.string().trim().url(),
  privateKeyStored: z.boolean(),
  privateKeySecretRef: z.string().trim().min(1).nullable(),
  updatedAt: z.string().trim().min(1),
});

export const GitHubAppInstallationCredentialResponseSchema = z.object({
  credential: GitHubAppInstallationCredentialSchema,
});

export const GitHubAppInstallationCredentialListResponseSchema = z.object({
  credentials: z.array(GitHubAppInstallationCredentialSchema),
});

export const GitHubPullRequestStateSchema = z.enum(["open", "closed", "all"]);

export const GitHubPullRequestSummarySchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string().trim().min(1),
  url: z.string().trim().url(),
  author: z.string().trim().min(1).nullable(),
  draft: z.boolean(),
  updatedAt: z.string().trim().min(1),
});

export const GitHubAppPullRequestListResponseSchema = z.object({
  repo: z.string().trim().min(1),
  state: GitHubPullRequestStateSchema,
  pullRequests: z.array(GitHubPullRequestSummarySchema),
});

export type ResourceCredentialProvider = z.infer<
  typeof ResourceCredentialProviderSchema
>;
export type GitHubAppInstallationCredentialRequest = z.infer<
  typeof GitHubAppInstallationCredentialRequestSchema
>;
export type GitHubAppInstallationCredential = z.infer<
  typeof GitHubAppInstallationCredentialSchema
>;
export type GitHubAppInstallationCredentialResponse = z.infer<
  typeof GitHubAppInstallationCredentialResponseSchema
>;
export type GitHubAppInstallationCredentialListResponse = z.infer<
  typeof GitHubAppInstallationCredentialListResponseSchema
>;
export type GitHubPullRequestState = z.infer<
  typeof GitHubPullRequestStateSchema
>;
export type GitHubPullRequestSummary = z.infer<
  typeof GitHubPullRequestSummarySchema
>;
export type GitHubAppPullRequestListResponse = z.infer<
  typeof GitHubAppPullRequestListResponseSchema
>;
