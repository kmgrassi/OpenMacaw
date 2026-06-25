import { describe, expect, it } from "vitest";

import {
  AgentLiveInputRequestSchema,
  AgentLiveInterruptRequestSchema,
  AgentLiveStreamEventSchema,
  AgentLiveStreamQuerySchema,
} from "../../../../contracts/agent-live-io.js";
import { agentLiveInputRoute, agentLiveInterruptRoute, agentLiveStreamRoute } from "../../../../contracts/routes.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("agent live I/O contracts", () => {
  it("validates live input and interrupt request shapes", () => {
    expect(
      AgentLiveInputRequestSchema.safeParse({
        workspaceId,
        message: "continue",
        sessionKey: `agent:${agentId}:main`,
        metadata: { source: "test" },
      }).success,
    ).toBe(true);
    expect(AgentLiveInputRequestSchema.safeParse({ workspaceId, message: "" }).success).toBe(false);

    expect(
      AgentLiveInterruptRequestSchema.safeParse({
        workspaceId,
        sessionKey: `agent:${agentId}:main`,
        reason: "stop",
      }).success,
    ).toBe(true);
  });

  it("validates stream query and event shapes", () => {
    expect(
      AgentLiveStreamQuerySchema.safeParse({
        workspaceId,
        sessionKey: `agent:${agentId}:main`,
      }).success,
    ).toBe(true);

    expect(
      AgentLiveStreamEventSchema.safeParse({
        type: "tool_activity",
        agentId,
        workspaceId,
        sequence: 1,
        payload: { toolName: "shell.exec", state: "running" },
      }).success,
    ).toBe(true);
  });

  it("builds the phase C route helpers", () => {
    expect(agentLiveInputRoute(agentId)).toBe(`/api/agents/${agentId}/input`);
    expect(agentLiveInterruptRoute(agentId)).toBe(`/api/agents/${agentId}/interrupt`);
    expect(agentLiveStreamRoute(agentId, { workspaceId, sessionKey: `agent:${agentId}:main` })).toBe(
      `/api/agents/${agentId}/stream?workspaceId=${workspaceId}&sessionKey=agent%3A${agentId}%3Amain`,
    );
  });
});
