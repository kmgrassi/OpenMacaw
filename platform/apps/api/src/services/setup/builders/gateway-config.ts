import type { RunnerKind } from "../../../../../../contracts/execution-profile.js";
import type { DefaultAgentRole, SetupRequest, SetupUpdateRequest } from "../../../../../../contracts/setup.js";
import { agentType } from "./agent-defaults.js";
import type { ResolvedExecutionProfileBlock } from "./execution-profile.js";

function defaultTracker() {
  return { kind: "database", table: "work_items" };
}

export function defaultAgentGatewayConfig(
  role: DefaultAgentRole,
  provider: string,
  model: string,
  runnerKind: RunnerKind = "codex",
  executionProfile: ResolvedExecutionProfileBlock | null = null,
) {
  return {
    tracker: defaultTracker(),
    workflow_template: { id: `${role}-default` },
    runners: [{ kind: runnerKind, model, provider }],
    max_concurrent_agents: 1,
    ...(executionProfile ? { execution_profile: executionProfile } : {}),
  };
}

function existingCustomTarget(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {};
  }
  const backend = (config as Record<string, unknown>).backend;
  return backend && typeof backend === "object" && !Array.isArray(backend) ? { backend } : {};
}

function gatewayCustomTarget(input: SetupRequest | SetupUpdateRequest, existingConfig?: unknown) {
  if (!input.customTarget) return existingCustomTarget(existingConfig);
  return {
    backend: {
      type: input.customTarget.backend.type,
      base_url: input.customTarget.backend.baseUrl,
      ...(input.customTarget.backend.agentId ? { agent_id: input.customTarget.backend.agentId } : {}),
    },
  };
}

function claudeCodeAdapterConfig() {
  const tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
  return {
    permission_mode: "acceptEdits",
    tools,
    allowed_tools: tools,
  };
}

function runnerDefaults(kind: string) {
  if (kind === "claude_code") {
    return {
      adapter_config: claudeCodeAdapterConfig(),
    };
  }
  return {};
}

function buildRunnerConfig(runner: SetupRequest["runners"][number]) {
  return {
    kind: runner.kind,
    model: runner.model,
    ...(runner.provider ? { provider: runner.provider } : {}),
    ...runnerDefaults(runner.kind),
    ...runner.config,
  };
}

export function buildGatewayConfig(
  input: SetupRequest | SetupUpdateRequest,
  type = agentType(input),
  existingConfig?: unknown,
  executionProfile: ResolvedExecutionProfileBlock | null = null,
) {
  const runners = input.runners.map(buildRunnerConfig);

  return {
    ...(type === "custom" ? gatewayCustomTarget(input, existingConfig) : {}),
    runners,
    workflow_template: {
      id: input.workflowTemplate,
      ...(input.repositoryUrl ? { repository_url: input.repositoryUrl } : {}),
    },
    max_concurrent_agents: input.maxConcurrentAgents,
    ...(executionProfile ? { execution_profile: executionProfile } : {}),
  };
}

function configuredRunner(provider: string, model: string, existingRunner?: unknown) {
  const existing =
    existingRunner && typeof existingRunner === "object" && !Array.isArray(existingRunner)
      ? (existingRunner as Record<string, unknown>)
      : {};

  return {
    ...existing,
    kind: typeof existing.kind === "string" && existing.kind.trim() ? existing.kind : "codex",
    model,
    provider,
  };
}

