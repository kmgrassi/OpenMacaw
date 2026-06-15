import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRequestContext } from "../middleware/request-context.js";
import { createLauncherClient, LauncherNetworkError, type StartWorkerBridgeSessionRequest } from "./launcher.js";
import type { LauncherHttpError } from "./launcher.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("createLauncherClient", () => {
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    if (originalServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  it("retries 5xx responses with bounded backoff and logs each attempt", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(502, { error: "temporary_failure" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: "launcher" }));
    const logger = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      logger,
      sleep,
    });

    await expect(client.getHealth()).resolves.toEqual({
      ok: true,
      service: "launcher",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(logger).toHaveBeenCalledTimes(4);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({
      event: "launcher_call_started",
      method: "GET",
      path: "/health",
      attempt: 1,
    });
    expect(logger.mock.calls[1]?.[0]).toMatchObject({
      event: "launcher_call_failed",
      method: "GET",
      path: "/health",
      attempt: 1,
      status: 502,
      ok: false,
    });
    expect(logger.mock.calls[2]?.[0]).toMatchObject({
      event: "launcher_call_started",
      method: "GET",
      path: "/health",
      attempt: 2,
    });
    expect(logger.mock.calls[3]?.[0]).toMatchObject({
      event: "launcher_call_completed",
      method: "GET",
      path: "/health",
      attempt: 2,
      status: 200,
      ok: true,
    });
  });

  it("propagates request correlation headers to launcher calls", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { ok: true, service: "launcher" }));
    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      sleep: vi.fn(),
      logger: vi.fn(),
    });

    await withRequestContext({ trace_id: "trc-test", request_id: "req-test" }, () => client.getHealth());

    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer service-role-key",
          "x-trace-id": "trc-test",
          "x-request-id": "req-test",
        }),
      }),
    );
  });

  it("retries network failures", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      sleep,
      logger: vi.fn(),
    });

    await expect(client.listAgents()).resolves.toEqual({ data: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("does not retry 4xx launcher config errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(422, { error: "invalid_env" }));

    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      sleep: vi.fn(),
      logger: vi.fn(),
    });

    await expect(
      client.createWorkerBridgeSession({
        kind: "codex",
        cwd: "/tmp/workspace",
        env: { RETRY_COUNT: "1" },
      } satisfies StartWorkerBridgeSessionRequest),
    ).rejects.toMatchObject({
      name: "LauncherHttpError",
      status: 422,
      kind: "config",
      message: "invalid_env",
    } satisfies Partial<LauncherHttpError>);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("preserves the upstream launcher status for POST responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(202, {
        data: {
          id: "orch_123",
          port: 4001,
          config: {},
          started_at: "2026-04-22T14:00:00Z",
          status: "running",
          reused: false,
        },
      }),
    );

    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      sleep: vi.fn(),
      logger: vi.fn(),
    });

    await expect(client.startAgent("agent-1")).resolves.toMatchObject({
      status: 202,
      data: {
        data: {
          id: "orch_123",
        },
      },
    });
  });

  it("raises a launcher network error after exhausting retries", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = createLauncherClient({
      baseUrl: "http://127.0.0.1:4100",
      timeoutMs: 500,
      fetchFn,
      sleep,
      logger: vi.fn(),
    });

    await expect(client.getAgent("agent-1")).rejects.toBeInstanceOf(LauncherNetworkError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });
});
