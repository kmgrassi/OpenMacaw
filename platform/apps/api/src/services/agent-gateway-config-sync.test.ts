import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import {
  writeGatewayConfigForDefaultAgent,
  writeGatewayConfigForManagerAgent,
} from "./setup/store/gateway-config-writer.js";

vi.mock("../repositories/agents.js", () => ({
  findSetupAgentById: vi.fn(),
}));

vi.mock("./execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("./setup/store/gateway-config-writer.js", () => ({
  writeGatewayConfigForDefaultAgent: vi.fn(),
  writeGatewayConfigForManagerAgent: vi.fn(),
}));

const { syncAgentGatewayConfigForExecutionProfile } = await import("./agent-gateway-config-sync.js");

const agent = {
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Agent",
  status: "active",
  type: "coding",
  context: null,
  model_settings: { primary: "openai/gpt-5.2" },
  tool_policy: {},
  created_by_user_id: "user-1",
  updated_at: "2026-06-10T00:00:00.000Z",
};

function resolution(overrides: Partial<ExecutionProfileResolution> = {}): ExecutionProfileResolution {
  return {
    agent: {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      role: "coding",
    },
    profile: {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      role: "coding",
      runnerKind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
      credentialRef: null,
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
      routingRuleId: "rule-1",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
    ...overrides,
  };
}

describe("syncAgentGatewayConfigForExecutionProfile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findSetupAgentById).mockResolvedValue(agent);
  });

  it("writes default-agent gateway config from the resolved execution profile", async () => {
    vi.mocked(resolveExecutionProfile).mockResolvedValue(resolution());

    await expect(
      syncAgentGatewayConfigForExecutionProfile({
        accessToken: "token-1",
        userId: "user-1",
        agentId: "agent-1",
      }),
    ).resolves.toMatchObject({ changed: true });

    expect(writeGatewayConfigForDefaultAgent).toHaveBeenCalledWith(
      "token-1",
      "user-1",
      agent,
      "coding",
      "openai",
      "openai/gpt-5.2",
      "codex",
    );
    expect(writeGatewayConfigForManagerAgent).not.toHaveBeenCalled();
  });

  it("writes manager gateway config for manager profiles", async () => {
    vi.mocked(resolveExecutionProfile).mockResolvedValue(
      resolution({
        agent: { agentId: "agent-1", workspaceId: "workspace-1", role: "manager" },
        profile: {
          ...resolution().profile!,
          role: "manager",
          runnerKind: "llm_tool_runner",
          provider: "local",
          model: "qwen3-coder:30b",
          toolProfile: "manager",
        },
      }),
    );

    await syncAgentGatewayConfigForExecutionProfile({
      accessToken: "token-1",
      userId: "user-1",
      agentId: "agent-1",
    });

    expect(writeGatewayConfigForManagerAgent).toHaveBeenCalledWith({
      accessToken: "token-1",
      userId: "user-1",
      agent,
      provider: "local",
      model: "qwen3-coder:30b",
      runnerKind: "llm_tool_runner",
    });
    expect(writeGatewayConfigForDefaultAgent).not.toHaveBeenCalled();
  });

  it("does not write config for custom agents", async () => {
    vi.mocked(resolveExecutionProfile).mockResolvedValue(
      resolution({
        agent: { agentId: "agent-1", workspaceId: "workspace-1", role: "custom" },
        profile: {
          ...resolution().profile!,
          role: "custom",
          runnerKind: "openclaw_ws",
          toolProfile: "none",
        },
      }),
    );

    await expect(
      syncAgentGatewayConfigForExecutionProfile({
        accessToken: "token-1",
        userId: "user-1",
        agentId: "agent-1",
      }),
    ).resolves.toMatchObject({ changed: false });

    expect(writeGatewayConfigForDefaultAgent).not.toHaveBeenCalled();
    expect(writeGatewayConfigForManagerAgent).not.toHaveBeenCalled();
  });
});
