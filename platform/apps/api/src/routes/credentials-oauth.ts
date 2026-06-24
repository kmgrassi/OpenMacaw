import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";

import {
  ImportOpenAICodexOAuthRequestSchema,
  ImportOpenAICodexOAuthResponseSchema,
  PollOpenAICodexOAuthRequestSchema,
  PollOpenAICodexOAuthResponseSchema,
  StartOpenAICodexOAuthRequestSchema,
  StartOpenAICodexOAuthResponseSchema,
} from "../../../../contracts/credentials-oauth.js";
import { errorPayload, handleApiRouteError, requestAccessToken } from "../http.js";
import {
  exchangeOpenAICodexDeviceCode,
  OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  pollOpenAICodexDeviceCode,
  requestOpenAICodexDeviceCode,
  resolveCodexAuthIdentity,
} from "../services/oauth/openai-codex.js";
import {
  saveOpenAICodexAccessTokenCredentialForAgent,
  saveOpenAICodexOAuthCredentialForAgent,
  type ResolvedSavedCredential,
} from "../services/saved-credentials.js";
import { syncCredentialIntoRoutingRuleForAgent } from "../services/stored-agent-routing.js";
import { requireStoredAgent } from "./stored-agent-credentials/authz.js";

type PendingSession = {
  ownerUserId: string;
  agentId: string;
  workspaceId: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  lastPollAt: number;
};

const sessions = new Map<string, PendingSession>();
const SESSION_GC_INTERVAL_MS = 60_000;

let gcStarted = false;
function ensureSessionGc() {
  if (gcStarted) return;
  gcStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }, SESSION_GC_INTERVAL_MS).unref();
}

