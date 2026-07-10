import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

const { listLocalRuntimeEventsForWorkspace } = await import("./local-runtime-machines.js");

describe("listLocalRuntimeEventsForWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("clamps the requested limit and returns the newest events first", async () => {
    const workspaceId = "workspace-1";
    const tables = {
      local_runtime_machine: [
        {
          id: "machine-1",
          workspace_id: workspaceId,
          revoked_at: null,
        },
      ],
      local_runtime_event: [
        {
          id: "event-1",
          machine_id: "machine-1",
          workspace_id: workspaceId,
          kind: "helper_connected",
          detail: { step: 1 },
          created_at: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "event-2",
          machine_id: "machine-1",
          workspace_id: workspaceId,
          kind: "helper_connected",
          detail: { step: 2 },
          created_at: "2026-07-10T01:00:00.000Z",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await expect(listLocalRuntimeEventsForWorkspace(workspaceId, "machine-1", 999)).resolves.toEqual({
      events: [
        {
          id: "event-2",
          machineId: "machine-1",
          workspaceId,
          kind: "helper_connected",
          detail: { step: 2 },
          createdAt: "2026-07-10T01:00:00.000Z",
        },
        {
          id: "event-1",
          machineId: "machine-1",
          workspaceId,
          kind: "helper_connected",
          detail: { step: 1 },
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns not found before reading events for revoked or missing machines", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        local_runtime_machine: [],
        local_runtime_event: [],
      }) as never,
    );

    await expect(listLocalRuntimeEventsForWorkspace("workspace-1", "missing-machine", 10)).rejects.toMatchObject({
      status: 404,
      code: "local_runtime_machine_not_found",
    });
  });
});
