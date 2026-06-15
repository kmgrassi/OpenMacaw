import type { Request, Response } from "express";

import {
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  handleProxyError,
  parseHeaders,
  requireAccessToken,
  requireVerifiedUser,
} from "../http.js";
import { attachRuntimeDispatchContext, buildRuntimeDispatchContext } from "./runtime-dispatch-context.js";
import { internalServiceRoleHeaders } from "./internal-service-auth.js";
import { resolveRequestAgentId, resolveRuntimeTargetForAgent } from "./runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "./upstream.js";

function resolveAgentProxyPath(req: Request): string {
  const requestUrl = new URL(req.originalUrl, "http://127.0.0.1");
  const upstreamPath = requestUrl.pathname;
  const method = req.method.toUpperCase();

  let mappedPath = upstreamPath;

  if (upstreamPath === "/api/agents" || upstreamPath === "/api/agents/") {
    mappedPath = method === "POST" ? "/api/v1/agents" : "/api/v1/state";
  } else if (upstreamPath === "/api/agents/refresh" || upstreamPath === "/api/agents/refresh/") {
    mappedPath = "/api/v1/refresh";
  } else if (upstreamPath.startsWith("/api/agents/")) {
    const [, , , ...segments] = upstreamPath.split("/");
    mappedPath = segments.length === 0 ? "/api/v1" : `/api/v1/${segments.join("/")}`;
  } else {
    mappedPath = upstreamPath.replace(/^\/api\/agents/, "/api/v1/agents");
  }

  return `${mappedPath}${requestUrl.search}`;
}

const LOCAL_CODING_RUNTIME_ERROR_STATUS: Record<string, number> = {
  local_runtime_offline: 503,
  model_not_found: 404,
  capability_missing: 422,
  approval_required: 409,
  tool_execution_timeout: 504,
  workspace_policy_violation: 403,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function runtimeErrorCode(body: unknown): string | null {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  const code = error?.code ?? record?.code ?? record?.error_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function normalizeRuntimeResponse(result: UpstreamResponse): UpstreamResponse {
  if (result.status < 400) return result;

  const code = runtimeErrorCode(result.body);
  if (!code || !(code in LOCAL_CODING_RUNTIME_ERROR_STATUS)) return result;

  const record = asRecord(result.body);
  const error = asRecord(record?.error);
  const message =
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof record?.message === "string" && record.message.trim()) ||
    "Runtime rejected the local model coding request";
  const details = error?.details ?? record?.details ?? result.body;

  return {
    ...result,
    status: LOCAL_CODING_RUNTIME_ERROR_STATUS[code] ?? result.status,
    body: errorPayload(code, message, details),
  };
}

function internalRuntimeHeaders(req: Request): Record<string, string> {
  return internalServiceRoleHeaders(parseHeaders(req.headers as Record<string, string | string[] | undefined>));
}

async function proxyRequest(
  runtimeRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  req: Request,
  res: Response,
  upstreamPath: string,
  fallback?: (error: unknown) => Response,
  bodyOverride?: unknown,
) {
  try {
    const result = await runtimeRequest(upstreamPath, {
      method: req.method,
      headers: internalRuntimeHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(bodyOverride ?? req.body ?? {}),
    });

    const normalized = normalizeRuntimeResponse(result);
    return res.status(normalized.status).json(normalized.body);
  } catch (error) {
    if (fallback) {
      return fallback(error);
    }
    return handleProxyError(res, error);
  }
}

export async function proxyResolvedRuntimeRequest(init: {
  req: Request;
  res: Response;
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>;
  requestTimeoutMs: number;
}) {
  const { req, res, launcherRequest, requestTimeoutMs } = init;
  const upstreamPath = resolveAgentProxyPath(req);

  try {
    const agentId = await resolveRequestAgentId(req);
    if (!agentId) {
      return res.status(400).json({
        error: {
          code: "agent_id_required",
          message: "agent_id is required to resolve a runtime target",
        },
      });
    }

    let target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
    let runtimeRequest = createUpstreamRequester(target.baseUrl, requestTimeoutMs);

    const requestWithRetry = async (path: string, requestInit?: RequestInit) => {
      try {
        return await runtimeRequest(path, requestInit);
      } catch {
        await launcherRequest(`/agents/${encodeURIComponent(agentId)}`, { method: "GET" }).catch(() => undefined);
        target = await resolveRuntimeTargetForAgent(agentId, launcherRequest);
        runtimeRequest = createUpstreamRequester(target.baseUrl, requestTimeoutMs);
        return await runtimeRequest(path, requestInit);
      }
    };

    const dispatchContext =
      req.method === "GET" || req.method === "HEAD"
        ? null
        : await buildRuntimeDispatchContext({
            accessToken: requireAccessToken(req),
            requesterUserId: requireVerifiedUser(req),
            agentId,
            requestBody: req.body ?? {},
          });

    return await proxyRequest(
      requestWithRetry,
      req,
      res,
      upstreamPath,
      undefined,
      attachRuntimeDispatchContext(req.body ?? {}, dispatchContext),
    );
  } catch (error) {
    if (req.method === "GET" && upstreamPath === "/api/v1/state") {
      return res.status(200).json({ agents: [], reasons: ["broker_unavailable"] });
    }
    if (error instanceof ApiRouteError) {
      return handleApiRouteError(res, error, {
        status: 500,
        code: "runtime_dispatch_context_failed",
        message: "Runtime dispatch context failed",
      });
    }
    return handleProxyError(res, error);
  }
}
