import {
  ImportOpenAICodexOAuthResponseSchema,
  PollOpenAICodexOAuthResponseSchema,
  StartOpenAICodexOAuthResponseSchema,
  type ImportOpenAICodexOAuthResponse,
  type PollOpenAICodexOAuthResponse,
  type StartOpenAICodexOAuthResponse,
} from "../../../../contracts/credentials-oauth";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function startOpenAICodexOAuth(input: {
  agentId: string;
  workspaceId: string;
}): Promise<StartOpenAICodexOAuthResponse> {
  return apiFetch(ROUTES.openaiCodexOAuthStart, {
    method: "POST",
    body: input,
    schema: StartOpenAICodexOAuthResponseSchema,
    defaultErrorMessage: (status) => `Could not start OAuth (${status})`,
  });
}

export async function pollOpenAICodexOAuth(
  sessionId: string,
): Promise<PollOpenAICodexOAuthResponse> {
  return apiFetch(ROUTES.openaiCodexOAuthPoll, {
    method: "POST",
    body: { sessionId },
    schema: PollOpenAICodexOAuthResponseSchema,
    defaultErrorMessage: (status) => `Could not poll OAuth (${status})`,
  });
}

export async function importOpenAICodexOAuth(input: {
  agentId: string;
  workspaceId: string;
  accessToken: string;
}): Promise<ImportOpenAICodexOAuthResponse> {
  return apiFetch(ROUTES.openaiCodexOAuthImport, {
    method: "POST",
    body: input,
    schema: ImportOpenAICodexOAuthResponseSchema,
    defaultErrorMessage: (status) =>
      `Could not import OAuth token (${status})`,
  });
}
