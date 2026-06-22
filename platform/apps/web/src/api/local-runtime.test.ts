import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./workspace-scoped-fetch", () => ({
  workspaceScopedFetch: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { workspaceScopedFetch } from "./workspace-scoped-fetch";
const mockWorkspaceScopedFetch = vi.mocked(workspaceScopedFetch);

import {
  assignLocalModelToAgent,
  getLocalRuntimeConfig,
  listLocalRuntimeEvents,
  listLocalRuntimes,
  probeLocalModel,
  probeRegisteredLocalRuntimeRunner,
  registerLocalRuntime,
  removeLocalRuntime,
  rotateLocalRuntimeToken,
  testLocalRuntimeDispatch,
} from "./local-runtime";

describe("local-runtime api", () => {
  beforeEach(() => {
    mockWorkspaceScopedFetch.mockReset();
  });

  it("returns parsed JSON for successful list requests", async () => {
    mockWorkspaceScopedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ runtimes: [], heartbeatIntervalMs: 30000 }), {
        status: 200,
      }),
    );

    await expect(listLocalRuntimes("ws_123")).resolves.toEqual({
      runtimes: [],
      heartbeatIntervalMs: 30000,
    });
    expect(mockWorkspaceScopedFetch).toHaveBeenCalledWith(
      "ws_123",
      "/api/local-runtime/runtimes",
      undefined,
    );
  });

  it("forwards request init for JSON endpoints", async () => {
    mockWorkspaceScopedFetch.mockImplementation(
      async () => new Response("{}", { status: 200 }),
    );

    await registerLocalRuntime("ws_123", {
      machineDisplayName: "Laptop",
      runners: [{ kind: "openclaw", endpoint: "http://127.0.0.1:4000" }],
    });
    await probeLocalModel("ws_123", {
      endpoint: "http://127.0.0.1:11434",
      model: "gpt-oss",
    });
    await probeRegisteredLocalRuntimeRunner("ws_123", "runner_1");
    await getLocalRuntimeConfig("ws_123", "machine_1");
    await listLocalRuntimeEvents("ws_123", "machine_1", 25);
    await testLocalRuntimeDispatch("ws_123", "machine_1");
    await rotateLocalRuntimeToken("ws_123", "machine_1");
    await assignLocalModelToAgent("ws_123", "agent_1", {
      machineId: "machine_1",
      localRuntimeId: "runtime_1",
    });

    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      1,
      "ws_123",
      "/api/local-runtime/runtimes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineDisplayName: "Laptop",
          runners: [{ kind: "openclaw", endpoint: "http://127.0.0.1:4000" }],
        }),
      },
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      2,
      "ws_123",
      "/api/local-runtime/runtimes/probe",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: "http://127.0.0.1:11434",
          model: "gpt-oss",
        }),
      },
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      3,
      "ws_123",
      "/api/local-runtime/runtimes/runners/runner_1/probe",
      { method: "POST" },
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      4,
      "ws_123",
      "/api/local-runtime/runtimes/machine_1/config",
      undefined,
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      5,
      "ws_123",
      "/api/local-runtime/runtimes/machine_1/events?limit=25",
      undefined,
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      6,
      "ws_123",
      "/api/local-runtime/runtimes/machine_1/test-dispatch",
      { method: "POST" },
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      7,
      "ws_123",
      "/api/local-runtime/runtimes/machine_1/rotate-token",
      { method: "POST" },
    );
    expect(mockWorkspaceScopedFetch).toHaveBeenNthCalledWith(
      8,
      "ws_123",
      "/api/agents/agent_1/assign-local-model",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          machineId: "machine_1",
          localRuntimeId: "runtime_1",
        }),
      },
    );
  });

  it("throws the existing action-specific error messages with response body", async () => {
    mockWorkspaceScopedFetch.mockResolvedValueOnce(
      new Response("invalid", { status: 503 }),
    );

    await expect(listLocalRuntimes("ws_123")).rejects.toThrow(
      "Failed to list local runtimes (503): invalid",
    );
  });

  it("throws action-specific error messages without a response body", async () => {
    mockWorkspaceScopedFetch.mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );

    await expect(removeLocalRuntime("ws_123", "machine_1")).rejects.toThrow(
      "Failed to remove local runtime (500)",
    );
  });
});
