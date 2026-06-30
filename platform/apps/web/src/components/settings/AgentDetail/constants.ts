import type {
  AgentRuntimeProfile,
  AgentType,
  PlanningDestination,
} from "../../../../../../contracts/agents";

export const AGENT_KIND_OPTIONS: Array<{ value: AgentType; label: string }> = [
  { value: "coding", label: "Coding" },
  { value: "planning", label: "Planning" },
  { value: "manager", label: "Manager" },
  { value: "custom", label: "Custom" },
];

export const AGENT_DETAIL_TABS: Array<{
  id: "general" | "tools" | "policies";
  label: string;
}> = [
  { id: "general", label: "General" },
  { id: "tools", label: "Tools" },
  { id: "policies", label: "Policies" },
];

export const PLANNING_DESTINATION_OPTIONS: Array<{
  value: PlanningDestination;
  label: string;
}> = [
  { value: "database", label: "Database" },
  { value: "linear", label: "Linear" },
];

export const RUNTIME_PROVIDER_OPTIONS: Array<{
  value: AgentRuntimeProfile["provider"];
  label: string;
}> = [
  { value: "local", label: "Local runtime" },
  { value: "openai", label: "OpenAI" },
  { value: "openai_compatible", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
];

export const HOSTED_RUNTIME_PROVIDERS = new Set<
  AgentRuntimeProfile["provider"]
>(["openai", "openai_compatible", "anthropic"]);
