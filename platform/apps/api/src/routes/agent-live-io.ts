import type { Express, Request, Response } from "express";

import {
  AgentLiveInputRequestSchema,
  AgentLiveInterruptRequestSchema,
  AgentLiveStreamQuerySchema,
  type AgentLiveInputRequest,
  type AgentLiveInterruptRequest,
  type AgentLiveStreamQuery,
} from "../../../../contracts/agent-live-io.js";
import {
  ApiRouteError,
  apiRoute,
  handleApiRouteError,
  handleProxyError,
  parseHeaders,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import { errorMessage, logEvent } from "../logger.js";
import { assertAgentAccess } from "../services/agent-tools/access.js";
import { internalServiceRoleHeaders } from "../services/internal-service-auth.js";
import { resolveRuntimeTargetForAgent } from "../services/runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "../services/upstream.js";

function liveRuntimePath(agentId: string, action: "input" | "interrupt" | "stream", query?: URLSearchParams) {
  const suffix = query && query.toString().length > 0 ? `?${query.toString()}` : "";
  return `/api/v1/agents/${encodeURIComponent(agentId)}/${action}${suffix}`;
}

async function authorizeAgentLiveIo(input: {
  req: Request;
  agentId: string;
  workspaceId: string;
}): Promise<{ accessToken: string; userId: string; workspaceId: string }> {
  const accessToken = requireAccessToken(input.req);
  const userId = requireVerifiedUser(input.req);
  const authorized = await assertAgentAccess({
    accessToken,
    userId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });

  return { accessToken, userId, workspaceId: authorized.workspaceId };
}

function runtimePayload(
  agentId: string,
  userId: string,
  workspaceId: string,
  body: AgentLiveInputRequest | AgentLiveInterruptRequest,
) {
  return {
    agent_id: agentId,
    workspace_id: workspaceId,
    user_id: userId,
    message: "message" in body ? body.message : undefined,
    session_key: body.sessionKey ?? null,
    reason: "reason" in body ? (body.reason ?? null) : undefined,
    metadata: body.metadata ?? {},
  };
}

async function runtimeRequestForAgent(input: {
  agentId: string;
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>;
  requestTimeoutMs: number;
}) {
  const target = await resolveRuntimeTargetForAgent(input.agentId, input.launcherRequest);
  return createUpstreamRequester(target.baseUrl, input.requestTimeoutMs);
}

function forwardRuntimeResponse(res: Response, result: UpstreamResponse) {
  return res.status(result.status).json(result.body);
}

function internalRuntimeHeaders(req: Request): Record<string, string> {
  const headers = parseHeaders(req.headers as Record<string, string | string[] | undefined>);
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  return internalServiceRoleHeaders(headers);
}

function handleLiveIoRouteError(res: Response, error: unknown) {
  if (error instanceof ApiRouteError) {
    return handleApiRouteError(res, error, {
      status: 500,
      code: "agent_live_io_failed",
      message: "Agent live I/O request failed",
    });
  }
  return handleProxyError(res, error);
}

function queryFromStreamRequest(query: AgentLiveStreamQuery, workspaceId: string, userId: string) {
  const params = new URLSearchParams();
  params.set("workspace_id", workspaceId);
  params.set("user_id", userId);
  if (query.sessionKey) {
    params.set("session_key", query.sessionKey);
  }
  return params;
}

async function proxyAgentLiveStream(input: {
  req: Request;
  res: Response;
  agentId: string;
  query: AgentLiveStreamQuery;
  workspaceId: string;
  userId: string;
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>;
  connectTimeoutMs: number;
}) {
  const target = await resolveRuntimeTargetForAgent(input.agentId, input.launcherRequest);
  const upstreamPath = liveRuntimePath(
    input.agentId,
    "stream",
    queryFromStreamRequest(input.query, input.workspaceId, input.userId),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.connectTimeoutMs);
  input.req.on("close", () => controller.abort());

  try {
    const response = await fetch(`${target.baseUrl}${upstreamPath}`, {
      method: "GET",
      headers: internalRuntimeHeaders(input.req),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();
      return input.res.status(response.status).json(body);
    }

    input.res.status(response.status);
    input.res.setHeader("content-type", response.headers.get("content-type") || "text/event-stream");
    input.res.setHeader("cache-control", response.headers.get("cache-control") || "no-cache");
    input.res.setHeader("connection", "keep-alive");
    input.res.flushHeaders?.();

    if (!response.body) {
      input.res.end();
      return input.res;
    }

    for await (const chunk of response.body) {
      if (input.res.destroyed) break;
      input.res.write(chunk);
    }
    input.res.end();
    return input.res;
  } catch (error) {
    clearTimeout(timeout);
    if (input.res.headersSent) {
      logEvent({
        event: "agent_live_stream_proxy_failed",
        level: "error",
        agent_id: input.agentId,
        error: errorMessage(error),
      });
      input.res.end();
      return input.res;
    }
    return handleProxyError(input.res, error);
  }
}

export function registerAgentLiveIoRoutes(
  app: Express,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  requestTimeoutMs: number,
) {
  app.post(
    "/api/agents/:id/input",
    apiRoute({
      bodySchema: AgentLiveInputRequestSchema,
      invalidBodyMessage: "Invalid agent input request",
      async handler({ req, res, body }) {
        const agentId = requireRouteParam(req, "id", "agent id is required");
        const authorized = await authorizeAgentLiveIo({ req, agentId, workspaceId: body.workspaceId });
        const runtimeRequest = await runtimeRequestForAgent({ agentId, launcherRequest, requestTimeoutMs });
        const result = await runtimeRequest(liveRuntimePath(agentId, "input"), {
          method: "POST",
          headers: internalRuntimeHeaders(req),
          body: JSON.stringify(runtimePayload(agentId, authorized.userId, authorized.workspaceId, body)),
        });
        return forwardRuntimeResponse(res, result);
      },
      onError: handleLiveIoRouteError,
    }),
  );

  app.post(
    "/api/agents/:id/interrupt",
    apiRoute({
      bodySchema: AgentLiveInterruptRequestSchema,
      invalidBodyMessage: "Invalid agent interrupt request",
      async handler({ req, res, body }) {
        const agentId = requireRouteParam(req, "id", "agent id is required");
        const authorized = await authorizeAgentLiveIo({ req, agentId, workspaceId: body.workspaceId });
        const runtimeRequest = await runtimeRequestForAgent({ agentId, launcherRequest, requestTimeoutMs });
        const result = await runtimeRequest(liveRuntimePath(agentId, "interrupt"), {
          method: "POST",
          headers: internalRuntimeHeaders(req),
          body: JSON.stringify(runtimePayload(agentId, authorized.userId, authorized.workspaceId, body)),
        });
        return forwardRuntimeResponse(res, result);
      },
      onError: handleLiveIoRouteError,
    }),
  );

  app.get("/api/agents/:id/stream", async (req: Request, res: Response) => {
    try {
      const agentId = requireRouteParam(req, "id", "agent id is required");
      const parsed = AgentLiveStreamQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiRouteError(400, "invalid_request", "Invalid agent stream request", parsed.error.flatten());
      }

      const authorized = await authorizeAgentLiveIo({ req, agentId, workspaceId: parsed.data.workspaceId });
      return await proxyAgentLiveStream({
        req,
        res,
        agentId,
        query: parsed.data,
        workspaceId: authorized.workspaceId,
        userId: authorized.userId,
        launcherRequest,
        connectTimeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      return handleLiveIoRouteError(res, error);
    }
  });
}
