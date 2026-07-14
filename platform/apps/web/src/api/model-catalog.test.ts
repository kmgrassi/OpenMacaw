import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

vi.mock("./credentials", () => ({
  saveStoredCredential: vi.fn(),
}));

import { apiFetch } from "./client";
import { saveStoredCredential } from "./credentials";
import {
  listModelCatalog,
  listModelProviders,
  saveModelProviderCredential,
} from "./model-catalog";
import { ROUTES } from "./routes";

const mockApiFetch = vi.mocked(apiFetch);
const mockSaveStoredCredential = vi.mocked(saveStoredCredential);

describe("model catalog api helpers", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockSaveStoredCredential.mockReset();
  });

  it("lists the model catalog through apiFetch", async () => {
    const payload = { models: [], fetchedAt: "2026-07-14T00:00:00.000Z" };
    mockApiFetch.mockResolvedValueOnce(payload);

    await expect(
      listModelCatalog({ agentId: "agent 1", workspaceId: "workspace/1", refresh: true }),
    ).resolves.toEqual(payload);

    expect(mockApiFetch).toHaveBeenCalledWith(
      `${ROUTES.models}?agentId=agent+1&workspaceId=workspace%2F1&refresh=true`,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });

  it("lists model providers through apiFetch", async () => {
    mockApiFetch.mockResolvedValueOnce({ providers: [], fetchedAt: "2026-07-14T00:00:00.000Z" });

    await listModelProviders({ workspaceId: "workspace-1", refresh: true });

    expect(mockApiFetch).toHaveBeenCalledWith(
      `${ROUTES.modelProviders}?workspaceId=workspace-1&refresh=true`,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });

  it("refreshes provider state through the shared provider list helper after saving", async () => {
    mockSaveStoredCredential.mockResolvedValueOnce({
      credential: {
        id: "cred-1",
        agentId: null,
        workspaceId: "workspace-1",
        provider: "openai",
        label: "OpenAI API key",
        envVar: "OPENAI_API_KEY",
        updatedAt: "2026-07-14T00:00:00.000Z",
        validationState: "unknown",
        validatedAt: null,
        launchableKind: "codex",
      },
    });
    mockApiFetch.mockResolvedValueOnce({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          description: "OpenAI API",
          authMode: "api_key",
          credentialConfigured: true,
          valid: true,
          modelCount: 3,
          lastValidatedAt: "2026-07-14T00:00:00.000Z",
          lastError: null,
        },
      ],
      fetchedAt: "2026-07-14T00:00:00.000Z",
    });

    const result = await saveModelProviderCredential("openai", {
      workspaceId: "workspace-1",
      apiKey: "secret",
    });

    expect(mockSaveStoredCredential).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      provider: "openai",
      apiKey: "secret",
      endpoint: undefined,
      apiVersion: undefined,
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      `${ROUTES.modelProviders}?workspaceId=workspace-1`,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
    expect(result.provider.id).toBe("openai");
  });
});
