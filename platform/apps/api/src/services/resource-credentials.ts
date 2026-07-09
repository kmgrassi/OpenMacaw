import { inspect } from "node:util";

import jwt from "jsonwebtoken";
import { z } from "zod";

import { asRecord } from "../../../../contracts/agent-helpers.js";
import {
  GitHubAppInstallationCredentialSchema,
  GitHubAppPullRequestListResponseSchema,
  type GitHubAppInstallationCredential,
  type GitHubAppInstallationCredentialRequest,
  type GitHubAppPullRequestListResponse,
  type GitHubPullRequestState,
} from "../../../../contracts/resource-credentials.js";
import type { Json } from "@kmgrassi/supabase-schema";
import {
  createWorkspaceResourceCredential,
  getCredentialRowByIdForWorkspace,
  listWorkspaceModelProviderCredentialRows,
  type CredentialProjection,
  type CredentialRow,
} from "../repositories/credentials.js";
import { resolveSecretReference } from "../secrets.js";
import { withServiceLogging } from "./service-logging.js";

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_WEB_BASE_URL = "https://github.com";
const GITHUB_APP_JWT_TTL_SECONDS = 9 * 60;

type JsonObject = { [key: string]: Json | undefined };

const GitHubInstallationTokenResponseSchema = z.object({
  token: z.string().trim().min(1),
  expires_at: z.string().trim().min(1),
  permissions: z.record(z.string(), z.string()).optional().default({}),
  repository_selection: z.string().optional(),
});

export class GitHubAppCredentialError extends Error {
  code: string;
  // HTTP status to surface, and a user/agent-facing next step. `remediation`
  // is written so an agent can relay it to the user verbatim (e.g. "the App
  // isn't installed — install it here").
  status: number;
  remediation: string | null;

  constructor(code: string, message: string, options?: { status?: number; remediation?: string | null }) {
    super(message);
    this.name = "GitHubAppCredentialError";
    this.code = code;
    this.status = options?.status ?? 502;
    this.remediation = options?.remediation ?? null;
  }
}

