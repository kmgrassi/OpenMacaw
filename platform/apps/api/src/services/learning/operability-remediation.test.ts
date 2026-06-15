import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import {
  buildOperabilityRemediationInstructions,
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
});
