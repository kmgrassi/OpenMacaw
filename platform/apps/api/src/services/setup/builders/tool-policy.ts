import { ToolPolicySchema, type ToolPolicy } from "../../../../../../contracts/agents.js";
import type { DefaultAgentRole, SetupRequest, SetupUpdateRequest } from "../../../../../../contracts/setup.js";
import {
  DEFAULT_PLANNING_TOOL_SLUGS,
  AGENT_TOOL_GRANT_TOOL_SLUGS,
  DEFAULT_MANAGER_TOOL_SLUGS,
  DEFAULT_LEARNING_TOOL_SLUGS,
  GIT_COMMAND_TOOL_SLUG,
  ROUTER_TOOL_SLUGS,
  SCHEDULED_TASK_TOOL_SLUGS,
} from "../../tool-bundles.js";
import { agentType } from "./agent-defaults.js";

export function plannerToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    planning: {
      destination: "database",
      tools: [...DEFAULT_PLANNING_TOOL_SLUGS, ...SCHEDULED_TASK_TOOL_SLUGS, ...AGENT_TOOL_GRANT_TOOL_SLUGS],
    },
  });
}

export function managerToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    manager: {
      cadence_ms: 60_000,
      tools: DEFAULT_MANAGER_TOOL_SLUGS,
    },
  });
}

export function routerToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    router: {
      tools: ROUTER_TOOL_SLUGS,
    },
  });
}

export function learningToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    learning: {
      cadence: "daily",
      sampler: "random_recent_window",
      tools: DEFAULT_LEARNING_TOOL_SLUGS,
    },
  });
}

export function codingToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    coding: {
      tools: [
        GIT_COMMAND_TOOL_SLUG,
        "shell.exec",
        "apply_patch",
        ...SCHEDULED_TASK_TOOL_SLUGS,
      ],
      execution_kinds: ["filesystem", "shell"],
    },
  });
}

export function defaultAgentToolPolicy(role: DefaultAgentRole): ToolPolicy {
  return role === "planning" ? plannerToolPolicyDefaults() : codingToolPolicyDefaults();
}

function customToolPolicyDefaults(): ToolPolicy {
  return ToolPolicySchema.parse({
    custom: {
      target_required: true,
    },
  });
}

function mergeRecords(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeRecords(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function buildToolPolicy(input: SetupRequest | SetupUpdateRequest, type = agentType(input)): ToolPolicy {
  const defaults =
    type === "planning"
      ? plannerToolPolicyDefaults()
      : type === "manager"
        ? managerToolPolicyDefaults()
        : type === "learning"
          ? learningToolPolicyDefaults()
          : type === "router"
            ? routerToolPolicyDefaults()
            : type === "custom"
              ? customToolPolicyDefaults()
              : {};
  return ToolPolicySchema.parse(mergeRecords(defaults, input.toolPolicy));
}
