import type { IncomingMessage } from "node:http";

import { ApiRouteError } from "../http.js";
import { errorMessage, logEvent } from "../logger.js";
import { verifyBearerToken } from "../middleware/authJwt.js";
import { contextHeaders } from "../middleware/request-context.js";
import { getAppUserByAuthId, type AppUserRow } from "../services/auth/app-user.js";
import { assertAgentAccess } from "../services/agent-tools/access.js";
import { internalServiceRoleHeaders } from "../services/internal-service-auth.js";

import { WebSocketUpgradeError } from "./orchestrator-proxy-upgrade.js";

export function requestAgentId(request: IncomingMessage): string | null {
  if (!request.url) return null;
  const url = new URL(request.url, "http://127.0.0.1");
  const value = url.searchParams.get("agent_id")?.trim() || "";
  return value || null;
}

function bearerTokenFromSubprotocol(header: string | string[] | undefined) {
  for (const protocol of subprotocols(header)) {
    if (protocol.startsWith("bearer.")) {
      return protocol.slice("bearer.".length).trim() || null;
    }
  }
  return null;
}

function subprotocols(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header.join(",") : header || "";
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function requestWorkspaceId(requestUrl: URL): string | null {
  const value = requestUrl.searchParams.get("workspace_id")?.trim() || "";
  return value || null;
}

export async function prepareAuthenticatedWebSocketSession(request: IncomingMessage, agentId: string) {
  const requestUrl = new URL(request.url ?? "", "http://127.0.0.1");
  if (requestUrl.searchParams.has("access_token")) {
    requestUrl.searchParams.delete("access_token");
  }

  const requestedProtocols = subprotocols(request.headers["sec-websocket-protocol"]);
  const accessToken = bearerTokenFromSubprotocol(request.headers["sec-websocket-protocol"]);
  if (requestedProtocols.length > 0 && !requestedProtocols.includes("platform.v1") && !accessToken) {
    logEvent({
      event: "gateway_ws_protocol_mismatch",
      level: "warn",
      agent_id: agentId,
      auth_result: "protocol_mismatch",
      protocol_count: requestedProtocols.length,
    });
    throw new WebSocketUpgradeError({
      statusCode: 400,
      code: "protocol_mismatch",
      message: "WebSocket protocol platform.v1 is required",
    });
  }

  if (!accessToken) {
    logEvent({
      event: "gateway_ws_missing_token",
      level: "warn",
      agent_id: agentId,
      auth_result: "missing_token",
    });
    throw new WebSocketUpgradeError({
      statusCode: 401,
      code: "auth_required",
      message: "Supabase access token is required",
    });
  }

  const auth = await verifyBearerToken(accessToken);

  // The runtime persists user_id to tables keyed by public.user.id, while
  // the JWT subject is auth.users.id.
  let appUser: AppUserRow | null;
  try {
    appUser = await getAppUserByAuthId(accessToken, auth.userId);
  } catch (error) {
    logEvent({
      event: "app_user_lookup_failed",
      level: "error",
      auth_user_id: auth.userId,
      agent_id: agentId,
      error: errorMessage(error),
    });
    throw new WebSocketUpgradeError({
      statusCode: 503,
      code: "app_user_lookup_failed",
      message: "Could not resolve authenticated app user",
    });
  }

  if (!appUser) {
    logEvent({
      event: "app_user_not_provisioned",
      level: "error",
      auth_user_id: auth.userId,
      agent_id: agentId,
    });
    throw new WebSocketUpgradeError({
      statusCode: 401,
      code: "app_user_not_provisioned",
      message:
        "Authenticated user has no public.user row. The auth -> public.user provisioning trigger may not have fired for this account.",
    });
  }

  logEvent({
    event: "gateway_ws_auth_completed",
    auth_user_id: auth.userId,
    app_user_id: appUser.id,
    agent_id: agentId,
    auth_result: "valid",
    role: auth.role,
  });

  try {
    const authorized = await assertAgentAccess({
      accessToken,
      userId: appUser.id,
      agentId,
      workspaceId: requestWorkspaceId(requestUrl),
    });
    requestUrl.searchParams.set("workspace_id", authorized.workspaceId);
  } catch (error) {
    if (error instanceof ApiRouteError) {
      throw new WebSocketUpgradeError({
        statusCode: error.status,
        code: error.code,
        message: error.message,
      });
    }
    logEvent({
      event: "agent_lookup_failed",
      level: "error",
      auth_user_id: auth.userId,
      app_user_id: appUser.id,
      agent_id: agentId,
      error: errorMessage(error),
    });
    throw new WebSocketUpgradeError({
      statusCode: 503,
      code: "agent_lookup_failed",
      message: "Could not resolve authorized agent",
    });
  }

  requestUrl.searchParams.set("user_id", appUser.id);
  request.url = `${requestUrl.pathname}${requestUrl.search}`;

  return {
    headers: internalServiceRoleHeaders({
      ...contextHeaders(),
      ...(request.headers.cookie ? { cookie: String(request.headers.cookie) } : {}),
    }),
    authUserId: auth.userId,
    userId: appUser.id,
  };
}
