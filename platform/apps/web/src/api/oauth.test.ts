import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { apiFetch } from "./client";
import {
  importOpenAICodexOAuth,
  pollOpenAICodexOAuth,
  startOpenAICodexOAuth,
} from "./oauth";
import { ROUTES } from "./routes";

const mockApiFetch = vi.mocked(apiFetch);

describe("oauth api helpers", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("starts OpenAI Codex OAuth through apiFetch", async () => {
    mockApiFetch.mockResolvedValueOnce({ verificationUri: "https://example.test" });

    await startOpenAICodexOAuth({
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.openaiCodexOAuthStart,
      expect.objectContaining({
        method: "POST",
        body: {
          agentId: "agent-1",
          workspaceId: "workspace-1",
        },
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });

  it("polls OpenAI Codex OAuth through apiFetch", async () => {
    mockApiFetch.mockResolvedValueOnce({ status: "pending" });

    await pollOpenAICodexOAuth("session-1");

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.openaiCodexOAuthPoll,
      expect.objectContaining({
        method: "POST",
        body: { sessionId: "session-1" },
      }),
    );
  });

  it("imports OpenAI Codex OAuth tokens through apiFetch", async () => {
    mockApiFetch.mockResolvedValueOnce({ credential: { id: "cred-1" } });

    await importOpenAICodexOAuth({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      accessToken: "token-1",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.openaiCodexOAuthImport,
      expect.objectContaining({
        method: "POST",
        body: {
          agentId: "agent-1",
          workspaceId: "workspace-1",
          accessToken: "token-1",
        },
      }),
    );
  });
});
