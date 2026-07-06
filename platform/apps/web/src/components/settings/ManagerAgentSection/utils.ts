import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import type {
  ManagerAgentDueTaskQuery,
  ManagerRuntimeStatus,
} from "../../../../../../contracts/manager-agent";
import type { SavedCredential } from "../../../api/credentials";
import type { PlanRecord } from "../../../api/plans";
import {
  formatDisplayLabel,
  normalizeDisplayLabel,
} from "../../../lib/display-labels";
import {
  managerRuntimeProviderLabel,
} from "../runtime-provider-utils";

export type SchedulerRuntimeProvider = AgentRuntimeProfile["provider"];

export const MANAGER_PROVIDERS: SchedulerRuntimeProvider[] = [
  "openai",
  "anthropic",
  "openai_codex",
  "openai_compatible",
];

export const DEFAULT_MODELS: Record<SchedulerRuntimeProvider, string> = {
  openai: "openai/gpt-5.2",
  anthropic: "anthropic/claude-sonnet-4-6",
  openai_codex: "openai_codex/gpt-5.2-codex",
  openai_compatible: "qwen3-coder:30b",
  codex: "codex",
  openclaw: "openclaw",
  computer_use: "computer_use",
  local: "local",
};

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

export const CADENCE_OPTIONS = [
  { value: "60000", label: "Every minute" },
  { value: "300000", label: "Every 5 minutes" },
  { value: "900000", label: "Every 15 minutes" },
  { value: "1800000", label: "Every 30 minutes" },
  { value: "3600000", label: "Hourly" },
];

export const MANAGER_STATES = [
  "pending",
  "running",
  "awaiting_review",
  "blocked",
  "done",
  "failed",
] as const;

export type ManagerState = (typeof MANAGER_STATES)[number];

export const providerOptions = MANAGER_PROVIDERS.map((provider) => {
  return {
    value: provider,
    label: managerRuntimeProviderLabel(provider),
  };
});

export function credentialRowId(credential: SavedCredential): string {
  return (
    credential.credentialRowId ??
    credential.id.split(":", 1)[0] ??
    credential.id
  );
}

export function providerLabel(provider: string | null | undefined) {
  return managerRuntimeProviderLabel(provider);
}

export function statusBadgeVariant(
  status: ManagerRuntimeStatus["status"] | "unknown",
) {
  if (status === "running") return "success";
  if (status === "unhealthy" || status === "error") return "error";
  if (status === "idle_awaiting_credential" || status === "not_running")
    return "warning";
  return "default";
}

export function formatStatus(
  status: ManagerRuntimeStatus["status"] | "unknown",
) {
  return normalizeDisplayLabel(status);
}

export function formatCadence(ms: number | null | undefined) {
  const option = CADENCE_OPTIONS.find(
    (candidate) => Number(candidate.value) === ms,
  );
  if (option) return option.label;
  if (!ms) return "Not set";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function formatState(state: string) {
  return formatDisplayLabel(state, { fallback: "" }).toLowerCase();
}

export function formatPlanFilter(
  planIds: string[] | null | undefined,
  plans: PlanRecord[],
) {
  if (!planIds || planIds.length === 0) return "All plans";
  const byId = new Map(
    plans.map((plan) => [plan.id, plan.name || "Untitled plan"]),
  );
  return planIds.map((planId) => byId.get(planId) ?? planId).join(", ");
}

export function dueTaskHasOverride(
  query: ManagerAgentDueTaskQuery,
  key: "states" | "planIds",
) {
  return Array.isArray(query[key]);
}

export function credentialProviderMatches(
  credential: SavedCredential,
  provider: SchedulerRuntimeProvider,
) {
  return credential.provider === provider;
}
