import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { apiFetch } from "./client";
import { ROUTES } from "./routes";
import { fetchRuntimeAgents } from "./runtime-agents";

const mockApiFetch = vi.mocked(apiFetch);

describe("runtime agent api helpers", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("loads runtime agents through apiFetch", async () => {
    const payload = { agents: [{ id: "agent-1" }] };
    mockApiFetch.mockResolvedValueOnce(payload);

    await expect(fetchRuntimeAgents()).resolves.toEqual(payload);

    expect(mockApiFetch).toHaveBeenCalledWith(
      ROUTES.agents,
      expect.objectContaining({
        method: "GET",
        defaultErrorMessage: expect.any(Function),
      }),
    );
  });
});
