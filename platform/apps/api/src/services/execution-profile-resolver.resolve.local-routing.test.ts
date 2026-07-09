import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anthropicCredentialId,
  codingAgentId,
  managerAgentId,
  planningAgentId,
  setupMockDatabase,
  workspaceId,
} from "../../test-support/execution-profile-resolver-shared.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";

describe("resolveExecutionProfile local routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves local model coding routing rules without credential drift", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      credentialRef: null,
      toolProfile: "coding",
      workspacePolicy: {
        sandbox: "workspace_write",
        approvalPolicy: "on_request",
      },
      capabilityRequirements: {
        toolCalls: true,
        jsonMode: true,
      },
      capabilities: {
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
      },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("prefers local model coding when duplicate agent routes have the same priority", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_relay",
          provider: "openai_compatible",
          model: "qwen2.5-coder:latest",
          credential_id: null,
          credential_alias: null,
        },
        {
          id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "agent_id",
          value: codingAgentId,
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "id",
          value: codingAgentId,
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
    });
    expect(resolution.missing).toEqual([]);
  });

  it("does not count local metadata rows as routing specificity", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "local_model_coding",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
        },
        {
          id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          credential_id: anthropicCredentialId,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: "type",
          value: "coding",
        },
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "local_workspace_root",
          key: "path",
          value: "/tmp/workspace",
        },
        {
          rule_id: "12121212-1212-4212-8212-121212121212",
          workspace_id: workspaceId,
          kind: "local_machine",
          key: "id",
          value: "machine-1",
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: "type",
          value: "coding",
        },
        {
          rule_id: "34343434-3434-4434-8434-343434343434",
          workspace_id: workspaceId,
          kind: "intent",
          key: null,
          value: "draft_plan",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({
      agentId: codingAgentId,
      intent: "draft_plan",
    });

    expect(resolution.profile).toMatchObject({
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("resolves planner local routing rules without hosted credentials", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "10101010-1010-4010-8010-101010101010",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "planner",
          provider: "local",
          model: "qwen2.5-coder:7b",
          credential_id: null,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "10101010-1010-4010-8010-101010101010",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "planning",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: planningAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: planningAgentId,
      role: "planning",
      runnerKind: "planner",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      toolProfile: "planning",
      capabilities: {
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
      },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("resolves OpenAI-compatible manager routing rules without hosted credentials", async () => {
    setupMockDatabase({
      agent: [
        {
          id: managerAgentId,
          workspace_id: workspaceId,
          type: "manager",
          model_settings: { primary: "qwen3-coder:30b" },
          tool_policy: {},
        },
      ],
      routing_rule: [
        {
          id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "openai_compatible",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "id",
          value: managerAgentId,
        },
        {
          rule_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({
      agentId: managerAgentId,
    });

    expect(resolution.profile).toMatchObject({
      agentId: managerAgentId,
      role: "manager",
      runnerKind: "llm_tool_runner",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      credentialRef: null,
      toolProfile: "manager",
    });
    expect(resolution.missing).toEqual([]);
  });

  it("resolves local manager routing rules without hosted credentials", async () => {
    setupMockDatabase({
      agent: [
        {
          id: managerAgentId,
          workspace_id: workspaceId,
          type: "manager",
          model_settings: { primary: "qwen3-coder:30b" },
          tool_policy: {},
        },
      ],
      routing_rule: [
        {
          id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "local",
          model: "qwen3-coder:30b",
          credential_id: null,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          workspace_id: workspaceId,
          kind: "agent_id",
          key: "id",
          value: managerAgentId,
        },
        {
          rule_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          workspace_id: workspaceId,
          kind: "local_endpoint",
          key: "url",
          value: "http://127.0.0.1:11434/v1",
        },
      ],
      credential: [],
    });

    const resolution = await resolveExecutionProfile({
      agentId: managerAgentId,
    });

    expect(resolution.profile).toMatchObject({
      agentId: managerAgentId,
      role: "manager",
      runnerKind: "llm_tool_runner",
      provider: "local",
      model: "qwen3-coder:30b",
      credentialRef: null,
      toolProfile: "manager",
    });
    expect(resolution.missing).toEqual([]);
  });
});
