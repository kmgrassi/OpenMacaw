import type { Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import { errorMessage, logEvent } from "./logger.js";
import {
  LauncherHttpError,
  LauncherNetworkError,
  LauncherResponseParseError,
  LauncherTimeoutError,
} from "./services/launcher.js";
import { RuntimeTargetError } from "./services/runtime-target.js";

export function errorPayload(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

export class ApiRouteError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRouteError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isApiRouteErrorLike(error: unknown): error is ApiRouteError {
  if (error instanceof ApiRouteError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  return (
    typeof candidate.status === "number" && typeof candidate.code === "string" && typeof candidate.message === "string"
  );
}

export type ApiRouteContext<TBody = unknown> = {
  req: Request;
  res: Response;
  body: TBody;
  accessToken?: string;
  userId?: string;
};

export type AuthenticatedApiRouteContext<TBody = unknown> = Omit<ApiRouteContext<TBody>, "accessToken" | "userId"> & {
  accessToken: string;
  userId: string;
};

type SharedApiRouteOptions<TBody> = {
  bodySchema?: ZodType<TBody>;
  invalidBodyMessage?: string;
  onError?: (res: Response, error: unknown) => Response;
};

type UnauthenticatedApiRouteOptions<TBody> = SharedApiRouteOptions<TBody> & {
  requireAuth?: false | undefined;
  handler: (context: ApiRouteContext<TBody>) => Promise<Response | void>;
};

type AuthenticatedApiRouteOptions<TBody> = SharedApiRouteOptions<TBody> & {
  requireAuth: true;
  handler: (context: AuthenticatedApiRouteContext<TBody>) => Promise<Response | void>;
};

export function handleApiRouteError(
  res: Response,
  error: unknown,
  fallback: { status: number; code: string; message: string },
) {
  if (isApiRouteErrorLike(error)) {
    if (error.status >= 500) {
      // Log even our own 5xx ApiRouteErrors — they represent
      // upstream/internal failure surfaces (e.g. Supabase write
      // returned no row) that we want visible in CloudWatch beyond
      // the body of the response we send to the client.
      logEvent({
        event: "api_route_error",
        level: "error",
        error_kind: "api_route_error",
        error_status: error.status,
        error_code: error.code,
        error_message: error.message,
        error_details: error.details,
      });
    }
    return res.status(error.status).json(errorPayload(error.code, error.message, error.details));
  }

  // Express middleware errors (e.g. express.json() parse failures,
  // body-parser too-large/charset errors) follow the http-errors
  // convention: they carry `status`/`statusCode` and `expose: true`
  // when the message is safe to share with the client. Honor that
  // contract instead of masking client errors as 500/internal_error.
  const httpError = exposableHttpError(error);
  if (httpError) {
    logEvent({
      event: "api_route_error",
      level: "warn",
      error_kind: "middleware_http_error",
      error_status: httpError.status,
      error_code: httpError.code,
      error_message: httpError.message,
    });
    return res.status(httpError.status).json(errorPayload(httpError.code, httpError.message));
  }

  // Unhandled exception path. Without this log, the only record of
  // what went wrong is the stringified `error` we send back in the
  // response body — which never reaches the server logs and is lost
  // once the client closes the tab. Emit structured details so the
  // next 5xx tells us what actually failed, not just that something did.
  logEvent({
    event: "api_route_error",
    level: "error",
    error_kind: "unhandled",
    error_status: fallback.status,
    error_code: fallback.code,
    error_message: errorMessage(error),
    error_stack: error instanceof Error ? error.stack : undefined,
    error_name: error instanceof Error ? error.name : undefined,
  });

  return res.status(fallback.status).json(errorPayload(fallback.code, fallback.message, String(error)));
}

function exposableHttpError(error: unknown): { status: number; code: string; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    type?: unknown;
    message?: unknown;
  };
  if (candidate.expose !== true) return null;
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : null;
  if (status === null || status < 400 || status >= 500) return null;
  const code = typeof candidate.type === "string" && candidate.type.length > 0 ? candidate.type : "bad_request";
  const message =
    typeof candidate.message === "string" && candidate.message.length > 0 ? candidate.message : "Bad request";
  return { status, code, message };
}

export function apiRoute<TBody = unknown>(options: AuthenticatedApiRouteOptions<TBody>): RequestHandler;
export function apiRoute<TBody = unknown>(options: UnauthenticatedApiRouteOptions<TBody>): RequestHandler;
export function apiRoute<TBody = unknown>(
  options: AuthenticatedApiRouteOptions<TBody> | UnauthenticatedApiRouteOptions<TBody>,
): RequestHandler {
  return async (req, res) => {
    try {
      const requiresAuth = options.requireAuth === true;
      const auth = requiresAuth
        ? {
            accessToken: requireAccessToken(req),
            userId: requireVerifiedUser(req),
          }
        : null;

      const parsedBody = options.bodySchema?.safeParse(req.body ?? {});
      if (parsedBody && !parsedBody.success) {
        throw new ApiRouteError(
          400,
          "invalid_request",
          options.invalidBodyMessage ?? "Request body is invalid",
          parsedBody.error.flatten(),
        );
      }

      const body = parsedBody?.data ?? (req.body as TBody);
      if (auth) {
        return await (options as AuthenticatedApiRouteOptions<TBody>).handler({
          req,
          res,
          body,
          accessToken: auth.accessToken,
          userId: auth.userId,
        });
      }

      return await (options as UnauthenticatedApiRouteOptions<TBody>).handler({
        req,
        res,
        body,
      });
    } catch (error) {
      if (options.onError) {
        return options.onError(res, error);
      }

      return handleApiRouteError(res, error, {
        status: 500,
        code: "internal_error",
        message: "Request failed",
      });
    }
  };
}

export function requestWorkspaceId(req: Request): string | null {
  if (typeof req.query.workspaceId === "string" && req.query.workspaceId.trim().length > 0) {
    return req.query.workspaceId.trim();
  }

  if (typeof req.body?.workspaceId === "string" && req.body.workspaceId.trim().length > 0) {
    return req.body.workspaceId.trim();
  }

  return null;
}

export function requireWorkspaceId(req: Request, message = "workspaceId is required"): string {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", message);
  }

  return workspaceId;
}

export function parseHeaders(source: Record<string, undefined | string | string[]>): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      headers[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      headers[key] = value.join(",");
    }
  }

  delete headers.host;
  return headers;
}

