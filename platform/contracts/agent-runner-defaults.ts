import { AgentTypeSchema, type AgentType } from "./agents.js";
import type { RunnerKind } from "./runner-kinds.js";

/**
 * Default `runner_kind` for each `AgentType`. This is the single source
 * of truth for the per-type mapping; every other lookup (onboarding,
 * per-agent credential save, runtime-profile resolution, SQL backfill)
 * derives from this constant.
 *
 * `routing_rule.runner_kind` may override the default for an
 * individual agent; this map is what gets written when nothing more
 * specific exists.
 *
 * Capability differences worth knowing when you change a value:
 *   - planning  → `planner`           — workspaceWrite: never. Plans + delegates.
 *   - coding    → `codex`             — workspaceWrite: always. Edits files.
 *   - manager   → `llm_tool_runner`   — workspaceWrite: role_coding. Orchestrates.
 *   - learning  → `llm_tool_runner`   — read-only observer, proposes memory/skills/planner handoffs.
 *   - router    → `llm_tool_runner`   — tool-calling model over routing tools.
 *   - custom    → `openclaw_ws`       — external websocket runner.
 *
 * See `docs/reference/execution-profile-contract.md` for the full
 * resolution path (routing_rule preferred over gateway_config fallback)
 * and the list of code paths that must keep both in sync.
 *
 * Keep in sync with the runner_kind CASE in
 * `harper-server/supabase/migrations/20260518150000_backfill_onboarding_routing_rules.sql`.
 */
export const DEFAULT_RUNNER_KIND_BY_AGENT_TYPE = {
  planning: "planner",
  coding: "codex",
  manager: "llm_tool_runner",
  learning: "llm_tool_runner",
  router: "llm_tool_runner",
  custom: "openclaw_ws",
} as const satisfies Record<AgentType, RunnerKind>;

/**
 * Tolerant accessor for code paths that hold an agent type as
 * `string | null | undefined`. Unknown values fall back to `codex`
 * (matches the previous behavior of the removed `runnerKindForAgent`
 * helper). Use the typed `DEFAULT_RUNNER_KIND_BY_AGENT_TYPE` directly
 * when you already have an `AgentType`.
 */
export function defaultRunnerKindForAgentType(
  agentType: AgentType | string | null | undefined,
): RunnerKind {
  const parsed = AgentTypeSchema.safeParse(agentType);
  if (parsed.success) {
    return DEFAULT_RUNNER_KIND_BY_AGENT_TYPE[parsed.data];
  }
  return DEFAULT_RUNNER_KIND_BY_AGENT_TYPE.coding;
}
