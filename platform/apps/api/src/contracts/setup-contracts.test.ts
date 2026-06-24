import { describe, expect, it } from "vitest";

import {
  AgentCredentialConfigurationRequestSchema,
  DefaultAgentCredentialApplicationRequestSchema,
  DefaultAgentCredentialApplicationResponseSchema,
  SetupAuthStateSchema,
} from "../../../../contracts/setup.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "33333333-3333-4333-8333-333333333333";
const codingAgentId = "44444444-4444-4444-8444-444444444444";

function baseAuthState() {
  return {
    ready: true,
    userId,
    resolvedAgentId: codingAgentId,
    workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Personal",
        ownerUserId: userId,
        createdAt: "2026-04-25T10:00:00.000Z",
      },
    ],
    agents: [],
  };
}

describe("default-agent setup contracts", () => {
  it("parses auth state with default-agent and non-blocking onboarding status", () => {
    const parsed = SetupAuthStateSchema.parse({
      ...baseAuthState(),
      defaultAgents: {
        planning: {
          agentId: planningAgentId,
          configured: false,
          missing: ["credential", "model", "gateway_config"],
        },
        coding: {
          agentId: codingAgentId,
          configured: true,
          missing: [],
        },
      },
      onboarding: {
        required: true,
        blocking: false,
        reasons: ["planning_missing_credentials"],
      },
    });

    expect(parsed.defaultAgents.planning.agentId).toBe(planningAgentId);
    expect(parsed.defaultAgents.planning.configured).toBe(false);
    expect(parsed.defaultAgents.coding.configured).toBe(true);
    expect(parsed.managerAgent).toEqual({
      agentId: null,
      configured: false,
      missing: [],
    });
    expect(parsed.onboarding).toEqual({
      required: true,
      blocking: false,
      reasons: ["planning_missing_credentials"],
    });
  });

  it("populates empty default statuses when auth state omits them", () => {
    const parsed = SetupAuthStateSchema.parse(baseAuthState());

    expect(parsed.defaultAgents).toEqual({
      planning: {
        agentId: null,
        configured: false,
        missing: [],
      },
      coding: {
        agentId: null,
        configured: false,
        missing: [],
      },
    });
    expect(parsed.managerAgent).toEqual({
      agentId: null,
      configured: false,
      missing: [],
    });
    expect(parsed.onboarding).toEqual({
      required: false,
      blocking: false,
      reasons: [],
    });
  });

  it("creates isolated default-agent status objects for auth-state payloads", () => {
    const first = SetupAuthStateSchema.parse(baseAuthState());
    first.defaultAgents.planning.missing.push("credential");

    expect(first.defaultAgents.coding.missing).toEqual([]);

    const second = SetupAuthStateSchema.parse(baseAuthState());
    expect(second.defaultAgents.planning.missing).toEqual([]);
    expect(second.defaultAgents.coding.missing).toEqual([]);
    expect(second.managerAgent.missing).toEqual([]);
  });

  it("parses auth state with workspace-scoped manager status", () => {
    const managerAgentId = "55555555-5555-4555-8555-555555555555";

    const parsed = SetupAuthStateSchema.parse({
      ...baseAuthState(),
      managerAgent: {
        agentId: managerAgentId,
        configured: false,
        missing: ["credential", "gateway_config", "runner"],
      },
    });

    expect(parsed.managerAgent).toEqual({
      agentId: managerAgentId,
      configured: false,
      missing: ["credential", "gateway_config", "runner"],
    });
  });

  it("parses default-agent credential application requests", () => {
    const parsed = DefaultAgentCredentialApplicationRequestSchema.parse({
      workspaceId,
      provider: "openai",
      model: "openai/gpt-5.2",
      label: "OpenAI API Key",
      keyName: "OPENAI_API_KEY",
      secret: "sk-test",
      agentIds: [planningAgentId, codingAgentId],
    });

    expect(parsed.agentIds).toEqual([planningAgentId, codingAgentId]);
    expect(parsed.provider).toBe("openai");
  });

  it("rejects credential application requests without agent targets", () => {
    const result = DefaultAgentCredentialApplicationRequestSchema.safeParse({
      workspaceId,
      provider: "openai",
      secret: "sk-test",
      agentIds: [],
    });

    expect(result.success).toBe(false);
  });

  it("allows the default-agent credential service to choose model and key name defaults", () => {
    const parsed = DefaultAgentCredentialApplicationRequestSchema.parse({
      workspaceId,
      provider: "openai",
      secret: "sk-test",
      agentIds: [planningAgentId, codingAgentId],
    });

    expect(parsed.model).toBeUndefined();
    expect(parsed.keyName).toBeUndefined();
  });

  it("parses selected-agent credential configuration requests", () => {
    const parsed = AgentCredentialConfigurationRequestSchema.parse({
      agentId: planningAgentId,
      workspaceId,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      keyName: "ANTHROPIC_API_KEY",
      secret: "sk-ant-test",
    });

    expect(parsed.agentId).toBe(planningAgentId);
    expect(parsed.provider).toBe("anthropic");
  });

  const credentialId = "66666666-6666-4666-8666-666666666666";

  it("parses selected-agent requests that reuse a stored credential", () => {
    const parsed = AgentCredentialConfigurationRequestSchema.parse({
      agentId: planningAgentId,
      workspaceId,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      credentialId,
    });

    expect(parsed.credentialId).toBe(credentialId);
    expect(parsed.secret).toBeUndefined();
  });

  it("parses default-agent requests that reuse a stored credential", () => {
    const parsed = DefaultAgentCredentialApplicationRequestSchema.parse({
      workspaceId,
      provider: "openai",
      credentialId,
      agentIds: [planningAgentId, codingAgentId],
    });

    expect(parsed.credentialId).toBe(credentialId);
    expect(parsed.secret).toBeUndefined();
  });

  it("rejects credential requests that provide neither a secret nor a credentialId", () => {
    expect(
      AgentCredentialConfigurationRequestSchema.safeParse({
        agentId: planningAgentId,
        workspaceId,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6",
      }).success,
    ).toBe(false);

    expect(
      DefaultAgentCredentialApplicationRequestSchema.safeParse({
        workspaceId,
        provider: "openai",
        agentIds: [planningAgentId],
      }).success,
    ).toBe(false);
  });

  it("rejects credential requests that provide both a secret and a credentialId", () => {
    expect(
      AgentCredentialConfigurationRequestSchema.safeParse({
        agentId: planningAgentId,
        workspaceId,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6",
        secret: "sk-ant-test",
        credentialId,
      }).success,
    ).toBe(false);
  });

  it("rejects reuse requests that also carry a keyName", () => {
    expect(
      AgentCredentialConfigurationRequestSchema.safeParse({
        agentId: planningAgentId,
        workspaceId,
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6",
        keyName: "ANTHROPIC_API_KEY",
        credentialId,
      }).success,
    ).toBe(false);
  });

  it("parses credential application responses with refreshed auth state", () => {
    const parsed = DefaultAgentCredentialApplicationResponseSchema.parse({
      authState: {
        ...baseAuthState(),
        defaultAgents: {
          planning: {
            agentId: planningAgentId,
            configured: true,
            missing: [],
          },
          coding: {
            agentId: codingAgentId,
            configured: true,
            missing: [],
          },
        },
        onboarding: {
          required: false,
          blocking: false,
          reasons: [],
        },
      },
    });

    expect(parsed.authState.defaultAgents.planning.configured).toBe(true);
    expect(parsed.authState.defaultAgents.coding.configured).toBe(true);
  });
});