export function repairGatewayConfig(
  configJson: unknown,
  role: DefaultAgentRole,
  provider: string,
  model: string,
  runnerKind?: RunnerKind,
  executionProfile: ResolvedExecutionProfileBlock | null = null,
) {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) {
    return defaultAgentGatewayConfig(role, provider, model, runnerKind, executionProfile);
  }

  const config = configJson as Record<string, unknown>;
  const runners = Array.isArray(config.runners) ? config.runners : [];

  // Drop any stale `execution_profile` from the existing config so a missing
  // resolution overwrites rather than preserving an old credential ref.
  const { execution_profile: _staleProfile, ...configWithoutProfile } = config;
  const existingTracker =
    config.tracker && typeof config.tracker === "object" && !Array.isArray(config.tracker)
      ? (config.tracker as Record<string, unknown>)
      : null;

  return {
    ...configWithoutProfile,
    tracker: existingTracker ?? defaultTracker(),
    runners:
      runners.length > 0
        ? runners.map((runner, index) =>
            index === 0
              ? configuredRunner(provider, model, runnerKind ? { ...(runner as object), kind: runnerKind } : runner)
              : runner,
          )
        : [configuredRunner(provider, model, runnerKind ? { kind: runnerKind } : undefined)],
    ...(executionProfile ? { execution_profile: executionProfile } : {}),
  };
}

export function repairManagerGatewayConfig(input: {
  configJson: unknown;
  provider: string;
  model: string;
  runnerKind: RunnerKind;
  cadenceMs?: number;
  executionProfile?: ResolvedExecutionProfileBlock | null;
}) {
  return repairLlmToolGatewayConfig({
    ...input,
    agentType: "manager",
    runnerKey: "manager",
    workflowTemplateId: "manager-default",
  });
}

export function repairLlmToolGatewayConfig(input: {
  configJson: unknown;
  provider: string;
  model: string;
  runnerKind: RunnerKind;
  agentType: "manager" | "learning" | "router";
  runnerKey?: string;
  workflowTemplateId?: string;
  cadenceMs?: number;
  executionProfile?: ResolvedExecutionProfileBlock | null;
}) {
  const config =
    input.configJson && typeof input.configJson === "object" && !Array.isArray(input.configJson)
      ? { ...(input.configJson as Record<string, unknown>) }
      : {};
  const runners =
    config.runners && typeof config.runners === "object" && !Array.isArray(config.runners)
      ? { ...(config.runners as Record<string, unknown>) }
      : {};
  const manager =
    runners[input.runnerKey ?? input.agentType] &&
    typeof runners[input.runnerKey ?? input.agentType] === "object" &&
    !Array.isArray(runners[input.runnerKey ?? input.agentType])
      ? { ...(runners[input.runnerKey ?? input.agentType] as Record<string, unknown>) }
      : {};

  // Drop any stale `execution_profile` block so a missing resolution
  // overwrites rather than preserving an old credential ref.
  const { execution_profile: _staleProfile, ...configWithoutProfile } = config;

  // Manager agents share the same minimum required-config shape as
  // planning/coding agents: the runtime launcher rejects any agent whose
  // gateway_config lacks `tracker.kind` (see
  // apps/orchestrator/lib/symphony_elixir/launcher/agent_starter.ex `tracker.kind is required`).
  // First-write manager configs were previously coming through with only
  // `{ runners: { manager } }` because this repair function did not seed
  // tracker/workflow_template defaults, so the manager launch failed with
  // `missing_tracker_kind` until someone hand-patched the row. Default them
  // here to match `defaultAgentGatewayConfig` for planning/coding agents.
  const existingTracker =
    config.tracker && typeof config.tracker === "object" && !Array.isArray(config.tracker)
      ? (config.tracker as Record<string, unknown>)
      : null;
  const tracker = existingTracker ?? defaultTracker();
  const existingWorkflowTemplate =
    config.workflow_template && typeof config.workflow_template === "object" && !Array.isArray(config.workflow_template)
      ? (config.workflow_template as Record<string, unknown>)
      : null;
  const workflowTemplate = existingWorkflowTemplate ?? { id: input.workflowTemplateId ?? `${input.agentType}-default` };
  const runnerKey = input.runnerKey ?? input.agentType;

  return {
    ...configWithoutProfile,
    tracker,
    workflow_template: workflowTemplate,
    runners: {
      ...runners,
      [runnerKey]: {
        ...manager,
        kind: input.runnerKind,
        provider: input.provider,
        model: input.model,
        ...(input.cadenceMs ? { cadence_ms: input.cadenceMs } : {}),
      },
    },
    ...(input.executionProfile ? { execution_profile: input.executionProfile } : {}),
  };
}
