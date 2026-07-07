import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anthropicCredentialId,
  codingAgentId,
  codexCredentialId,
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
});
