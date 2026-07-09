import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anthropicCredentialId,
  codexCredentialId,
  planningAgentId,
  setupMockDatabase,
  workspaceId,
} from "../../test-support/execution-profile-resolver-shared.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";

describe("resolveExecutionProfile fallback handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