export function requestAccessToken(req: Request): string | null {
  const authorization = req.header("authorization")?.trim() || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

export function requireAccessToken(req: Request): string {
  const accessToken = requestAccessToken(req);
  if (!accessToken) {
    throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
  }

  return accessToken;
}

export function requireVerifiedUser(req: Request): string {
  const userId = req.userId?.trim() ?? "";
  if (!userId) {
    throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
  }

  return userId;
}

export function requireQueryParam(req: Request, name: string, message = `${name} is required`): string {
  const value = typeof req.query[name] === "string" ? req.query[name].trim() : "";
  if (!value) {
    throw new ApiRouteError(400, "invalid_request", message);
  }

  return value;
}

export function requireRouteParam(req: Request, name: string, message = `${name} is required`): string {
  const value = req.params[name]?.trim() ?? "";
  if (!value) {
    throw new ApiRouteError(400, "invalid_request", message);
  }

  return value;
}

export function handleProxyError(res: Response, error: unknown) {
  if (error instanceof RuntimeTargetError) {
    return res.status(error.statusCode).json(
      errorPayload(error.code, error.message, {
        retriable: error.retriable,
      }),
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    return res.status(504).json(errorPayload("orchestrator_timeout", "Orchestrator request timed out"));
  }

  return res
    .status(502)
    .json(errorPayload("orchestrator_unreachable", "Could not reach orchestration layer", String(error)));
}

export function handleLauncherError(res: Response, error: unknown) {
  const mapped = mapLauncherError(error);
  return res.status(mapped.status).json(mapped.body);
}

export function mapLauncherError(error: unknown) {
  if (error instanceof LauncherTimeoutError) {
    return {
      status: 504,
      body: errorPayload("launcher_timeout", "Launcher request timed out", {
        method: error.method,
        path: error.path,
        timeout_ms: error.timeoutMs,
      }),
    };
  }

  if (error instanceof LauncherNetworkError) {
    return {
      status: 502,
      body: errorPayload("launcher_unreachable", "Could not reach launcher", {
        method: error.method,
        path: error.path,
        cause: String(error.cause),
      }),
    };
  }

  if (error instanceof LauncherResponseParseError) {
    return {
      status: 502,
      body: errorPayload("launcher_contract_error", "Launcher returned an unexpected response", {
        method: error.method,
        path: error.path,
      }),
    };
  }

  if (error instanceof LauncherHttpError) {
    const code = error.kind === "config" ? "launcher_config_error" : "launcher_process_error";
    const message =
      error.kind === "config" ? "Launcher rejected the request" : "Launcher failed to process the request";
    const status = error.kind === "config" ? error.status : 502;

    return {
      status,
      body: errorPayload(code, message, {
        method: error.method,
        path: error.path,
        launcher_status: error.status,
        launcher_error: error.body,
      }),
    };
  }

  return {
    status: 502,
    body: errorPayload("launcher_unreachable", "Could not reach launcher", String(error)),
  };
}
