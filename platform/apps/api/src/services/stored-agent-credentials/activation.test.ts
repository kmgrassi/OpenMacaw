import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedSavedCredential } from "../saved-credentials.js";
import { createStoredCredentialLaunch, validateLaunchableStoredCredential } from "./activation.js";
import { validateOpenAiCredential } from "../../provider-validation.js";
import { resolveStoredCredentialSecret } from "../stored-credentials.js";

vi.mock("../../provider-validation.js", () => ({
  validateOpenAiCredential: vi.fn(),
}));

vi.mock("../credential-validation.js", () => ({
  markCredentialInvalid: vi.fn(),
  persistCredentialValidation: vi.fn(),
}));

vi.mock("../stored-credentials.js", () => ({
  resolveStoredCredentialSecret: vi.fn(),
}));

const oauthCredential: ResolvedSavedCredential = {
  id: "cred-oauth:OPENAI_API_KEY",
  credentialRowId: "cred-oauth",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  provider: "openai_codex",
  label: "ChatGPT (user@example.com)",
  envVar: "OPENAI_API_KEY",
  updatedAt: "2026-05-28T00:00:00.000Z",
  validationState: "ok",
  validatedAt: "2026-05-28T00:00:00.000Z",
  launchableKind: "codex",
  secretValue: "stale-access-token",
  secretRef: null,
  aliases: ["access_token"],
  endpoint: null,
  apiVersion: null,
  oauth: {
    refreshToken: "refresh-token",
    expiresAt: Date.now() - 1_000,
  },
};

describe("stored agent credential activation", () => {
  beforeEach(() => {
    vi.mocked(resolveStoredCredentialSecret).mockReset();
    vi.mocked(validateOpenAiCredential).mockReset();
  });

  it("validates a Codex OAuth credential through the resolved OAuth access token", async () => {
    vi.mocked(resolveStoredCredentialSecret).mockResolvedValue("fresh-oauth-access-token");
    vi.mocked(validateOpenAiCredential).mockResolvedValue({
      ok: true,
      provider: "openai",
      model: "gpt-5.3-codex",
      checkedAt: "2026-05-28T00:00:01.000Z",
      status: 200,
      code: null,
      message: "Validated access to model gpt-5.3-codex.",
    });

    const result = await validateLaunchableStoredCredential({
      credential: oauthCredential,
      workspaceId: "workspace-1",
      model: "openai_codex/gpt-5.3-codex",
    });

    expect(resolveStoredCredentialSecret).toHaveBeenCalledWith(oauthCredential);
    expect(validateOpenAiCredential).toHaveBeenCalledWith("fresh-oauth-access-token", "openai_codex/gpt-5.3-codex");
    expect(result.secretValue).toBe("fresh-oauth-access-token");
    expect(result.credential).toMatchObject({
      provider: "openai_codex",
      launchableKind: "codex",
    });
    expect(JSON.stringify(result.credential)).not.toContain("fresh-oauth-access-token");
    expect(JSON.stringify(result.credential)).not.toContain("refresh-token");
  });

  it("launches Codex app-server with the resolved OAuth token as the Codex credential", async () => {
    const createWorkerBridgeSession = vi.fn().mockResolvedValue({
      status: 201,
      data: {
        data: {
          id: "worker-1",
          kind: "codex",
          command: "codex app-server",
          cwd: "/workspace/workspace-1/agent-1",
          status: "running",
          started_at: "2026-05-28T00:00:02.000Z",
          stopped_at: null,
          exit_status: null,
          env_keys: ["OPENAI_API_KEY"],
          credential_keys: ["OPENAI_API_KEY"],
        },
      },
    });

    const result = await createStoredCredentialLaunch({
      agentId: "agent-1",
      credential: oauthCredential,
      workspaceId: "workspace-1",
      secretValue: "fresh-oauth-access-token",
      handoff: null,
      launcherClient: { createWorkerBridgeSession } as never,
    });

    expect(createWorkerBridgeSession).toHaveBeenCalledWith({
      kind: "codex",
      env: {},
      credentials: {
        OPENAI_API_KEY: {
          source: "inline",
          value: "fresh-oauth-access-token",
        },
      },
      agent_id: "agent-1",
      workspace_id: "workspace-1",
      credential_id: "cred-oauth",
    });
    expect(result.launch).toMatchObject({
      attempted: true,
      sessionId: "worker-1",
      status: "running",
      command: "codex app-server",
    });
  });
});
