import {
  LauncherAgentListResponseSchema,
  LauncherAgentResponseSchema,
  LauncherHealthResponseSchema,
  LauncherOrchestratorListResponseSchema,
  LauncherOrchestratorResponseSchema,
  LauncherStoredCredentialListResponseSchema,
} from "../../../../contracts/launcher.js";
import {
  WorkerBridgeSessionRowListResponseSchema,
  WorkerBridgeSessionRowResponseSchema,
} from "../../../../contracts/worker-bridge.js";
import { z } from "zod";

import { logEvent } from "../logger.js";
import { contextHeaders } from "../middleware/request-context.js";
import { internalServiceRoleHeaders } from "./internal-service-auth.js";

const WorkerCredentialSourceSchema = z.union([
  z.object({
    source: z.literal("inline"),
    value: z.string(),
  }),
  z.object({
    source: z.literal("env"),
    name: z.string(),
  }),
]);

const WorkerRepositorySchema = z.object({
  url: z.string().min(1),
  ref: z.string().min(1).optional(),
});

export const StartWorkerBridgeSessionRequestSchema = z
  .object({
    kind: z.literal("codex"),
    cwd: z.string().min(1).optional(),
    repository: WorkerRepositorySchema.optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    credentials: z.record(z.string(), WorkerCredentialSourceSchema).optional(),
    agent_id: z.string().min(1).optional(),
    workspace_id: z.string().min(1).optional(),
    credential_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasIdentityLaunch = Boolean(value.agent_id || value.workspace_id || value.credential_id);
    const hasWorkspaceSource = Boolean(value.cwd || value.repository || hasIdentityLaunch);

    if (!hasWorkspaceSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cwd, repository, or agent launch identity is required",
      });
    }

    if (hasIdentityLaunch && !(value.agent_id && value.workspace_id && value.credential_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent_id, workspace_id, and credential_id are required together",
      });
    }
  });

export type StartWorkerBridgeSessionRequest = z.infer<typeof StartWorkerBridgeSessionRequestSchema>;

type LauncherLogger = (event: Record<string, unknown>) => void;
type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;

type LauncherResponse<T> = {
  status: number;
  data: T;
};

type RequestOptions<T> = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  schema: { parse(data: unknown): T };
  body?: unknown;
};

type LauncherClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
  logger?: LauncherLogger;
  sleep?: SleepLike;
  retryBaseDelayMs?: number;
  maxAttempts?: number;
};

type LauncherFailureKind = "config" | "process";

export class LauncherHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly method: string;
  readonly kind: LauncherFailureKind;
  readonly body: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      path: string;
      method: string;
      kind: LauncherFailureKind;
      body: unknown;
    },
  ) {
    super(message);
    this.name = "LauncherHttpError";
    this.status = options.status;
    this.path = options.path;
    this.method = options.method;
    this.kind = options.kind;
    this.body = options.body;
  }
}

