import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase } from "../../supabase-client.js";
import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { ensureLearningSidecarScheduledTasks, listRecurringOperabilityFindings } from "./operability-remediation.js";

vi.mock("../../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const managerAgentId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "33333333-3333-4333-8333-333333333333";
const codingAgentId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

function setupSupabaseMock(tables: Record<string, Row[]>) {
  const supabase = createMockSupabaseClient(tables);
  vi.mocked(getServiceRoleSupabase).mockReturnValue(supabase as never);
  return tables;
}

function operabilityMemory(overrides: Partial<Row>): Row {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    workspace_id: workspaceId,
    agent_id: codingAgentId,
    content: "scheduled_task.create failed because due_at is not a valid column.",
    tags: {
      kind: "operability",
      failure: "tool_call",
      tool_slug: "scheduled_task.create",
      error_code: "db_column_not_found",
    },
    importance: 8,
    event_time: "2026-06-14T12:00:00.000Z",
    source_run_id: "run-1",
    source_task_id: "task-1",
    is_deleted: false,
    ...overrides,
  };
}

describe("learning operability remediation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups recurring operability memories by tool, error, and agent type with event context", async () => {
    setupSupabaseMock({
      memory_items: [
        operabilityMemory({ id: "66666666-6666-4666-8666-666666666661", source_run_id: "run-1" }),
        operabilityMemory({ id: "66666666-6666-4666-8666-666666666662", source_run_id: "run-2" }),
        operabilityMemory({
          id: "66666666-6666-4666-8666-666666666663",
          source_run_id: "run-3",
          event_time: "2026-06-13T12:00:00.000Z",
        }),
        operabilityMemory({
          id: "66666666-6666-4666-8666-666666666664",
          tags: { kind: "workspace_fact" },
          source_run_id: "run-4",
        }),
      ],
      agent: [{ id: codingAgentId, type: "coding" }],
      agent_tool_call_event: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          run_id: "run-2",
          tool_slug: "scheduled_task.create",
          status: "error",
          error_code: "db_column_not_found",
          error_message: "column due_at does not exist",
          approval_state: null,
          output_summary: null,
          started_at: "2026-06-14T12:01:00.000Z",
        },
      ],
    });

    await expect(
      listRecurringOperabilityFindings({
        workspaceId,
        threshold: 3,
        windowDays: 7,
        now: new Date("2026-06-15T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      workspaceId,
      threshold: 3,
      windowDays: 7,
      findings: [
        {
          signature: "scheduled_task.create|db_column_not_found|coding",
          toolSlug: "scheduled_task.create",
          errorCode: "db_column_not_found",
          agentType: "coding",
          count: 3,
          sourceRunIds: ["run-1", "run-2", "run-3"],
          toolEvents: [
            {
              id: "77777777-7777-4777-8777-777777777777",
              runId: "run-2",
              toolSlug: "scheduled_task.create",
              status: "error",
              errorCode: "db_column_not_found",
              errorMessage: "column due_at does not exist",
            },
          ],
        },
      ],
    });
  });

  it("seeds distillation and planning-agent remediation tasks once per learning-enabled workspace", async () => {
    const tables = setupSupabaseMock({
      workspace_settings: [{ workspace_id: workspaceId, learning_enabled: true }],
      scheduled_task: [],
    });

    await ensureLearningSidecarScheduledTasks({
      workspaceId,
      userId,
      managerAgentId,
      planningAgentId,
      now: new Date("2026-06-15T00:00:00.000Z"),
    });
    await ensureLearningSidecarScheduledTasks({
      workspaceId,
      userId,
      managerAgentId,
      planningAgentId,
      now: new Date("2026-06-15T00:00:00.000Z"),
    });

    expect(tables.scheduled_task).toHaveLength(2);
    expect(tables.scheduled_task).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspaceId,
          agent_id: managerAgentId,
          title: "Nightly learning distillation",
          delivery: { kind: "learning_distillation", windowDays: 7 },
        }),
        expect.objectContaining({
          workspace_id: workspaceId,
          agent_id: planningAgentId,
          title: "Learning operability remediation",
          delivery: {
            kind: "scheduled_agent_message",
            sessionStrategy: "scheduled_task",
            metadata: { kind: "learning_operability_remediation" },
          },
        }),
      ]),
    );
  });

  it("does not seed learning tasks when the workspace opted out", async () => {
    const tables = setupSupabaseMock({
      workspace_settings: [{ workspace_id: workspaceId, learning_enabled: false }],
      scheduled_task: [],
    });

    await ensureLearningSidecarScheduledTasks({
      workspaceId,
      userId,
      managerAgentId,
      planningAgentId,
    });

    expect(tables.scheduled_task).toEqual([]);
  });
});
