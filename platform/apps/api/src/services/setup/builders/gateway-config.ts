import type { RunnerKind } from "../../../../../../contracts/execution-profile.js";
import type { DefaultAgentRole, SetupRequest, SetupUpdateRequest } from "../../../../../../contracts/setup.js";
import { agentType } from "./agent-defaults.js";
import type { ResolvedExecutionProfileBlock } from "./execution-profile.js";

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

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
    runners: [{ kind: runnerKind, model, provider, agent_type: role }],
    max_concurrent_agents: 1,
    ...(executionProfile ? { execution_profile: executionProfile } : {}),
  };
}

function existingCustomTarget(config: unknown) {
  const backend = asPlainObject(config)?.backend;
  return asPlainObject(backend) ? { backend } : {};
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
  const existing = asPlainObject(existingRunner) ?? {};

  return {
    ...existing,
    kind: typeof existing.kind === "string" && existing.kind.trim() ? existing.kind : "codex",
    model,
    provider,
  };
}

function withoutExecutionProfile(config: Record<string, unknown>) {
  const { execution_profile: _staleProfile, ...configWithoutProfile } = config;
  return configWithoutProfile;
}

export function repairGatewayConfig(
  configJson: unknown,
  role: DefaultAgentRole,
  provider: string,
  model: string,
  runnerKind?: RunnerKind,
  executionProfile: ResolvedExecutionProfileBlock | null = null,
) {
  const config = asPlainObject(configJson);
  if (!config) {
    return defaultAgentGatewayConfig(role, provider, model, runnerKind, executionProfile);
  }

  const runners = Array.isArray(config.runners) ? config.runners : [];

  // Drop any stale `execution_profile` from the existing config so a missing
  // resolution overwrites rather than preserving an old credential ref.
  const configWithoutProfile = withoutExecutionProfile(config);
  const existingTracker = asPlainObject(config.tracker);

  return {
    ...configWithoutProfile,
    tracker: existingTracker ?? defaultTracker(),
    runners:
      runners.length > 0
        ? runners.map((runner, index) =>
            index === 0
              ? configuredRunner(provider, model, {
                  ...(runner as object),
                  ...(runnerKind ? { kind: runnerKind } : {}),
                  agent_type: role,
                })
              : runner,
          )
        : [configuredRunner(provider, model, { ...(runnerKind ? { kind: runnerKind } : {}), agent_type: role })],
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
  const config = { ...(asPlainObject(input.configJson) ?? {}) };
  const runners = { ...(asPlainObject(config.runners) ?? {}) };
  const runnerKey = input.runnerKey ?? input.agentType;
  const manager = { ...(asPlainObject(runners[runnerKey]) ?? {}) };

  // Drop any stale `execution_profile` block so a missing resolution
  // overwrites rather than preserving an old credential ref.
  const configWithoutProfile = withoutExecutionProfile(config);

  // Manager agents share the same minimum required-config shape as
  // planning/coding agents: the runtime launcher rejects any agent whose
  // gateway_config lacks `tracker.kind` (see
  // apps/orchestrator/lib/symphony_elixir/launcher/agent_starter.ex `tracker.kind is required`).
  // First-write manager configs were previously coming through with only
  // `{ runners: { manager } }` because this repair function did not seed
  // tracker/workflow_template defaults, so the manager launch failed with
  // `missing_tracker_kind` until someone hand-patched the row. Default them
  // here to match `defaultAgentGatewayConfig` for planning/coding agents.
  const existingTracker = asPlainObject(config.tracker);
  const tracker = existingTracker ?? defaultTracker();
  const existingWorkflowTemplate = asPlainObject(config.workflow_template);
  const workflowTemplate = existingWorkflowTemplate ?? { id: input.workflowTemplateId ?? `${input.agentType}-default` };

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
