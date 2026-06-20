import type { ToolProfile } from "../../../../contracts/execution-profile.js";
import type { RunnerKind } from "../../../../contracts/runner-kinds.js";

export const DEFAULT_PLANNING_TOOL_SLUGS = [
  "repo.read_file",
  "repo.list",
  "repo.search",
  "repo.read_symbols",
  "plan.create",
  "task.create",
  "task.update",
  "plans.read",
  "plan.read",
  "plan.delete",
  "task.read",
] as const;

export const SCHEDULED_TASK_TOOL_SLUGS = [
  "scheduled_task.create",
  "scheduled_task.read",
  "scheduled_task.update",
  "scheduled_task.list",
  "scheduled_task.delete",
] as const;

export const AGENT_TOOL_GRANT_TOOL_SLUGS = ["agent_tool_grant.create", "agent_tool_grant.update"] as const;

export const SKILL_TOOL_SLUGS = ["skill.create"] as const;

export const GIT_COMMAND_TOOL_SLUG = "git.run" as const;

export const ROUTER_TOOL_SLUGS = [
  "routing_rule.list",
  "routing_rule.read",
  "routing_rule.update",
  "provider_failure.list",
  "local_model.list",
  "provider_cutover.list",
  "scheduled_task.read",
  ...SKILL_TOOL_SLUGS,
] as const;

export const DEFAULT_SCHEDULED_AGENT_TOOL_SLUGS = [
  ...DEFAULT_PLANNING_TOOL_SLUGS,
  ...SCHEDULED_TASK_TOOL_SLUGS,
  ...SKILL_TOOL_SLUGS,
] as const;

export const DEFAULT_PLANNER_REMEDIATION_TOOL_SLUGS = [
  ...DEFAULT_SCHEDULED_AGENT_TOOL_SLUGS,
  ...AGENT_TOOL_GRANT_TOOL_SLUGS,
] as const;

export const DEFAULT_CODING_TOOL_SLUGS = [...DEFAULT_SCHEDULED_AGENT_TOOL_SLUGS] as const;

export const DEFAULT_MANAGER_TOOL_SLUGS = [GIT_COMMAND_TOOL_SLUG, ...DEFAULT_CODING_TOOL_SLUGS] as const;

export const DEFAULT_LEARNING_TOOL_SLUGS = ["agent_run.read", "scheduled_task.create"] as const;

export const LOCAL_MODEL_CODING_TOOL_SLUGS = [
  "repo.read_file",
  "repo.list",
  "repo.search",
  GIT_COMMAND_TOOL_SLUG,
  "shell.exec",
  "apply_patch",
  ...SCHEDULED_TASK_TOOL_SLUGS,
  ...SKILL_TOOL_SLUGS,
] as const;

type ToolBundleDefinition = {
  defaultToolSlugs: readonly string[];
  runnerOverrides?: Partial<Record<RunnerKind, readonly string[]>>;
};

const TOOL_BUNDLES: Record<ToolProfile, ToolBundleDefinition> = {
  planning: {
    defaultToolSlugs: DEFAULT_PLANNER_REMEDIATION_TOOL_SLUGS,
  },
  coding: {
    defaultToolSlugs: DEFAULT_CODING_TOOL_SLUGS,
    runnerOverrides: {
      local_model_coding: LOCAL_MODEL_CODING_TOOL_SLUGS,
    },
  },
  manager: {
    defaultToolSlugs: DEFAULT_MANAGER_TOOL_SLUGS,
  },
  learning: {
    defaultToolSlugs: DEFAULT_LEARNING_TOOL_SLUGS,
  },
  router: {
    defaultToolSlugs: ROUTER_TOOL_SLUGS,
  },
  none: {
    defaultToolSlugs: [],
  },
} as const satisfies Record<ToolProfile, ToolBundleDefinition>;

export function toolProfileForAgentType(agentType: string | null | undefined): ToolProfile {
  if (
    agentType === "planning" ||
    agentType === "coding" ||
    agentType === "manager" ||
    agentType === "learning" ||
    agentType === "router"
  ) {
    return agentType;
  }
  return "none";
}

export function toolSlugsForToolProfile(input: {
  toolProfile: ToolProfile;
  runnerKind?: string | null | undefined;
  localModelCodingEnabled?: boolean | null | undefined;
}): string[] {
  const bundle = TOOL_BUNDLES[input.toolProfile];
  const localModelCodingEnabled = input.runnerKind === "local_model_coding" || Boolean(input.localModelCodingEnabled);
  const runnerOverride = localModelCodingEnabled ? bundle.runnerOverrides?.local_model_coding : undefined;
  return [...(runnerOverride ?? bundle.defaultToolSlugs)];
}
