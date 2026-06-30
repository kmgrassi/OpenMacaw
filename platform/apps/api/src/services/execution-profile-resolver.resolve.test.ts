import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anthropicCredentialId,
  codingAgentId,
  codexCredentialId,
  managerAgentId,
  planningAgentId,
  queryRows,
  setSelectRowsForTable,
  setupMockDatabase,
  tableParams,
  workspaceId,
} from "../../test-support/execution-profile-resolver-shared.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";

describe("resolveExecutionProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves planning and coding agents to different providers in one workspace", async () => {
    setupMockDatabase();

    const planning = await resolveExecutionProfile({ agentId: planningAgentId });
    const coding = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(planning.profile).toMatchObject({
      agentId: planningAgentId,
      role: "planning",
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
      toolProfile: "planning",
    });
    expect(planning.missing).toEqual([]);
    expect(planning.source).toMatchObject({
      routingRuleId: "55555555-5555-4555-8555-555555555555",
      credentialAlias: "default-anthropic",
      fallbackUsed: false,
    });
    expect(planning.profile?.fallbacks).toEqual([]);
    expect(planning.profile?.modelTierFloor).toBe("any");

    expect(coding.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
      toolProfile: "coding",
    });
    expect(coding.missing).toEqual([]);
  });

  it("resolves a Claude Code coding profile without normalizing it to Codex", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "claude_code",
          provider: "anthropic",
          model: "sonnet",
          credential_id: null,
          credential_alias: "default-anthropic",
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      agentId: codingAgentId,
      role: "coding",
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "sonnet",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: false,
      },
    });
    expect(resolution.missing).toEqual([]);
    expect(resolution.source).toMatchObject({
      routingRuleId: "77777777-7777-4777-8777-777777777777",
      credentialAlias: "default-anthropic",
      fallbackUsed: false,
    });
  });

  it("resolves a Claude Code coding profile with a full Anthropic model id", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "claude_code",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-6",
          credential_id: anthropicCredentialId,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "coding",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      credentialRef: { type: "credential_id", value: anthropicCredentialId },
    });
    expect(resolution.missing).toEqual([]);
  });

  it("falls back to legacy agent model settings and gateway config", async () => {
    setupMockDatabase({
      routing_rule: [],
      routing_rule_match: [],
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: { type: "credential_id", value: codexCredentialId },
    });
    expect(resolution.source).toEqual({
      routingRuleId: null,
      credentialAlias: null,
      fallbackUsed: true,
      legacyGatewayConfigUsed: true,
    });
  });

  it("does not 502 when legacy credential.agent_id lookup is unavailable", async () => {
    setupMockDatabase({
      routing_rule: [],
      routing_rule_match: [],
      credential: [],
    });
    setSelectRowsForTable((table, params) => {
      const query = tableParams(params);
      if (table === "credential" && query.agent_id) {
        throw new Error(
          'Supabase credential query failed (400): {"code":"42703","message":"column credential.agent_id does not exist"}',
        );
      }

      const rowsByTable = {
        agent: [
          {
            id: codingAgentId,
            workspace_id: workspaceId,
            type: "coding",
            model_settings: { primary: "openai/gpt-5.1-codex" },
            tool_policy: {},
          },
        ],
        routing_rule: [],
        routing_rule_match: [],
        gateway_config: [
          {
            scope_type: "agent",
            scope_id: codingAgentId,
            version: 1,
            config_json: {
              runners: [
                {
                  kind: "codex",
                  provider: "openai_codex",
                  model: "gpt-5.1-codex",
                },
              ],
            },
          },
        ],
        credential: [],
      };

      return queryRows(rowsByTable, table, params);
    });

    const resolution = await resolveExecutionProfile({ agentId: codingAgentId });

    expect(resolution.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
      model: "gpt-5.1-codex",
      credentialRef: null,
    });
    expect(resolution.missing).toContain("credential");
  });

  it("fails visibly when routing table reads are unavailable", async () => {
    setupMockDatabase();
    setSelectRowsForTable((table, params) => {
      if (table === "routing_rule" || table === "routing_rule_match") {
        throw new Error(`${table} is not readable`);
      }

      const rowsByTable = {
        agent: [
          {
            id: codingAgentId,
            workspace_id: workspaceId,
            type: "coding",
            model_settings: { primary: "openai/gpt-5.1-codex" },
            tool_policy: {},
          },
        ],
        gateway_config: [
          {
            scope_type: "agent",
            scope_id: codingAgentId,
            version: 1,
            config_json: {
              runners: [
                {
                  kind: "codex",
                  provider: "openai_codex",
                  model: "gpt-5.1-codex",
                },
              ],
            },
          },
        ],
        credential: [
          {
            id: codexCredentialId,
            workspace_id: workspaceId,
            key_value: { agent_id: codingAgentId },
          },
        ],
      };

      return queryRows(rowsByTable, table, params);
    });

    await expect(resolveExecutionProfile({ agentId: codingAgentId })).rejects.toThrow("routing_rule is not readable");
  });

  it("fails at the query boundary when agent model_settings is invalid", async () => {
    setupMockDatabase({
      agent: [
        {
          id: codingAgentId,
          workspace_id: workspaceId,
          type: "coding",
          model_settings: "openai/gpt-5.1-codex",
          tool_policy: {},
        },
      ],
      routing_rule: [],
      routing_rule_match: [],
    });

    await expect(resolveExecutionProfile({ agentId: codingAgentId })).rejects.toMatchObject({
      code: "invalid_supabase_row",
      context: "agent query",
    });
  });

  it("emits explicit fallback rows in position order on the resolved profile", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          model_tier_floor: "frontier",
          credential_id: null,
          credential_alias: "missing-alias",
        },
      ],
      routing_rule_fallback: [
        {
          routing_rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          position: 2,
          provider: "openai",
          model: "gpt-4o",
          credential_id: codexCredentialId,
          credential_alias: null,
        },
        {
          routing_rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          position: 1,
          provider: "anthropic",
          model: "claude-opus-4-7",
          credential_id: null,
          credential_alias: "default-anthropic",
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "planning",
        },
      ],
    });

    const resolution = await resolveExecutionProfile({
      agentId: planningAgentId,
    });

    expect(resolution.profile).toMatchObject({
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      modelTierFloor: "frontier",
      fallbacks: [
        {
          provider: "anthropic",
          model: "claude-opus-4-7",
          credentialRef: { type: "credential_id", value: anthropicCredentialId },
        },
        {
          provider: "openai",
          model: "gpt-4o",
          credentialRef: { type: "credential_id", value: codexCredentialId },
        },
      ],
    });
    expect(resolution.missing).toEqual(["credential"]);
    expect(resolution.source.routingRuleId).toBe("77777777-7777-4777-8777-777777777777");
  });

  it("fails closed when a fallback row references an unknown model tier", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "llm_tool_runner",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          model_tier_floor: "any",
          credential_id: anthropicCredentialId,
          credential_alias: null,
        },
      ],
      routing_rule_fallback: [
        {
          routing_rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          position: 1,
          provider: "anthropic",
          model: "not-in-registry",
          credential_id: anthropicCredentialId,
          credential_alias: null,
        },
      ],
      routing_rule_match: [
        {
          rule_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          kind: "agent_type",
          key: null,
          value: "planning",
        },
      ],
    });

    await expect(resolveExecutionProfile({ agentId: planningAgentId })).rejects.toMatchObject({
      code: "unknown_model_in_fallback_chain",
    });
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

  it("returns explicit missing requirements without leaking credential material", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "",
          provider: null,
          model: null,
          credential_id: null,
          credential_alias: "missing-alias",
        },
      ],
      routing_rule_match: [],
      credential_alias: [],
      agent: [
        {
          id: planningAgentId,
          workspace_id: workspaceId,
          type: "planning",
          model_settings: {},
          tool_policy: {},
        },
      ],
    });

    const resolution = await resolveExecutionProfile({
      agentId: planningAgentId,
    });

    expect(resolution.profile).toBeNull();
    expect(resolution.missing).toEqual(["runner", "provider", "model", "credential"]);
    expect(JSON.stringify(resolution)).not.toContain("sk-");
  });

  it("uses intent match keys to distinguish namespaced routing predicates", async () => {
    setupMockDatabase({
      routing_rule: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          priority: 100,
          enabled: true,
          runner_kind: "codex",
          provider: "openai_codex",
          model: "gpt-5.1-codex",
          credential_id: codexCredentialId,
          credential_alias: null,
        },
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          priority: 10,
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
          rule_id: "88888888-8888-4888-8888-888888888888",
          workspace_id: workspaceId,
          kind: "intent",
          key: "workflow",
          value: "draft_plan",
        },
        {
          rule_id: "99999999-9999-4999-8999-999999999999",
          workspace_id: workspaceId,
          kind: "intent",
          key: null,
          value: "draft_plan",
        },
      ],
    });

    const unkeyed = await resolveExecutionProfile({
      agentId: planningAgentId,
      intent: "draft_plan",
    });
    const keyed = await resolveExecutionProfile({
      agentId: planningAgentId,
      intent: "draft_plan",
      intentKey: "workflow",
    });

    expect(unkeyed.profile).toMatchObject({
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
    });
    expect(keyed.profile).toMatchObject({
      runnerKind: "codex",
      provider: "openai_codex",
    });
  });
});