function installationsSettingsUrl(webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, "")}/settings/installations`;
}

export class MintedGitHubInstallationToken {
  readonly credentialId: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly expiresAt: string;
  readonly repositorySelection: string | null;
  readonly permissions: Record<string, string>;
  #token: string;

  constructor(input: {
    credentialId: string;
    workspaceId: string;
    installationId: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    token: string;
    expiresAt: string;
    repositorySelection: string | null;
    permissions: Record<string, string>;
  }) {
    this.credentialId = input.credentialId;
    this.workspaceId = input.workspaceId;
    this.installationId = input.installationId;
    this.apiBaseUrl = input.apiBaseUrl;
    this.webBaseUrl = input.webBaseUrl;
    this.#token = input.token;
    this.expiresAt = input.expiresAt;
    this.repositorySelection = input.repositorySelection;
    this.permissions = input.permissions;
  }

  get tokenValue() {
    return this.#token;
  }

  toJSON() {
    return {
      credentialId: this.credentialId,
      workspaceId: this.workspaceId,
      installationId: this.installationId,
      apiBaseUrl: this.apiBaseUrl,
      webBaseUrl: this.webBaseUrl,
      token: "[redacted]",
      expiresAt: this.expiresAt,
      repositorySelection: this.repositorySelection,
      permissions: this.permissions,
    };
  }

  [inspectCustom](_depth: number, options: Parameters<typeof inspect>[1]) {
    return `MintedGitHubInstallationToken ${inspect(this.toJSON(), options)}`;
  }
}

function asJsonObject(value: Json | null): JsonObject | null {
  return asRecord(value) as JsonObject | null;
}

function normalizeId(value: string | number): string {
  return String(value).trim();
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const normalized = trimmed.replace(/\/+$/, "");
  const parsed = new URL(normalized);
  const allowed = new URL(fallback);
  const isAllowed =
    parsed.protocol === allowed.protocol &&
    parsed.host === allowed.host &&
    (parsed.pathname === "/" || parsed.pathname === "") &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.username &&
    !parsed.password;
  if (!isAllowed) {
    throw new GitHubAppCredentialError(
      "github_app_base_url_unsupported",
      `GitHub App credentials must use ${fallback}`,
      {
        status: 400,
        remediation:
          "Only the public GitHub endpoints are supported today. GitHub Enterprise support needs a broader trusted-host design before we can enable custom domains safely.",
      },
    );
  }
  return normalized;
}

function readString(raw: JsonObject, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mapGitHubAppCredentialRow(row: CredentialRow | CredentialProjection): GitHubAppInstallationCredential {
  const raw = asJsonObject(row.key_value);
  if (!raw || row.provider !== "github" || row.format !== "github_app_installation") {
    throw new GitHubAppCredentialError("github_app_credential_invalid", "Credential is not a GitHub App installation");
  }

  const appId = readString(raw, "app_id");
  const installationId = readString(raw, "installation_id");
  const apiBaseUrl = normalizeBaseUrl(readString(raw, "api_base_url") ?? undefined, GITHUB_API_BASE_URL);
  const webBaseUrl = normalizeBaseUrl(readString(raw, "web_base_url") ?? undefined, GITHUB_WEB_BASE_URL);
  if (!appId || !installationId) {
    throw new GitHubAppCredentialError("github_app_credential_invalid", "GitHub App credential is missing IDs");
  }

  return GitHubAppInstallationCredentialSchema.parse({
    credentialId: row.id,
    workspaceId: row.workspace_id,
    provider: "github",
    format: "github_app_installation",
    displayName: row.display_name,
    appId,
    installationId,
    apiBaseUrl,
    webBaseUrl,
    privateKeyStored: Boolean(readString(raw, "private_key")),
    privateKeySecretRef: readString(raw, "private_key_secret_ref"),
    updatedAt: row.updated_at,
  });
}

function buildGitHubAppCredentialKeyValue(input: GitHubAppInstallationCredentialRequest): JsonObject {
  return {
    provider: "github",
    app_id: normalizeId(input.appId),
    installation_id: normalizeId(input.installationId),
    api_base_url: normalizeBaseUrl(input.apiBaseUrl, GITHUB_API_BASE_URL),
    web_base_url: normalizeBaseUrl(input.webBaseUrl, GITHUB_WEB_BASE_URL),
    ...(input.privateKey ? { private_key: input.privateKey.trim() } : {}),
    ...(input.privateKeySecretRef ? { private_key_secret_ref: input.privateKeySecretRef.trim() } : {}),
  };
}

export async function saveGitHubAppInstallationCredentialForWorkspace(input: {
  userId: string | null;
  credential: GitHubAppInstallationCredentialRequest;
}): Promise<GitHubAppInstallationCredential> {
  const displayName =
    input.credential.displayName?.trim() || `GitHub App installation ${normalizeId(input.credential.installationId)}`;
  const row = await createWorkspaceResourceCredential({
    workspaceId: input.credential.workspaceId,
    userId: input.userId,
    provider: "github",
    format: "github_app_installation",
    displayName,
    keyValue: buildGitHubAppCredentialKeyValue(input.credential),
    validationState: "unknown",
    validatedAt: null,
  });
  if (!row) {
    throw new GitHubAppCredentialError("github_app_credential_not_saved", "Credential persistence returned no row");
  }

  return mapGitHubAppCredentialRow(row);
}

// Lists the workspace's stored GitHub App installation credentials (no secrets).
// The general /api/credentials listing only surfaces model-provider API keys,
// so the Connections UI reads these separately.
export async function listGitHubAppInstallationCredentialsForWorkspace(
  workspaceId: string,
): Promise<GitHubAppInstallationCredential[]> {
  const rows = await listWorkspaceModelProviderCredentialRows(workspaceId);
  return rows
    .filter((row) => row.provider === "github" && row.format === "github_app_installation")
    .map((row) => mapGitHubAppCredentialRow(row));
}

async function resolveGitHubPrivateKey(raw: JsonObject): Promise<string> {
  const inline = readString(raw, "private_key");
  if (inline) return inline;

  const secretRef = readString(raw, "private_key_secret_ref");
  if (!secretRef) {
    throw new GitHubAppCredentialError("github_app_private_key_missing", "GitHub App private key is missing");
  }

  const resolved = await resolveSecretReference(secretRef, ["private_key", "GITHUB_APP_PRIVATE_KEY"]);
  if (!resolved) {
    throw new GitHubAppCredentialError(
      "github_app_private_key_unresolvable",
      "GitHub App private key secret could not be resolved",
    );
  }
  return resolved;
}

function createGitHubAppJwt(input: { appId: string; privateKey: string; nowMs?: number }) {
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  return jwt.sign(
    {
      iat: nowSeconds - 60,
      exp: nowSeconds + GITHUB_APP_JWT_TTL_SECONDS,
      iss: input.appId,
    },
    input.privateKey,
    { algorithm: "RS256" },
  );
}

export async function mintGitHubInstallationToken(input: {
  workspaceId: string;
  credentialId: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
}): Promise<MintedGitHubInstallationToken> {
  return withServiceLogging(
    {
      operation: "resource_credentials.github_app.mint_installation_token",
      inputSummary: {
        workspace_id: input.workspaceId,
        credential_id: input.credentialId,
      },
    },
    () => mintGitHubInstallationTokenImpl(input),
  );
}

async function mintGitHubInstallationTokenImpl(input: {
  workspaceId: string;
  credentialId: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
}): Promise<MintedGitHubInstallationToken> {
  const row = await getCredentialRowByIdForWorkspace(input.credentialId, input.workspaceId);
  if (!row) {
    throw new GitHubAppCredentialError(
      "github_app_credential_not_found",
      "No GitHub App credential is configured for this workspace",
      {
        status: 404,
        remediation: "Connect a GitHub App: create/install it on GitHub, then save its credential for this workspace.",
      },
    );
  }

  const credential = mapGitHubAppCredentialRow(row);
  const raw = asJsonObject(row.key_value);
  if (!raw) {
    throw new GitHubAppCredentialError("github_app_credential_invalid", "Credential payload is invalid");
  }

  const appJwt = createGitHubAppJwt({
    appId: credential.appId,
    privateKey: await resolveGitHubPrivateKey(raw),
    nowMs: input.nowMs,
  });
  const response = await (input.fetchFn ?? fetch)(
    `${credential.apiBaseUrl}/app/installations/${credential.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    if (response.status === 404) {
      // The App exists/authenticated (the JWT was accepted) but the
      // installation id no longer resolves — the App was uninstalled or the
      // installation was removed.
      throw new GitHubAppCredentialError(
        "github_app_not_installed",
        `The GitHub App installation ${credential.installationId} was not found (the App may have been uninstalled)`,
        {
          status: 422,
          remediation: `Install the GitHub App on the target account/repository, then try again: ${installationsSettingsUrl(credential.webBaseUrl)}`,
        },
      );
    }
    if (response.status === 401) {
      throw new GitHubAppCredentialError(
        "github_app_unauthorized",
        "GitHub rejected the App credentials (App ID or private key is invalid)",
        {
          status: 502,
          remediation:
            "Verify the stored GitHub App ID and private key; regenerate the private key on GitHub if needed.",
        },
      );
    }
    throw new GitHubAppCredentialError(
      "github_app_token_rejected",
      `GitHub rejected installation token minting with status ${response.status}`,
    );
  }

  const parsed = GitHubInstallationTokenResponseSchema.parse(await response.json());
  return new MintedGitHubInstallationToken({
    credentialId: credential.credentialId,
    workspaceId: credential.workspaceId,
    installationId: credential.installationId,
    apiBaseUrl: credential.apiBaseUrl,
    webBaseUrl: credential.webBaseUrl,
    token: parsed.token,
    expiresAt: parsed.expires_at,
    repositorySelection: parsed.repository_selection ?? null,
    permissions: parsed.permissions,
  });
}

