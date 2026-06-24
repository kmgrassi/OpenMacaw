import { describe, expect, it, vi } from "vitest";

import type { ApiRouteError } from "../../http.js";
import { listStoredAgentsFromSupabase } from "../../services/stored-agent-management.js";

import { requireStoredAgent } from "./authz.js";

vi.mock("../../services/stored-agent-management.js", () => ({
  listStoredAgentsFromSupabase: vi.fn(),
}));

describe("requireStoredAgent", () => {
  it("forwards the authenticated user context when loading stored agents", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([
      {
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "Agent",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        hasCredentials: false,
        isResolved: true,
        configurationStatus: null,
        runnerKind: null,
        planningDestination: null,
        localModelCoding: null,
        customTarget: null,
      },
    ]);

    const agent = await requireStoredAgent({
      accessToken: "token-1",
      userId: "user-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });

    expect(agent.id).toBe("agent-1");
    expect(listStoredAgentsFromSupabase).toHaveBeenCalledWith({
      accessToken: "token-1",
      userId: "user-1",
    });
  });

  it("rejects agents outside the requested workspace", async () => {
    vi.mocked(listStoredAgentsFromSupabase).mockResolvedValue([
      {
        id: "agent-1",
        workspaceId: "workspace-2",
        name: "Agent",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        hasCredentials: false,
        isResolved: true,
        configurationStatus: null,
        runnerKind: null,
        planningDestination: null,
        localModelCoding: null,
        customTarget: null,
      },
    ]);

    await expect(
      requireStoredAgent({
        accessToken: "token-1",
        userId: "user-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_not_found",
    } satisfies Partial<ApiRouteError>);
  });
});
