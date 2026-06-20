import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ApiClientError, apiFetch } from "./client";
import {
  activateStoredAgent,
  listCredentialAliases,
  listSavedCredentialsForAgent,
  saveAgentCredentialReference,
  saveCredentialAlias,
  saveStoredCredential,
} from "./credentials";
import { ROUTES } from "./routes";

const mockApiFetch = vi.mocked(apiFetch);

describe("credentials api helpers", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("lists agent credentials through apiFetch with workspace scope", async () => {
    mockApiFetch.mockResolvedValueOnce({ credentials: [{ id: "cred-1" }] });

    await expect(
      listSavedCredentialsForAgent("agent 1", "workspace/1"),
    ).resolves.toEqual([{ id: "cred-1" }]);

    expect(mockApiFetch).toHaveBeenCalledWith(
      `${ROUTES.storedAgentCredentials("agent 1")}?workspaceId=workspace%2F1`,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });

  it("lists credential aliases through apiFetch", async () => {
    mockApiFetch.mockResolvedValueOnce({ aliases: [{ alias: "OPENAI_API_KEY" }] });

    await expect(listCredentialAliases("workspace-1")).resolves.toEqual([
      { alias: "OPENAI_API_KEY" },
    ]);

    expect(mockApiFetch).toHaveBeenCalledWith(
      `${ROUTES.credentialAliases}?workspaceId=workspace-1`,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });

  it("saves credential aliases with the route-encoded alias", async () => {
    mockApiFetch.mockResolvedValueOnce({
      alias: { alias: "alias/with spaces", credentialId: "cred-1" },
    });

    await expect(
      saveCredentialAlias({
        workspaceId: "workspace-1",
        alias: "alias/with spaces",
        credentialId: "cred-1",
      }),
    ).resolves.toEqual({
      alias: "alias/with spaces",
      credentialId: "cred-1",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.credentialAlias("alias/with spaces"),
      expect.objectContaining({
        method: "PUT",
        body: {
          workspaceId: "workspace-1",
          alias: "alias/with spaces",
          credentialId: "cred-1",
        },
      }),
    );
  });

  it("forwards structured activation errors without dropping code/details", async () => {
    const error = new ApiClientError({
      status: 409,
      message: "Already active",
      code: "already_active",
      details: { sessionId: "sess-1" },
      body: {},
    });
    mockApiFetch.mockRejectedValueOnce(error);

    await expect(
      activateStoredAgent("agent-1", "workspace-1"),
    ).rejects.toBe(error);
  });

  it("saves agent credential references with the normalized request body", async () => {
    mockApiFetch.mockResolvedValueOnce({
      reference: {
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runnerKind: "codex",
        provider: "openai",
        model: "gpt-5",
        credentialRef: { type: "credential_id", value: "cred-1" },
        localEndpointUrl: null,
        credential: null,
        updatedAt: null,
      },
      credentials: [],
      aliases: [],
    });

    await saveAgentCredentialReference({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5",
      localModelId: null,
      localEndpointUrl: null,
      credentialRef: { type: "credential_id", value: "cred-1" },
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.storedAgentCredentialReference("agent-1"),
      expect.objectContaining({
        method: "PUT",
        body: {
          workspaceId: "workspace-1",
          runnerKind: "codex",
          provider: "openai",
          model: "gpt-5",
          localModelId: null,
          localEndpointUrl: null,
          credentialRef: { type: "credential_id", value: "cred-1" },
        },
      }),
    );
  });

  it("saves stored credentials with the expected create payload", async () => {
    mockApiFetch.mockResolvedValueOnce({ credential: { id: "cred-1" } });

    await saveStoredCredential({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      provider: "openai",
      apiKey: "secret",
      endpoint: "https://example.test",
      apiVersion: "2024-01-01",
      alias: "primary",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.credentials,
      expect.objectContaining({
        method: "POST",
        body: {
          scope: { kind: "workspace", workspaceId: "workspace-1" },
          key: {
            format: "api_key",
            provider: "openai",
            secret: "secret",
            endpoint: "https://example.test",
            apiVersion: "2024-01-01",
          },
          alias: "primary",
        },
      }),
    );
  });
});
