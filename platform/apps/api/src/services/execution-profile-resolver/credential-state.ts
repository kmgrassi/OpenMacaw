import type { AgentRole } from "../../../../../contracts/execution-profile.js";
import type { RunnerKind } from "../../../../../contracts/runner-kinds.js";

export function normalizeRole(value: string | null | undefined): AgentRole {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "planning" ||
    normalized === "manager" ||
    normalized === "learning" ||
    normalized === "router" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  return "coding";
}

export function isCredentiallessManagerProfile(input: {
  role: AgentRole;
  runnerKind: RunnerKind | null;
  provider: string | null;
}): boolean {
  return (
    input.role === "manager" &&
    input.runnerKind === "llm_tool_runner" &&
    (input.provider === "openai_compatible" || input.provider === "local")
  );
}

export function isCredentiallessPlannerProfile(input: {
  role: AgentRole;
  runnerKind: RunnerKind | null;
  provider: string | null;
}): boolean {
  return input.role === "planning" && input.runnerKind === "planner" && input.provider === "local";
}
