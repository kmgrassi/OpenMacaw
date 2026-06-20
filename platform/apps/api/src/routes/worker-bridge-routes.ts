import type { Express, Request, Response } from "express";

import { z } from "zod";

import {
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  handleLauncherError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { StartWorkerBridgeSessionRequestSchema } from "../services/launcher.js";
import { assertAgentAccess } from "../services/agent-tools/access.js";
import { mapWorkerBridgeSessionListResponse, mapWorkerBridgeSessionResponse } from "../services/worker-bridge.js";
import { assertCredentialReferenceBelongsToWorkspace } from "./stored-agent-credentials/authz.js";

function requireWorkerBridgeIdentityLaunch(body: unknown) {
  const parsed = StartWorkerBridgeSessionRequestSchema.parse(body ?? {});
  const agentId = parsed.agent_id?.trim() ?? "";
  const workspaceId = parsed.workspace_id?.trim() ?? "";
  const credentialId = parsed.credential_id?.trim() ?? "";

  if (!agentId || !workspaceId || !credentialId) {
    throw new ApiRouteError(
      403,
      "worker_bridge_identity_required",
      "Worker bridge API launches must be scoped to an authorized agent workspace and credential",
    );
  }

  return { parsed, agentId, workspaceId, credentialId };
}

async function assertWorkerBridgeSessionAccess(
  req: Request,
  session: { agent_id?: string | null; workspace_id?: string | null },
) {
  const agentId = session.agent_id?.trim() ?? "";
  const workspaceId = session.workspace_id?.trim() ?? "";
  if (!agentId || !workspaceId) {
    throw new ApiRouteError(
      403,
      "worker_bridge_forbidden",
      "Worker bridge session is not bound to an authorized agent workspace",
    );
  }

  await assertAgentAccess({
    accessToken: requireAccessToken(req),
    userId: requireVerifiedUser(req),
    agentId,
    workspaceId,
  });
}

async function canAccessWorkerBridgeSession(
  req: Request,
  session: { agent_id?: string | null; workspace_id?: string | null },
): Promise<boolean> {
  try {
    await assertWorkerBridgeSessionAccess(req, session);
    return true;
  } catch (error) {
    if (
      error instanceof ApiRouteError &&
      (error.status === 403 || error.status === 404 || error.code === "worker_bridge_forbidden")
    ) {
      return false;
    }
    throw error;
  }
}

function handleWorkerBridgeRouteError(res: Response, error: unknown, fallback: { code: string; message: string }) {
  if (error instanceof z.ZodError) {
    return res.status(400).json(
      errorPayload("invalid_request", "Invalid worker bridge session payload", {
        issues: error.issues,
      }),
    );
  }
  if (error instanceof ApiRouteError) {
    return handleApiRouteError(res, error, {
      status: 500,
      code: fallback.code,
      message: fallback.message,
    });
  }
  return handleLauncherError(res, error);
}

export function registerWorkerBridgeRoutes(app: Express, launcherClient: LauncherClient) {
  app.get("/api/worker-bridge/sessions", async (req: Request, res: Response) => {
    try {
      requireAccessToken(req);
      requireVerifiedUser(req);
      const result = await launcherClient.listWorkerBridgeSessions();
      const visibleSessions = (
        await Promise.all(
          (result.data ?? []).map(async (session) =>
            (await canAccessWorkerBridgeSession(req, session)) ? session : null,
          ),
        )
      ).filter((session): session is NonNullable<typeof session> => Boolean(session));
      return res.status(200).json(mapWorkerBridgeSessionListResponse({ data: visibleSessions }));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_list_failed",
        message: "Could not list worker bridge sessions",
      });
    }
  });

  app.post("/api/worker-bridge/sessions", async (req: Request, res: Response) => {
    try {
      const { parsed, agentId, workspaceId, credentialId } = requireWorkerBridgeIdentityLaunch(req.body);
      await assertAgentAccess({
        accessToken: requireAccessToken(req),
        userId: requireVerifiedUser(req),
        agentId,
        workspaceId,
      });
      await assertCredentialReferenceBelongsToWorkspace({
        workspaceId,
        credentialRef: { type: "credential_id", value: credentialId },
      });

      const result = await launcherClient.createWorkerBridgeSession(parsed);
      if (result.data?.data) {
        await assertWorkerBridgeSessionAccess(req, result.data.data);
      }
      return res.status(result.status).json(mapWorkerBridgeSessionResponse(result.data));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_create_failed",
        message: "Could not create worker bridge session",
      });
    }
  });

  app.get("/api/worker-bridge/sessions/:id", async (req: Request, res: Response) => {
    try {
      const result = await launcherClient.getWorkerBridgeSession(requireRouteParam(req, "id"));
      if (result.data) {
        await assertWorkerBridgeSessionAccess(req, result.data);
      }
      return res.status(200).json(mapWorkerBridgeSessionResponse(result));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_fetch_failed",
        message: "Could not fetch worker bridge session",
      });
    }
  });

  app.delete("/api/worker-bridge/sessions/:id", async (req: Request, res: Response) => {
    try {
      const sessionId = requireRouteParam(req, "id");
      const existing = await launcherClient.getWorkerBridgeSession(sessionId);
      if (existing.data) {
        await assertWorkerBridgeSessionAccess(req, existing.data);
      }
      const result = await launcherClient.deleteWorkerBridgeSession(sessionId);
      return res.status(200).json(mapWorkerBridgeSessionResponse(result));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_delete_failed",
        message: "Could not delete worker bridge session",
      });
    }
  });
}
