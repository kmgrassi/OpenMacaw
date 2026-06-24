import { describe, expect, it, vi } from "vitest";

import { getCredentialRowByIdForWorkspace } from "../repositories/credentials.js";
import { resolveSecretReference } from "../secrets.js";
import { listInstallationPullRequests, mintGitHubInstallationToken } from "./resource-credentials.js";

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(() => "signed-app-jwt"),
  },
}));

vi.mock("../repositories/credentials.js", () => ({
  getCredentialRowByIdForWorkspace: vi.fn(),
}));

vi.mock("../secrets.js", () => ({
  resolveSecretReference: vi.fn(),
}));

describe("GitHub App resource credentials", () => {
  it("mints an installation token from a stored GitHub App credential without exposing it via JSON", async () => {
    vi.mocked(getCredentialRowByIdForWorkspace).mockResolvedValue({
      id: "credential-1",
      agent_id: null,
      workspace_id: "workspace-1",
      user_id: "user-1",
      format: "github_app_installation",
      provider: "github",
      display_name: "GitHub App",
      key_value: {
        provider: "github",
        app_id: "123",
        installation_id: "456",
        api_base_url: "https://api.github.test",
        web_base_url: "https://github.test",
        private_key_secret_ref: "secret/github-app",
      },
      updated_at: "2026-05-19T00:00:00.000Z",
      validated_at: null,
      validation_state: "unknown",
    });
    vi.mocked(resolveSecretReference).mockResolvedValue("mock-github-app-private-key");
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          token: "ghs_secret_installation_token",
          expires_at: "2026-05-19T01:00:00Z",
          permissions: { contents: "read" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const token = await mintGitHubInstallationToken({
      workspaceId: "workspace-1",
      credentialId: "credential-1",
      fetchFn,
      nowMs: Date.parse("2026-05-19T00:00:00Z"),
    });

    expect(token.tokenValue).toBe("ghs_secret_installation_token");
    expect(JSON.stringify(token)).not.toContain("ghs_secret_installation_token");
    expect(JSON.stringify(token)).toContain("[redacted]");
    expect(resolveSecretReference).toHaveBeenCalledWith("secret/github-app", ["private_key", "GITHUB_APP_PRIVATE_KEY"]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.github.test/app/installations/456/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer signed-app-jwt",
        }),
      }),
    );
  });

  it("lists pull requests using a minted installation token", async () => {
    vi.mocked(getCredentialRowByIdForWorkspace).mockResolvedValue({
      id: "credential-1",
      agent_id: null,
      workspace_id: "workspace-1",
      user_id: "user-1",
      format: "github_app_installation",
      provider: "github",
      display_name: "GitHub App",
      key_value: {
        provider: "github",
        app_id: "123",
        installation_id: "456",
        api_base_url: "https://api.github.test",
        web_base_url: "https://github.test",
        private_key_secret_ref: "secret/github-app",
      },
      updated_at: "2026-05-19T00:00:00.000Z",
      validated_at: null,
      validation_state: "unknown",
    });
    vi.mocked(resolveSecretReference).mockResolvedValue("mock-github-app-private-key");

    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_secret_installation_token", expires_at: "2026-05-19T01:00:00Z" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 7,
            title: "Add Studio theme",
            state: "open",
            html_url: "https://github.test/kmgrassi/PopcornReady/pull/7",
            draft: false,
            updated_at: "2026-06-24T11:17:17Z",
            user: { login: "kmgrassi" },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await listInstallationPullRequests({
      workspaceId: "workspace-1",
      credentialId: "credential-1",
      repo: "kmgrassi/PopcornReady",
      fetchFn,
      nowMs: Date.parse("2026-05-19T00:00:00Z"),
    });

    expect(result).toEqual({
      repo: "kmgrassi/PopcornReady",
      state: "open",
      pullRequests: [
        {
          number: 7,
          title: "Add Studio theme",
          state: "open",
          url: "https://github.test/kmgrassi/PopcornReady/pull/7",
          author: "kmgrassi",
          draft: false,
          updatedAt: "2026-06-24T11:17:17Z",
        },
      ],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.github.test/repos/kmgrassi/PopcornReady/pulls?state=open&per_page=50",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer ghs_secret_installation_token" }),
      }),
    );
  });

  it("rejects a malformed repository slug before minting", async () => {
    await expect(
      listInstallationPullRequests({
        workspaceId: "workspace-1",
        credentialId: "credential-1",
        repo: "PopcornReady",
      }),
    ).rejects.toMatchObject({ code: "github_app_repo_invalid" });
  });
});
