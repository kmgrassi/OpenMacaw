import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase } from "../../../supabase-client.js";
import { createMockSupabaseClient } from "../../../test-utils/supabase-client-mock.js";
import { setLearningMetaAgentScheduledTaskEnabled } from "./learning-agent.js";

vi.mock("../../../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";

function scheduledTask(overrides: Record<string, unknown>) {
  return {
    id: "task-1",
    workspace_id: workspaceId,
    enabled: true,
    next_run_at: "2026-06-20T03:30:00.000Z",
    delivery: { kind: "scheduled_agent_message" },
    metadata: {},
    updated_at: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("learning-agent scheduled task controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables current and legacy learning scheduled tasks", async () => {
    const tables = {
      scheduled_task: [
        scheduledTask({
          id: "new-learning",
          metadata: { kind: "learning_meta_agent_daily_review" },
        }),
        scheduledTask({
          id: "legacy-distillation",
          delivery: { kind: "learning_distillation" },
        }),
        scheduledTask({
          id: "legacy-operability",
          metadata: { kind: "learning_operability_remediation" },
        }),
        scheduledTask({
          id: "router",
          metadata: { kind: "router_optimization" },
        }),
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await setLearningMetaAgentScheduledTaskEnabled({
      workspaceId,
      enabled: false,
      now: new Date("2026-06-20T00:00:00.000Z"),
    });

    expect(tables.scheduled_task.find((row) => row.id === "new-learning")).toMatchObject({
      enabled: false,
      next_run_at: null,
    });
    expect(tables.scheduled_task.find((row) => row.id === "legacy-distillation")).toMatchObject({
      enabled: false,
      next_run_at: null,
    });
    expect(tables.scheduled_task.find((row) => row.id === "legacy-operability")).toMatchObject({
      enabled: false,
      next_run_at: null,
    });
    expect(tables.scheduled_task.find((row) => row.id === "router")).toMatchObject({
      enabled: true,
      next_run_at: "2026-06-20T03:30:00.000Z",
    });
  });

  it("only re-enables the current learning scheduled task", async () => {
    const tables = {
      scheduled_task: [
        scheduledTask({
          id: "new-learning",
          enabled: false,
          next_run_at: null,
          metadata: { kind: "learning_meta_agent_daily_review" },
        }),
        scheduledTask({
          id: "legacy-distillation",
          enabled: false,
          next_run_at: null,
          delivery: { kind: "learning_distillation" },
        }),
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);

    await setLearningMetaAgentScheduledTaskEnabled({
      workspaceId,
      enabled: true,
      now: new Date("2026-06-20T00:00:00.000Z"),
    });

    expect(tables.scheduled_task.find((row) => row.id === "new-learning")).toMatchObject({
      enabled: true,
      next_run_at: "2026-06-20T03:30:00.000Z",
    });
    expect(tables.scheduled_task.find((row) => row.id === "legacy-distillation")).toMatchObject({
      enabled: false,
      next_run_at: null,
    });
  });
});
