import { describe, expect, it, vi } from "vitest";

import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import type { LauncherClient } from "./launcher.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { getToolsForAgent } from "./agent-tools.js";
import { buildAgentDispatchDryRun, runAgentDispatchLive } from "./agent-dispatch-probe.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";

vi.mock("./execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("./agent-tools.js", () => ({
  getToolsForAgent: vi.fn(),
}));

vi.mock("../repositories/agents.js", () => ({
  findSetupAgentById: vi.fn(),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const credentialId = "44444444-4444-4444-8444-444444444444";

function codexProfile(): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "coding" },
    profile: {
      agentId,
      workspaceId,
      role: "coding",
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5",
      credentialRef: { type: "credential_id", value: credentialId },
      fallbacks: [],
      modelTierFloor: "any",
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
        interrupt: true,
      },
    },
    missing: [],
    source: {
      routingRuleId: "55555555-5555-4555-8555-555555555555",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

function setupMocks() {
  vi.mocked(resolveExecutionProfile).mockResolvedValue(codexProfile());
  vi.mocked(getToolsForAgent).mockResolvedValue([]);
  vi.mocked(findSetupAgentById).mockResolvedValue({
    id: agentId,
    workspace_id: workspaceId,
    name: "Coding Agent",
    status: "active",
    type: "coding",
    context: null,
    model_settings: {},
    tool_policy: {},
    created_by_user_id: userId,
    updated_at: "2026-05-13T12:00:00.000Z",
  });
}

describe("agent dispatch probe service", () => {
  it("returns the actual launcher body for non-local dry-runs", async () => {
    setupMocks();

    const result = await buildAgentDispatchDryRun({
      accessToken: "test-token",
      requesterUserId: userId,
      agentId,
      workspaceId,
    });

    expect(result.runtimePayload.body).toEqual({
      agent_id: agentId,
      workspace_id: workspaceId,
    });
  });

  it("live-run posts the same body reported by dry-run", async () => {
    setupMocks();
    const startAgent = vi.fn().mockResolvedValue({
      data: {
        data: {
          id: "runtime-1",
          port: 4100,
          config: {
            runnerKind: "codex",
            provider: "openai",
            model: "gpt-5",
            toolProfile: "coding",
          },
          started_at: "2026-05-13T12:00:00.000Z",
          status: "running",
          reused: false,
          agent_id: agentId,
          workspace_id: workspaceId,
        },
      },
      status: 200,
    });

    const result = await runAgentDispatchLive({
      accessToken: "test-token",
      requesterUserId: userId,
      agentId,
      workspaceId,
      launcherClient: { startAgent } as unknown as LauncherClient,
    });

    expect(startAgent).toHaveBeenCalledWith(agentId, {
      agent_id: agentId,
      workspace_id: workspaceId,
    });
    expect(result.status).toBe("matched");
  });
});
