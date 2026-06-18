import { describe, expect, it } from "vitest";

import {
  buildGatewayConfig,
  buildRequirementStatusFromResolution,
  buildRequirementStatus,
  defaultAgentGatewayConfig,
  repairGatewayConfig,
  repairManagerGatewayConfig,
} from "./builders.js";
import type { ExecutionProfileResolution } from "../../../../../contracts/execution-profile.js";
import type { AgentRow, GatewayConfigRow } from "./types.js";

function fakeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    name: "Manager Agent",
    status: "active",
    type: "manager",
    model_settings: { primary: "openai/gpt-5.2" },
    tool_policy: {},
    created_by_user_id: null,
    updated_at: null,
    ...overrides,
  } as AgentRow;
}

function fakeGatewayConfig(configJson: unknown): GatewayConfigRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    scope_type: "agent",
    scope_id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    config_hash: "deadbeef",
    config_json: configJson,
    updated_at: "2026-04-29T00:00:00Z",
    updated_by: "44444444-4444-4444-8444-444444444444",
  } as GatewayConfigRow;
}

describe("setup gateway config builders", () => {
  it("exposes the effective local coding execution target kind in requirement status", () => {
    const resolution: ExecutionProfileResolution = {
      agent: {
        agentId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        role: "coding",
      },
      profile: {
        agentId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        role: "coding",
        runnerKind: "local_model_coding",
        provider: "openai_compatible",
        model: "qwen3-coder:30b",
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
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    };

    expect(
      buildRequirementStatusFromResolution(resolution, {
        localCodingExecutionTargetKind: "container",
      }),
    ).toMatchObject({
      configured: true,
      localCodingExecutionTargetKind: "container",
    });
  });

  it("does not write tracker into default planning gateway configs", () => {
    expect(defaultAgentGatewayConfig("planning", "openai", "openai/gpt-5.2")).not.toHaveProperty("tracker");
  });

  it("can seed default planning agents with a local relay runner", () => {
    expect(defaultAgentGatewayConfig("planning", "local", "qwen2.5-coder:7b", "local_relay")).toMatchObject({
      runners: [{ kind: "local_relay", model: "qwen2.5-coder:7b", provider: "local" }],
    });
  });

  it("preserves legacy tracker config without repairing it", () => {
    const repaired = repairGatewayConfig(
      {
        tracker: { kind: "database" },
        runners: [{ kind: "codex", model: "old-model", provider: "old-provider" }],
      },
      "planning",
      "openai",
      "openai/gpt-5.2",
    );

    expect(repaired).toMatchObject({
      tracker: { kind: "database" },
      runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }],
    });
    expect((repaired as Record<string, unknown>).tracker).not.toHaveProperty("table");
  });

  it("does not add tracker while repairing configs that omit it", () => {
    const repaired = repairGatewayConfig(
      {
        runners: [{ kind: "codex", model: "old-model", provider: "old-provider" }],
      },
      "planning",
      "openai",
      "openai/gpt-5.2",
    );

    expect(repaired).toMatchObject({
      runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }],
    });
    expect(repaired).not.toHaveProperty("tracker");
  });

  it("does not write tracker into setup-created gateway configs", () => {
    const config = buildGatewayConfig({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      agentName: "Planning Agent",
      model: "openai/gpt-5.2",
      tracker: { kind: "database", config: {}, repositoryUrl: null },
      runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai", config: {} }],
      credentials: [],
      toolPolicy: {},
      workflowTemplate: "planning-default",
      maxConcurrentAgents: 1,
    });

    expect(config).not.toHaveProperty("tracker");
  });

  it("seeds required tracker defaults while repairing manager gateway configs", () => {
    const config = repairManagerGatewayConfig({
      configJson: null,
      provider: "openai",
      model: "openai/gpt-5.2",
      runnerKind: "llm_tool_runner",
    });

    expect(config).toMatchObject({
      tracker: { kind: "database", table: "work_items" },
      workflow_template: { id: "manager-default" },
    });
  });

  it("treats manager agents (object-shaped runners) as having a runner", () => {
    const config = fakeGatewayConfig({
      tracker: { kind: "memory" },
      runners: {
        manager: { kind: "llm_tool_runner", provider: "openai", model: "openai/gpt-5.2" },
      },
    });
    const status = buildRequirementStatus(fakeAgent(), config, 1);
    expect(status.missing).not.toContain("runner");
    expect(status.configured).toBe(true);
  });

  it("treats default agents (array-shaped runners) as having a runner", () => {
    const config = fakeGatewayConfig({
      tracker: { kind: "memory" },
      runners: [{ kind: "codex", provider: "openai", model: "openai/gpt-5.2" }],
    });
    const status = buildRequirementStatus(fakeAgent({ type: "coding" }), config, 1);
    expect(status.missing).not.toContain("runner");
    expect(status.configured).toBe(true);
  });

  it("flags missing runner when the runners block is empty or absent", () => {
    const empty = fakeGatewayConfig({ tracker: { kind: "memory" } });
    expect(buildRequirementStatus(fakeAgent(), empty, 1).missing).toContain("runner");

    const emptyArray = fakeGatewayConfig({ tracker: { kind: "memory" }, runners: [] });
    expect(buildRequirementStatus(fakeAgent(), emptyArray, 1).missing).toContain("runner");

    const emptyObject = fakeGatewayConfig({ tracker: { kind: "memory" }, runners: {} });
    expect(buildRequirementStatus(fakeAgent(), emptyObject, 1).missing).toContain("runner");
  });

  it("adds Claude Code adapter defaults to setup-created coding runner configs", () => {
    expect(
      buildGatewayConfig({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        agentName: "Coding Agent",
        model: "anthropic/claude-sonnet-4-6",
        tracker: { kind: "database", config: {}, repositoryUrl: null },
        runners: [{ kind: "claude_code", model: "anthropic/claude-sonnet-4-6", provider: "anthropic", config: {} }],
        credentials: [],
        toolPolicy: {},
        workflowTemplate: "coding-default",
        maxConcurrentAgents: 1,
      }),
    ).toMatchObject({
      runners: [
        {
          kind: "claude_code",
          model: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          adapter_config: {
            permission_mode: "acceptEdits",
            tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          },
        },
      ],
    });
  });

  it("normalizes every runner entry in setup-created gateway configs", () => {
    expect(
      buildGatewayConfig({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        agentName: "Hybrid Agent",
        model: "openai/gpt-5.2",
        tracker: { kind: "database", config: {}, repositoryUrl: null },
        runners: [
          { kind: "codex", model: "openai/gpt-5.2", provider: "openai", config: { max_tokens: 4096 } },
          { kind: "claude_code", model: "anthropic/claude-sonnet-4-6", provider: "anthropic", config: {} },
        ],
        credentials: [],
        toolPolicy: {},
        workflowTemplate: "hybrid-default",
        maxConcurrentAgents: 2,
      }),
    ).toMatchObject({
      runners: [
        {
          kind: "codex",
          model: "openai/gpt-5.2",
          provider: "openai",
          max_tokens: 4096,
        },
        {
          kind: "claude_code",
          model: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          adapter_config: {
            permission_mode: "acceptEdits",
            tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            allowed_tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          },
        },
      ],
    });
  });
});
