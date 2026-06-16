import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import {
  buildOperabilityRemediationInstructions,
  ensureLearningSidecarScheduledTasks,
  findOpenOperabilityWorkItems,
  listOperabilityRemediationView,
  operabilitySignatureKey,
  operabilityWorkItemMetadata,
} from "./operability-remediation.js";

vi.mock("../../supabase-client.js", () => ({
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: null }>) => {
    const { data } = await query;
    return Array.isArray(data) ? data : data ? [data] : [];
  },
  getServiceRoleSupabase: vi.fn(),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const managerAgentId = "33333333-3333-4333-8333-333333333333";
const planningAgentId = "44444444-4444-4444-8444-444444444444";
const alternatePlanningAgentId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const signature = {
  toolSlug: "scheduled_task.create",
  errorCode: "database_error",
  agentType: "planning",
};

describe("operability remediation helpers", () => {
  let tables: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    tables = {
      work_items: [],
      memory_items: [],
      agent_tool_grant: [],
      workspace_settings: [],
      scheduled_task: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
  });

  it("builds stable signature metadata for planner-created work items", () => {
    expect(operabilitySignatureKey(signature)).toBe("tool:scheduled_task.create|error:database_error|agent:planning");
    expect(
      operabilityWorkItemMetadata({
        signature,
        sourceMemoryIds: ["memory-1", "memory-1", "memory-2"],
      }),
    ).toEqual({
      operability_remediation: {
        signature: "tool:scheduled_task.create|error:database_error|agent:planning",
        signature_parts: {
          tool_slug: "scheduled_task.create",
          error_code: "database_error",
          agent_type: "planning",
        },
        source_memory_ids: ["memory-1", "memory-2"],
      },
    });
  });

  it("instructs the planner to classify, dedup, route grants, and cap new work", () => {
    const instructions = buildOperabilityRemediationInstructions({
      maxNewWorkItems: 2,
      issues: [
        {
          signature,
          occurrenceCount: 3,
          sourceMemoryIds: ["memory-1", "memory-2", "memory-3"],
        },
      ],
    });

    expect(instructions).toContain("agent_tool_grant.create");
    expect(instructions).toContain("metadata.operability_remediation.signature");
    expect(instructions).toContain("Create at most 2 new remediation work items");
    expect(instructions).toContain("system_tool_grant_backoff");
  });

  it("finds existing open work items by operability signature", async () => {
    tables.work_items = [
      {
        id: "work-item-open",
        workspace_id: workspaceId,
        plan_id: "plan-1",
        title: "Fix scheduled task args",
        state: "todo",
        metadata: operabilityWorkItemMetadata({ signature, sourceMemoryIds: ["memory-1"] }),
        updated_at: "2026-06-15T12:00:00.000Z",
      },
      {
        id: "work-item-done",
        workspace_id: workspaceId,
        plan_id: "plan-1",
        title: "Done item",
        state: "done",
        metadata: operabilityWorkItemMetadata({ signature, sourceMemoryIds: ["memory-1"] }),
        updated_at: "2026-06-14T12:00:00.000Z",
      },
    ];

    await expect(findOpenOperabilityWorkItems({ workspaceId, signature })).resolves.toEqual([
      expect.objectContaining({ id: "work-item-open" }),
    ]);
  });

  it("returns recurring issue observability with open work items and recent system grants", async () => {
    tables.memory_items = [
      {
        id: "memory-1",
        workspace_id: workspaceId,
        content: "scheduled_task.create failed with due_at",
        tags: {
          kind: "operability",
          failure: "tool_call",
          tool_slug: "scheduled_task.create",
          error_code: "database_error",
          agent_type: "planning",
        },
        event_time: "2026-06-15T12:00:00.000Z",
        created_at: "2026-06-15T12:00:00.000Z",
        is_deleted: false,
      },
      {
        id: "memory-2",
        workspace_id: workspaceId,
        content: "scheduled_task.create failed again",
        tags: {
          kind: "operability",
          failure: "tool_call",
          tool_slug: "scheduled_task.create",
          error_code: "database_error",
          agent_type: "planning",
        },
        event_time: "2026-06-15T13:00:00.000Z",
        created_at: "2026-06-15T13:00:00.000Z",
        is_deleted: false,
      },
    ];
    tables.work_items = [
      {
        id: "work-item-open",
        workspace_id: workspaceId,
        plan_id: "plan-1",
        title: "Fix scheduled task args",
        state: "in_progress",
        metadata: operabilityWorkItemMetadata({ signature, sourceMemoryIds: ["memory-1", "memory-2"] }),
        updated_at: "2026-06-15T13:30:00.000Z",
      },
    ];
    tables.agent_tool_grant = [
      {
        id: "grant-1",
        agent_id: "agent-1",
        tool_id: "tool-1",
        workspace_id: workspaceId,
        mode: "include",
        source: "system",
        reason: "operability signature",
        updated_at: "2026-06-15T13:05:00.000Z",
      },
    ];

    await expect(listOperabilityRemediationView({ workspaceId, threshold: 2 })).resolves.toMatchObject({
      threshold: 2,
      recurringIssues: [
        {
          signature: "tool:scheduled_task.create|error:database_error|agent:planning",
          occurrenceCount: 2,
          sourceMemoryIds: ["memory-2", "memory-1"],
          openWorkItems: [expect.objectContaining({ id: "work-item-open" })],
        },
      ],
      recentAutonomousGrants: [expect.objectContaining({ id: "grant-1", source: "system" })],
    });
  });

  it("seeds learning sidecar scheduled tasks once for a learning-enabled workspace", async () => {
    tables.workspace_settings = [{ workspace_id: workspaceId, learning_enabled: true }];

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
      planningAgentId: alternatePlanningAgentId,
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
          instructions: expect.stringContaining(
            `/api/workspaces/${workspaceId}/learning/operability-remediation?threshold=2&limit=20`,
          ),
          delivery: {
            kind: "scheduled_agent_message",
            sessionStrategy: "scheduled_task",
            metadata: { kind: "learning_operability_remediation" },
          },
          metadata: { kind: "learning_operability_remediation", source: "workspace_learning_sidecar_seed" },
        }),
      ]),
    );
  });

  it("does not seed learning tasks when the workspace opted out", async () => {
    tables.workspace_settings = [{ workspace_id: workspaceId, learning_enabled: false }];

    await ensureLearningSidecarScheduledTasks({
      workspaceId,
      userId,
      managerAgentId,
      planningAgentId,
    });

    expect(tables.scheduled_task).toEqual([]);
  });
});
