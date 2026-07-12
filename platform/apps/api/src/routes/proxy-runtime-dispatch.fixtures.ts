import type { ExecutionProfileResolution } from "../../../../contracts/execution-profile.js";
import type { SetupAgentRow } from "../repositories/agents.js";

export const agentId = "11111111-1111-4111-8111-111111111111";
export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const userId = "33333333-3333-4333-8333-333333333333";
export const credentialId = "44444444-4444-4444-8444-444444444444";
export const toolId = "55555555-5555-4555-8555-555555555555";
export const grantId = "66666666-6666-4666-8666-666666666666";
export const resourceId = "77777777-7777-4777-8777-777777777777";

export function localCodingProfile(): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "coding" },
    profile: {
      agentId,
      workspaceId,
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
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
      routingRuleId: "66666666-6666-4666-8666-666666666666",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

export function plannerLocalProfile(): ExecutionProfileResolution {
  return {
    agent: { agentId, workspaceId, role: "planning" },
    profile: {
      agentId,
      workspaceId,
      role: "planning",
      runnerKind: "planner",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      fallbacks: [],
      modelTierFloor: "any",
      toolProfile: "planning",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
        interrupt: false,
      },
    },
    missing: [],
    source: {
      routingRuleId: "66666666-6666-4666-8666-666666666666",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

export function shellTool() {
  return {
    id: toolId,
    workspaceId: null,
    slug: "shell.exec",
    name: "Run Shell Command",
    description: "Execute a shell command in the workspace.",
    parameters: { type: "object", properties: {} },
    examples: [],
    executionKind: "shell" as const,
    runnerKind: "local_model_coding" as const,
    enabled: true,
  };
}

export function plannerTool() {
  return {
    id: toolId,
    workspaceId: null,
    slug: "create_plan",
    name: "Create Plan",
    description: "Create a planning record.",
    parameters: { type: "object", properties: {} },
    examples: [],
    executionKind: "database" as const,
    runnerKind: "planner" as const,
    enabled: true,
  };
}

export function setupAgent(toolPolicy: SetupAgentRow["tool_policy"] = {}): SetupAgentRow {
  return {
    id: agentId,
    workspace_id: workspaceId,
    name: "Coding Agent",
    status: "active",
    type: "coding",
    context: null,
    model_settings: {},
    tool_policy: toolPolicy,
    created_by_user_id: userId,
    updated_at: "2026-04-29T12:00:00.000Z",
  };
}
