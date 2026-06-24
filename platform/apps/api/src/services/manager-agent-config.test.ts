import { beforeEach, describe, expect, it, vi } from "vitest";

import { findStoredAgentRowById } from "../repositories/agents.js";
import { executeSupabaseRows, getUserScopedSupabase } from "../supabase-client.js";
import { getManagerAgentConfig, updateManagerAgentConfig } from "./manager-agent-config.js";

vi.mock("../repositories/agents.js", () => ({
  findStoredAgentRowById: vi.fn(),
}));

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  getServiceRoleSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn(() => "plan-query"),
        })),
      })),
    })),
  })),
  normalizeSupabaseError: vi.fn((context: string, error: Error) => new Error(`${context}: ${error.message}`)),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const managerAgentId = "33333333-3333-4333-8333-333333333333";
const planId = "44444444-4444-4444-8444-444444444444";

describe("manager agent config service", () => {
  let heartbeatRow: Record<string, unknown> | null;
  let upsertCalls: Array<{ payload: Record<string, unknown>; options: Record<string, unknown> | undefined }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    heartbeatRow = null;
    upsertCalls = [];
    vi.mocked(findStoredAgentRowById).mockResolvedValue({
      id: managerAgentId,
      name: "Manager",
      workspace_id: workspaceId,
      type: "manager",
      context: null,
      model_settings: {},
      tool_policy: {},
    });
    vi.mocked(executeSupabaseRows).mockResolvedValue([{ id: planId }]);
    vi.mocked(getUserScopedSupabase).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== "agent_heartbeat_config") throw new Error(`unexpected table: ${table}`);
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: heartbeatRow, error: null })),
              })),
            })),
          })),
          upsert: vi.fn((payload: Record<string, unknown>, options?: Record<string, unknown>) => {
            upsertCalls.push({ payload, options });
            const enabled = typeof heartbeatRow?.enabled === "boolean" ? heartbeatRow.enabled : true;
            heartbeatRow = {
              id: "heartbeat-config-1",
              agent_id: payload.agent_id,
              workspace_id: payload.workspace_id,
              enabled,
              policy_json: payload.policy_json,
              tasks_json: payload.tasks_json,
            };
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: heartbeatRow, error: null })),
              })),
            };
          }),
        };
      }),
    } as never);
  });

  it("reads per-agent scheduler policy from agent heartbeat config", async () => {
    heartbeatRow = {
      id: "heartbeat-config-1",
      agent_id: managerAgentId,
      workspace_id: workspaceId,
      enabled: true,
      policy_json: {
        cadence_ms: 30000,
      },
      tasks_json: [
        {
          kind: "due_work_items",
          filter: {
            states: ["running"],
            plan_ids: [planId],
          },
        },
      ],
    };

    await expect(
      getManagerAgentConfig({
        accessToken: "test-token",
        workspaceId,
        agentId: managerAgentId,
      }),
    ).resolves.toEqual({
      agentId: managerAgentId,
      cadenceMs: 30000,
      workspaceCadenceMs: null,
      dueTaskQuery: {
        states: ["running"],
        planIds: [planId],
      },
      workspaceDueTaskQuery: {},
      effectiveCadenceMs: 30000,
      effectiveDueTaskQuery: {
        states: ["running"],
        planIds: [planId],
      },
    });
  });

  it("writes scheduler policy to agent heartbeat config", async () => {
    const result = await updateManagerAgentConfig({
      accessToken: "test-token",
      userId,
      workspaceId,
      agentId: managerAgentId,
      request: {
        cadenceMs: 30000,
        dueTaskQuery: {
          states: ["running"],
          planIds: [planId],
        },
      },
    });

    expect(executeSupabaseRows).toHaveBeenCalledWith("manager config plan filter validation", "plan-query");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      options: { onConflict: "workspace_id,agent_id" },
      payload: {
        workspace_id: workspaceId,
        agent_id: managerAgentId,
        policy_json: {
          cadence_ms: 30000,
        },
        tasks_json: [
          {
            kind: "due_work_items",
            filter: {
              states: ["running"],
              plan_ids: [planId],
            },
          },
        ],
        updated_by: userId,
      },
    });
    expect(result).toMatchObject({
      cadenceMs: 30000,
      dueTaskQuery: {
        states: ["running"],
        planIds: [planId],
      },
    });
  });

  it("preserves disabled heartbeat rows when updating scheduler policy", async () => {
    heartbeatRow = {
      id: "heartbeat-config-1",
      agent_id: managerAgentId,
      workspace_id: workspaceId,
      enabled: false,
      policy_json: {},
      tasks_json: [],
    };

    const result = await updateManagerAgentConfig({
      accessToken: "test-token",
      userId,
      workspaceId,
      agentId: managerAgentId,
      request: {
        cadenceMs: 30000,
      },
    });

    expect(upsertCalls[0]?.payload).not.toHaveProperty("enabled");
    expect(heartbeatRow).toMatchObject({ enabled: false });
    expect(result).toMatchObject({ cadenceMs: 30000 });
  });

  it("removes cleared per-agent keys", async () => {
    heartbeatRow = {
      id: "heartbeat-config-1",
      agent_id: managerAgentId,
      workspace_id: workspaceId,
      enabled: true,
      policy_json: {
        cadence_ms: 30000,
      },
      tasks_json: [
        {
          kind: "due_work_items",
          filter: {
            states: ["running"],
          },
        },
      ],
    };

    await updateManagerAgentConfig({
      accessToken: "test-token",
      userId,
      workspaceId,
      agentId: managerAgentId,
      request: {
        cadenceMs: null,
        dueTaskQuery: null,
      },
    });

    expect(upsertCalls[0]?.payload).toMatchObject({
      policy_json: {},
      tasks_json: [],
    });
  });

  it("does not create empty heartbeat config for a clear request before activation", async () => {
    const result = await updateManagerAgentConfig({
      accessToken: "test-token",
      userId,
      workspaceId,
      agentId: managerAgentId,
      request: {
        cadenceMs: null,
        dueTaskQuery: null,
      },
    });

    expect(upsertCalls).toHaveLength(0);
    expect(result).toEqual({
      agentId: managerAgentId,
      cadenceMs: null,
      workspaceCadenceMs: null,
      dueTaskQuery: {},
      workspaceDueTaskQuery: {},
      effectiveCadenceMs: 60000,
      effectiveDueTaskQuery: {
        states: ["running", "awaiting_review"],
        planIds: null,
      },
    });
  });

  it("rejects plan ids outside the workspace", async () => {
    vi.mocked(executeSupabaseRows).mockResolvedValue([]);

    await expect(
      updateManagerAgentConfig({
        accessToken: "test-token",
        userId,
        workspaceId,
        agentId: managerAgentId,
        request: {
          dueTaskQuery: {
            planIds: [planId],
          },
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_plan_filter",
    });
    expect(upsertCalls).toHaveLength(0);
  });

  it("rejects empty plan filter overrides", async () => {
    await expect(
      updateManagerAgentConfig({
        accessToken: "test-token",
        userId,
        workspaceId,
        agentId: managerAgentId,
        request: {
          dueTaskQuery: {
            planIds: [],
          },
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_plan_filter",
    });

    expect(executeSupabaseRows).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(0);
  });
});
