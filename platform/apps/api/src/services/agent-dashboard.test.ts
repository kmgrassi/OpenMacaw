import { beforeEach, describe, expect, it, vi } from "vitest";

import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClient from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import { getAgentDashboardVersion } from "./agent-dashboard.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseClient>()),
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

const accessToken = "test-token";
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

function agent(workspace = workspaceId) {
  return {
    id: agentId,
    workspace_id: workspace,
    name: "Coding Agent",
    status: "ready",
    type: "coding" as const,
    context: null,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: userId,
    updated_at: "2026-04-26T12:00:00.000Z",
  };
}

describe("agent dashboard version service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(findSetupAgentById).mockResolvedValue(agent());
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        broker_run: [
          {
            run_id: "run-1",
            agent_id: agentId,
            created_at: "2026-04-26T12:00:00.000Z",
            updated_at: "2026-04-26T12:01:00.000Z",
          },
        ],
        broker_task: [
          {
            task_id: "task-1",
            run_id: "run-1",
            last_event_at: "2026-04-26T12:02:00.000Z",
            updated_at: "2026-04-26T12:02:30.000Z",
          },
        ],
        agent_tool_call_event: [
          {
            id: "tool-event-1",
            created_at: "2026-04-26T12:04:00.000Z",
            updated_at: "2026-04-26T12:04:30.000Z",
            run_id: "run-1",
          },
        ],
        gateway_config_state: [
          {
            scope_type: "agent",
            scope_id: agentId,
            sync_status: "synced",
            sync_error: null,
            last_apply_status: "applied",
            last_apply_error: null,
            last_apply_at: "2026-04-26T12:03:00.000Z",
            last_applied_version: 2,
            synced_at: "2026-04-26T12:03:10.000Z",
          },
        ],
      }) as never,
    );
  });

  it("returns a stable version for authorized dashboard polling", async () => {
    const result = await getAgentDashboardVersion({
      accessToken,
      userId,
      agentId,
      workspaceId,
    });

    expect(result.latestEventAt).toBe("2026-04-26T12:04:30.000Z");
    expect(result.pollAfterMs).toBe(5000);
    expect(JSON.parse(result.version)).toMatchObject({
      latestRun: ["run-1", "2026-04-26T12:01:00.000Z", "2026-04-26T12:00:00.000Z"],
      latestTask: ["task-1", "2026-04-26T12:02:30.000Z", "2026-04-26T12:02:00.000Z"],
      latestToolEvent: ["tool-event-1", "2026-04-26T12:04:30.000Z", "2026-04-26T12:04:00.000Z"],
    });
  });

  it("rejects polling for a mismatched workspace", async () => {
    await expect(
      getAgentDashboardVersion({
        accessToken,
        userId,
        agentId,
        workspaceId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "agent_dashboard_forbidden",
    });
  });

  it("maps missing workspace membership to forbidden", async () => {
    vi.mocked(assertWorkspaceMembership).mockRejectedValue(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    await expect(
      getAgentDashboardVersion({
        accessToken,
        userId,
        agentId,
        workspaceId,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workspace_forbidden",
    });
  });
});