const REPO_SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const GITHUB_PULLS_PER_PAGE = 100;
const GITHUB_PULLS_MAX_PAGES = 20;

const GitHubPullRequestApiEntrySchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  draft: z.boolean().optional().default(false),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullish(),
});
const GitHubPullRequestApiListSchema = z.array(GitHubPullRequestApiEntrySchema);

// Lists pull requests for `owner/repo` using a freshly minted installation
// token. This is the first consumer of the GitHub App credential and doubles
// as the proof-of-life that a cloud (AWS) process can authenticate to the
// installed App and call the GitHub API.
export async function listInstallationPullRequests(input: {
  workspaceId: string;
  credentialId: string;
  repo: string;
  state?: GitHubPullRequestState;
  fetchFn?: typeof fetch;
  nowMs?: number;
}): Promise<GitHubAppPullRequestListResponse> {
  return withServiceLogging(
    {
      operation: "resource_credentials.github_app.list_pull_requests",
      inputSummary: {
        workspace_id: input.workspaceId,
        credential_id: input.credentialId,
        repo: input.repo,
        state: input.state ?? "open",
      },
    },
    () => listInstallationPullRequestsImpl(input),
  );
}

async function listInstallationPullRequestsImpl(input: {
  workspaceId: string;
  credentialId: string;
  repo: string;
  state?: GitHubPullRequestState;
  fetchFn?: typeof fetch;
  nowMs?: number;
}): Promise<GitHubAppPullRequestListResponse> {
  const repo = input.repo.trim();
  if (!REPO_SLUG_PATTERN.test(repo)) {
    throw new GitHubAppCredentialError("github_app_repo_invalid", "Repository must be in owner/name form", {
      status: 400,
      remediation: "Provide the repository as owner/name, e.g. kmgrassi/PopcornReady.",
    });
  }
  const state: GitHubPullRequestState = input.state ?? "open";
  const fetchFn = input.fetchFn ?? fetch;

  const minted = await mintGitHubInstallationToken({
    workspaceId: input.workspaceId,
    credentialId: input.credentialId,
    fetchFn,
    nowMs: input.nowMs,
  });

  // Follow pagination to exhaustion so a cloud agent inspecting repo state
  // never silently misses PRs beyond the first page. PER_PAGE is GitHub's max;
  // MAX_PAGES is a runaway backstop far above any realistic open-PR count.
  const entries: Array<z.infer<typeof GitHubPullRequestApiEntrySchema>> = [];
  for (let page = 1; page <= GITHUB_PULLS_MAX_PAGES; page += 1) {
    const response = await fetchFn(
      `${minted.apiBaseUrl}/repos/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${GITHUB_PULLS_PER_PAGE}&page=${page}`,
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${minted.tokenValue}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw pullRequestListError(response.status, repo, minted.webBaseUrl);
    }

    const pageEntries = GitHubPullRequestApiListSchema.parse(await response.json());
    entries.push(...pageEntries);
    if (pageEntries.length < GITHUB_PULLS_PER_PAGE) break;
  }

  return GitHubAppPullRequestListResponseSchema.parse({
    repo,
    state,
    pullRequests: entries.map((entry) => ({
      number: entry.number,
      title: entry.title,
      state: entry.state,
      url: entry.html_url,
      author: entry.user?.login ?? null,
      draft: entry.draft,
      updatedAt: entry.updated_at,
    })),
  });
}

function pullRequestListError(status: number, repo: string, webBaseUrl: string): GitHubAppCredentialError {
  if (status === 404) {
    // The installation token minted (App is installed) but the repo isn't
    // visible to it — not selected for the installation, or wrong name.
    return new GitHubAppCredentialError(
      "github_app_repo_not_accessible",
      `The GitHub App cannot access ${repo} (it is not part of the installation, or the name is wrong)`,
      {
        status: 422,
        remediation: `Add ${repo} to the GitHub App installation (or verify the owner/name): ${installationsSettingsUrl(webBaseUrl)}`,
      },
    );
  }
  if (status === 403) {
    return new GitHubAppCredentialError(
      "github_app_forbidden",
      `The GitHub App lacks permission to read pull requests on ${repo}`,
      {
        status: 403,
        remediation:
          "Grant the GitHub App the 'Pull requests: Read' repository permission, then re-approve the installation.",
      },
    );
  }
  return new GitHubAppCredentialError(
    "github_app_pull_request_list_failed",
    `GitHub rejected pull request listing with status ${status}`,
  );
}

export const resourceCredentialInternalsForTests = {
  createGitHubAppJwt,
  mapGitHubAppCredentialRow,
};