export class LauncherTimeoutError extends Error {
  readonly path: string;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(path: string, method: string, timeoutMs: number) {
    super(`Launcher request timed out after ${timeoutMs}ms`);
    this.name = "LauncherTimeoutError";
    this.path = path;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class LauncherNetworkError extends Error {
  readonly path: string;
  readonly method: string;

  constructor(path: string, method: string, cause: unknown) {
    super("Could not reach launcher");
    this.name = "LauncherNetworkError";
    this.path = path;
    this.method = method;
    this.cause = cause;
  }
}

export class LauncherResponseParseError extends Error {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;

  constructor(path: string, method: string, body: unknown, cause: unknown) {
    super("Launcher response did not match the expected contract");
    this.name = "LauncherResponseParseError";
    this.path = path;
    this.method = method;
    this.body = body;
    this.cause = cause;
  }
}

export type LauncherClient = ReturnType<typeof createLauncherClient>;

function defaultLogger(event: Record<string, unknown>) {
  logEvent(event as Record<string, unknown> & { event: string });
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseErrorMessage(body: unknown): string {
  if (typeof body === "string" && body.trim().length > 0) return body;
  if (body && typeof body === "object" && "error" in body) {
    const errorValue = (body as { error?: unknown }).error;
    if (typeof errorValue === "string" && errorValue.trim().length > 0) return errorValue;
  }
  return "launcher request failed";
}

function shouldRetryStatus(status: number) {
  return status >= 500;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createLauncherClient({
  baseUrl,
  timeoutMs,
  fetchFn = fetch,
  logger = defaultLogger,
  sleep = defaultSleep,
  retryBaseDelayMs = 200,
  maxAttempts = 3,
}: LauncherClientOptions) {
  async function request<T>({ method, path, schema, body }: RequestOptions<T>): Promise<LauncherResponse<T>> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        logger({
          event: "launcher_call_started",
          method,
          path,
          attempt,
        });

        const response = await fetchFn(`${baseUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: internalServiceRoleHeaders({
            "content-type": "application/json",
            ...contextHeaders(),
          }),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const responseBody = await parseResponseBody(response);
        const durationMs = Date.now() - startedAt;

        logger({
          event: response.ok ? "launcher_call_completed" : "launcher_call_failed",
          level: response.ok ? "info" : "error",
          method,
          path,
          attempt,
          duration_ms: durationMs,
          status: response.status,
          ok: response.ok,
        });

        if (!response.ok) {
          const error = new LauncherHttpError(parseErrorMessage(responseBody), {
            status: response.status,
            path,
            method,
            kind: response.status >= 400 && response.status < 500 ? "config" : "process",
            body: responseBody,
          });

          if (shouldRetryStatus(response.status) && attempt < maxAttempts) {
            lastError = error;
            await sleep(Math.min(retryBaseDelayMs * 2 ** (attempt - 1), 1_000));
            continue;
          }

          throw error;
        }

        try {
          return {
            status: response.status,
            data: schema.parse(responseBody),
          };
        } catch (error) {
          throw new LauncherResponseParseError(path, method, responseBody, error);
        }
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const normalizedError =
          error instanceof LauncherHttpError ||
          error instanceof LauncherResponseParseError ||
          error instanceof LauncherTimeoutError ||
          error instanceof LauncherNetworkError
            ? error
            : error instanceof Error && error.name === "AbortError"
              ? new LauncherTimeoutError(path, method, timeoutMs)
              : new LauncherNetworkError(path, method, error);

        if (!(normalizedError instanceof LauncherHttpError)) {
          logger({
            event: "launcher_call_failed",
            level: "error",
            method,
            path,
            attempt,
            duration_ms: durationMs,
            ok: false,
            error_name: normalizedError.name,
            error_message: normalizedError.message,
          });
        }

        const retryable =
          normalizedError instanceof LauncherTimeoutError ||
          normalizedError instanceof LauncherNetworkError ||
          (normalizedError instanceof LauncherHttpError && shouldRetryStatus(normalizedError.status));

        if (retryable && attempt < maxAttempts) {
          lastError = normalizedError;
          await sleep(Math.min(retryBaseDelayMs * 2 ** (attempt - 1), 1_000));
          continue;
        }

        throw normalizedError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("launcher request failed");
  }

  return {
    async getHealth() {
      const result = await request({
        method: "GET",
        path: "/health",
        schema: LauncherHealthResponseSchema,
      });
      return result.data;
    },

    async listAgents() {
      const result = await request({
        method: "GET",
        path: "/agents",
        schema: LauncherAgentListResponseSchema,
      });
      return result.data;
    },

    async getAgent(id: string) {
      const result = await request({
        method: "GET",
        path: `/agents/${encodeURIComponent(id)}`,
        schema: LauncherAgentResponseSchema,
      });
      return result.data;
    },

    async getAgentCredentials(id: string) {
      const result = await request({
        method: "GET",
        path: `/agents/${encodeURIComponent(id)}/credentials`,
        schema: LauncherStoredCredentialListResponseSchema,
      });
      return result.data;
    },

    async startAgent(id: string, body?: unknown) {
      return request({
        method: "POST",
        path: `/agents/${encodeURIComponent(id)}/start`,
        schema: LauncherOrchestratorResponseSchema,
        body,
      });
    },

    async listOrchestrators() {
      const result = await request({
        method: "GET",
        path: "/orchestrators",
        schema: LauncherOrchestratorListResponseSchema,
      });
      return result.data;
    },

    async stopOrchestrator(id: string) {
      return request({
        method: "DELETE",
        path: `/orchestrators/${encodeURIComponent(id)}`,
        schema: LauncherOrchestratorResponseSchema,
      });
    },

    async createWorkerBridgeSession(body: StartWorkerBridgeSessionRequest) {
      return request({
        method: "POST",
        path: "/worker-bridge/sessions",
        schema: WorkerBridgeSessionRowResponseSchema,
        body: StartWorkerBridgeSessionRequestSchema.parse(body),
      });
    },

    async listWorkerBridgeSessions() {
      const result = await request({
        method: "GET",
        path: "/worker-bridge/sessions",
        schema: WorkerBridgeSessionRowListResponseSchema,
      });
      return result.data;
    },

    async getWorkerBridgeSession(id: string) {
      const result = await request({
        method: "GET",
        path: `/worker-bridge/sessions/${encodeURIComponent(id)}`,
        schema: WorkerBridgeSessionRowResponseSchema,
      });
      return result.data;
    },

    async deleteWorkerBridgeSession(id: string) {
      const result = await request({
        method: "DELETE",
        path: `/worker-bridge/sessions/${encodeURIComponent(id)}`,
        schema: WorkerBridgeSessionRowResponseSchema,
      });
      return result.data;
    },
  };
}
