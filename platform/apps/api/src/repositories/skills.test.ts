import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

const { getServiceRoleSupabase } = vi.mocked(await import("../supabase-client.js"));
const { resolveApprovedSkillsSnapshot } = await import("./skills.js");

const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("skills repository", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns approved skills for the target agent as a materialization snapshot", async () => {
    getServiceRoleSupabase.mockReturnValue(
      createMockSupabaseClient({
        skill: [
          {
            id: "skill-2",
            workspace_id: workspaceId,
            agent_id: agentId,
            name: "z-last",
            description: "Use last",
            body: "Use last.",
            status: "approved",
            copied_from_skill_id: null,
            created_by_agent_id: null,
            created_by_user_id: null,
            source_run_id: null,
            created_at: "2026-06-19T00:00:00.000Z",
            updated_at: "2026-06-19T00:00:00.000Z",
          },
          {
            id: "skill-1",
            workspace_id: workspaceId,
            agent_id: agentId,
            name: "a-first",
            description: "Use first",
            body: "Use first.",
            status: "approved",
            copied_from_skill_id: null,
            created_by_agent_id: null,
            created_by_user_id: null,
            source_run_id: null,
            created_at: "2026-06-20T00:00:00.000Z",
            updated_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "draft-skill",
            workspace_id: workspaceId,
            agent_id: agentId,
            name: "draft",
            description: "Draft",
            body: "Draft.",
            status: "draft",
            copied_from_skill_id: null,
            created_by_agent_id: null,
            created_by_user_id: null,
            source_run_id: null,
            created_at: "2026-06-20T00:00:00.000Z",
            updated_at: "2026-06-20T00:00:00.000Z",
          },
          {
            id: "other-agent-skill",
            workspace_id: workspaceId,
            agent_id: "other-agent",
            name: "other",
            description: "Other",
            body: "Other.",
            status: "approved",
            copied_from_skill_id: null,
            created_by_agent_id: null,
            created_by_user_id: null,
            source_run_id: null,
            created_at: "2026-06-20T00:00:00.000Z",
            updated_at: "2026-06-20T00:00:00.000Z",
          },
        ],
      }) as never,
    );

    await expect(resolveApprovedSkillsSnapshot({ agentId, workspaceId })).resolves.toEqual({
      version: 1,
      agentId,
      workspaceId,
      skills: [
        {
          id: "skill-1",
          name: "a-first",
          description: "Use first",
          body: "Use first.",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
        {
          id: "skill-2",
          name: "z-last",
          description: "Use last",
          body: "Use last.",
          updatedAt: "2026-06-19T00:00:00.000Z",
        },
      ],
    });
  });
});