export function registerCredentialOAuthRoutes(app: Express) {
  ensureSessionGc();

  async function syncOAuthCredential(input: {
    accessToken: string;
    userId: string;
    agentId: string;
    workspaceId: string;
    credential: ResolvedSavedCredential;
  }) {
    const agent = await requireStoredAgent({
      accessToken: input.accessToken,
      userId: input.userId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    if (agent.workspaceId && input.credential.credentialRowId) {
      await syncCredentialIntoRoutingRuleForAgent({
        agent: {
          id: agent.id,
          workspaceId: agent.workspaceId,
          agentType: agent.agentType,
          model: agent.model,
          provider: agent.provider,
        },
        credentialId: input.credential.credentialRowId,
        provider: "openai_codex",
      });
    }
  }

  app.post("/api/credentials/openai-codex/oauth/start", async (req: Request, res: Response) => {
    const parsed = StartOpenAICodexOAuthRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(errorPayload("invalid_request", "agentId and workspaceId are required"));
    }
    try {
      const accessToken = requestAccessToken(req);
      if (!accessToken || !req.userId) {
        return res.status(401).json(errorPayload("auth_required", "Supabase access token is required"));
      }
      await requireStoredAgent({
        accessToken,
        userId: req.userId,
        agentId: parsed.data.agentId,
        workspaceId: parsed.data.workspaceId,
      });
      const deviceCode = await requestOpenAICodexDeviceCode();
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        ownerUserId: req.userId,
        agentId: parsed.data.agentId,
        workspaceId: parsed.data.workspaceId,
        deviceAuthId: deviceCode.deviceAuthId,
        userCode: deviceCode.userCode,
        intervalMs: deviceCode.intervalMs,
        expiresAt: Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
        lastPollAt: 0,
      });
      return res.status(200).json(
        StartOpenAICodexOAuthResponseSchema.parse({
          sessionId,
          verificationUrl: deviceCode.verificationUrl,
          userCode: deviceCode.userCode,
          expiresInMs: deviceCode.expiresInMs,
          intervalMs: deviceCode.intervalMs,
        }),
      );
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "oauth_start_failed",
        message: "Could not start OpenAI Codex OAuth flow",
      });
    }
  });

  app.post("/api/credentials/openai-codex/oauth/poll", async (req: Request, res: Response) => {
    const parsed = PollOpenAICodexOAuthRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(errorPayload("invalid_request", "sessionId is required"));
    }
    const session = sessions.get(parsed.data.sessionId);
    if (!session) {
      return res.status(404).json(errorPayload("oauth_session_not_found", "OAuth session not found"));
    }
    if (!req.userId || session.ownerUserId !== req.userId) {
      return res.status(404).json(errorPayload("oauth_session_not_found", "OAuth session not found"));
    }
    if (session.expiresAt <= Date.now()) {
      sessions.delete(parsed.data.sessionId);
      return res.status(200).json(PollOpenAICodexOAuthResponseSchema.parse({ status: "expired" }));
    }
    // Throttle: don't hit OpenAI more often than its interval.
    const now = Date.now();
    if (now - session.lastPollAt < session.intervalMs) {
      return res.status(200).json(PollOpenAICodexOAuthResponseSchema.parse({ status: "pending" }));
    }
    session.lastPollAt = now;

    try {
      const accessToken = requestAccessToken(req);
      if (!accessToken) {
        return res.status(401).json(errorPayload("auth_required", "Supabase access token is required"));
      }
      await requireStoredAgent({
        accessToken,
        userId: req.userId,
        agentId: session.agentId,
        workspaceId: session.workspaceId,
      });
      const pollResult = await pollOpenAICodexDeviceCode({
        deviceAuthId: session.deviceAuthId,
        userCode: session.userCode,
      });
      if (pollResult.status === "pending") {
        return res.status(200).json(PollOpenAICodexOAuthResponseSchema.parse({ status: "pending" }));
      }
      if (pollResult.status === "failed") {
        sessions.delete(parsed.data.sessionId);
        return res.status(200).json(
          PollOpenAICodexOAuthResponseSchema.parse({
            status: "failed",
            error: pollResult.error,
          }),
        );
      }
      // authorized — exchange + persist.
      const tokens = await exchangeOpenAICodexDeviceCode({
        authorizationCode: pollResult.authorizationCode,
        codeVerifier: pollResult.codeVerifier,
      });
      const identity = resolveCodexAuthIdentity(tokens.access);
      const credential = await saveOpenAICodexOAuthCredentialForAgent({
        agentId: session.agentId,
        workspaceId: session.workspaceId,
        tokens,
        identity,
      });

      // Mirror the API-key save path (PR #429): once the credential row
      // exists, point the agent's routing rule at it. Without this the
      // agent keeps running on whatever its routing rule was before
      // (often local_model_coding for a coding agent) and the user
      // doesn't see ChatGPT take effect until they manually edit the
      // runtime profile.
      await syncOAuthCredential({
        accessToken,
        userId: req.userId,
        agentId: session.agentId,
        workspaceId: session.workspaceId,
        credential,
      });
      sessions.delete(parsed.data.sessionId);

      return res.status(200).json(
        PollOpenAICodexOAuthResponseSchema.parse({
          status: "complete",
          credential: {
            id: credential.id,
            credentialRowId: credential.credentialRowId,
            agentId: credential.agentId,
            workspaceId: credential.workspaceId,
            provider: credential.provider,
            label: credential.label,
            envVar: credential.envVar,
            updatedAt: credential.updatedAt,
            validationState: credential.validationState,
            validatedAt: credential.validatedAt,
            launchableKind: credential.launchableKind,
          },
          email: identity.email ?? null,
          accountId: identity.accountId ?? null,
          planType: identity.chatgptPlanType ?? null,
        }),
      );
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "oauth_poll_failed",
        message: "Could not complete OpenAI Codex OAuth flow",
      });
    }
  });

  app.post("/api/credentials/openai-codex/oauth/import", async (req: Request, res: Response) => {
    const parsed = ImportOpenAICodexOAuthRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json(errorPayload("invalid_request", "agentId, workspaceId, and accessToken are required"));
    }
    try {
      const accessToken = requestAccessToken(req);
      if (!accessToken) {
        return res.status(401).json(errorPayload("auth_required", "Supabase access token is required"));
      }
      await requireStoredAgent({
        accessToken,
        userId: req.userId ?? "",
        agentId: parsed.data.agentId,
        workspaceId: parsed.data.workspaceId,
      });
      const identity = resolveCodexAuthIdentity(parsed.data.accessToken);
      const credential = await saveOpenAICodexAccessTokenCredentialForAgent({
        agentId: parsed.data.agentId,
        workspaceId: parsed.data.workspaceId,
        accessToken: parsed.data.accessToken,
        identity,
      });
      await syncOAuthCredential({
        accessToken,
        userId: req.userId ?? "",
        agentId: parsed.data.agentId,
        workspaceId: parsed.data.workspaceId,
        credential,
      });

      return res.status(200).json(
        ImportOpenAICodexOAuthResponseSchema.parse({
          credential: {
            id: credential.id,
            credentialRowId: credential.credentialRowId,
            agentId: credential.agentId,
            workspaceId: credential.workspaceId,
            provider: credential.provider,
            label: credential.label,
            envVar: credential.envVar,
            updatedAt: credential.updatedAt,
            launchableKind: credential.launchableKind,
          },
          email: identity.email ?? null,
          accountId: identity.accountId ?? null,
          planType: identity.chatgptPlanType ?? null,
        }),
      );
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "oauth_import_failed",
        message: "Could not import OpenAI Codex OAuth token",
      });
    }
  });
}
