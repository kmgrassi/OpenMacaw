import type {
  LocalRuntimeDiagnostic,
  LocalRuntimeRegistrationRunnerKind,
  LocalToolCallCapability,
} from "../../../../../contracts/local-runtime.js";
import type { Tables } from "@kmgrassi/supabase-schema";

export const LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS = 30_000;
const HELPER_ONLINE_WINDOW_MS = LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS * 2;
const HELPER_DOCTOR_COMMAND = "local-runtime-helper doctor --config ~/.config/openmacaw/runtime.toml";
const HELPER_START_COMMAND = "local-runtime-helper start --config ~/.config/openmacaw/runtime.toml";

export type LocalRuntimeMachineRow = Pick<
  Tables<"local_runtime_machine">,
  "id" | "display_name" | "last_seen_at" | "revoked_at" | "runner_kinds" | "advertised_runner_kinds"
> & { status?: "online" | "offline" | "degraded" };

export function helperOnline(lastSeenAt: string | null | undefined) {
  if (!lastSeenAt) return false;
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= HELPER_ONLINE_WINDOW_MS;
}

function heartbeatAgeMs(lastSeenAt: string | null | undefined) {
  if (!lastSeenAt) return null;
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Date.now() - timestamp);
}

export function normalizeToolCallCapability(value: string | null): LocalToolCallCapability {
  if (value === "prompt_fallback" || value === "no_tool_support") return value;
  return "native_tools";
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

export function buildLaunchCommand() {
  return "local-runtime-helper start";
}

export type RunnerSnippet =
  | {
      kind: "openai_compatible";
      endpoint: string;
      apiKey: string | null;
      model: string;
      toolCallCapability: LocalToolCallCapability;
    }
  | {
      kind: "openclaw";
      endpoint: string;
      apiKey: string | null;
    };

export type ConfigSnippetInput = {
  machineId: string;
  displayName: string;
  /** Workspace root applies to the openai_compatible runner only; rendered on the [machine] table. */
  workspaceRoot: string | null;
  runtimeEndpoint: string;
  workspaceId: string;
  token: string;
  runners: RunnerSnippet[];
};

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSetupCommand(input: ConfigSnippetInput) {
  const args = [
    "register",
    "--endpoint",
    input.runtimeEndpoint,
    "--workspace",
    input.workspaceId,
    "--machine-id",
    input.machineId,
    "--name",
    input.displayName,
    "--token",
    input.token,
    "--force",
  ];
  if (input.workspaceRoot) {
    args.push("--workspace-root", input.workspaceRoot);
  }
  for (const runner of input.runners) {
    if (runner.kind === "openai_compatible") {
      args.push(
        "--openai-compatible-endpoint",
        runner.endpoint,
        "--openai-compatible-model",
        runner.model,
        "--tool-call-capability",
        runner.toolCallCapability,
      );
      if (runner.apiKey) args.push("--openai-compatible-api-key", runner.apiKey);
    } else {
      args.push("--openclaw-endpoint", runner.endpoint);
      if (runner.apiKey) args.push("--openclaw-api-key", runner.apiKey);
    }
  }

  const helperArgs = args.map(shellQuote).join(" ");
  return [
    'GOBIN="$(go env GOBIN)"',
    'GOPATH="$(go env GOPATH)"',
    'HELPER_BIN="${GOBIN:-$GOPATH/bin}/local-runtime-helper"',
    "cd local-runtime-helper",
    "go install ./cmd/local-runtime-helper",
    `"$HELPER_BIN" ${helperArgs}`,
    '"$HELPER_BIN" start',
  ].join(" && ");
}

export function buildConfigSnippet(input: ConfigSnippetInput) {
  const header = [
    "[machine]",
    `id = ${tomlString(input.machineId)}`,
    `display_name = ${tomlString(input.displayName)}`,
    input.workspaceRoot ? `workspace_root = ${tomlString(input.workspaceRoot)}` : null,
    "",
    "[cloud]",
    `endpoint = ${tomlString(input.runtimeEndpoint)}`,
    `workspace_id = ${tomlString(input.workspaceId)}`,
    `token = ${tomlString(input.token)}`,
  ];

  const runnerStanzas = input.runners.flatMap((runner) => {
    if (runner.kind === "openclaw") {
      return [
        "",
        "[runner.openclaw]",
        `endpoint = ${tomlString(runner.endpoint)}`,
        runner.apiKey ? `api_key = ${tomlString(runner.apiKey)}` : null,
      ];
    }
    return [
      "",
      "[runner.openai_compatible]",
      `endpoint = ${tomlString(runner.endpoint)}`,
      `model = ${tomlString(runner.model)}`,
      runner.apiKey ? `api_key = ${tomlString(runner.apiKey)}` : null,
      `tool_call_capability = ${tomlString(runner.toolCallCapability)}`,
    ];
  });

  return [...header, ...runnerStanzas].filter((line): line is string => line !== null).join("\n");
}

export function buildLocalExecution(input: { machine: LocalRuntimeMachineRow | null; workspaceRoot: string | null }) {
  const helperOnlineNow = helperOnline(input.machine?.last_seen_at);
  const ageMs = heartbeatAgeMs(input.machine?.last_seen_at);
  const persistedStatus = input.machine?.status ?? "offline";
  const status: "online" | "offline" | "degraded" = helperOnlineNow
    ? persistedStatus === "offline"
      ? "online"
      : persistedStatus
    : "offline";
  const diagnostics = buildLocalRuntimeDiagnostics({
    machine: input.machine,
    workspaceRoot: input.workspaceRoot,
    helperOnline: helperOnlineNow,
    heartbeatAgeMs: ageMs,
    status,
  });
  return {
    machineId: input.machine?.id ?? null,
    machineDisplayName: input.machine?.display_name ?? null,
    status,
    helperOnline: helperOnlineNow,
    lastSeenAt: input.machine?.last_seen_at ?? null,
    workspaceRoot: input.workspaceRoot,
    registered: Boolean(input.machine && input.workspaceRoot),
    helperVersion: null,
    advertisedRunnerKinds: input.machine?.advertised_runner_kinds ?? [],
    advertisedModels: [],
    runtimeManagedTools: null,
    lastError: null,
    lastErrorAt: null,
    diagnostics,
  };
}

function buildLocalRuntimeDiagnostics(input: {
  machine: LocalRuntimeMachineRow | null;
  workspaceRoot: string | null;
  helperOnline: boolean;
  heartbeatAgeMs: number | null;
  status: "online" | "offline" | "degraded";
}): LocalRuntimeDiagnostic[] {
  const diagnostics: LocalRuntimeDiagnostic[] = [];

  if (!input.machine) {
    diagnostics.push({
      code: "helper_not_registered",
      severity: "error",
      title: "Local runtime is not registered",
      message: "Register a local runtime for this workspace before routing agents to a local model.",
      action: "Create a new local runtime registration and run the generated setup command.",
      command: null,
      logPath: null,
      detail: {},
    });
    return diagnostics;
  }

  if (!input.helperOnline) {
    const hasHeartbeat = Boolean(input.machine.last_seen_at);
    diagnostics.push({
      code: hasHeartbeat ? "helper_heartbeat_stale" : "helper_not_connected",
      severity: "error",
      title: hasHeartbeat ? "Helper heartbeat is stale" : "Helper has not connected",
      message: hasHeartbeat
        ? "The helper was registered before, but production has not received a fresh relay heartbeat."
        : "Production has not received a relay registration from this helper.",
      action:
        "Run the helper doctor on the local machine. If it passes, start or restart the helper, then refresh this page and run the dispatch test.",
      command: `${HELPER_DOCTOR_COMMAND} && ${HELPER_START_COMMAND}`,
      logPath: null,
      detail: {
        machineId: input.machine.id,
        lastSeenAt: input.machine.last_seen_at,
        heartbeatAgeMs: input.heartbeatAgeMs,
        heartbeatTimeoutMs: HELPER_ONLINE_WINDOW_MS,
      },
    });
  }

  if (!input.workspaceRoot) {
    diagnostics.push({
      code: "workspace_root_missing",
      severity: "warning",
      title: "Workspace root is missing",
      message: "Local helper commands need a workspace root so relative paths resolve on the helper machine.",
      action: "Regenerate the local runtime config with a repository root and restart the helper.",
      command: null,
      logPath: null,
      detail: { machineId: input.machine.id },
    });
  }

  if (input.status === "degraded") {
    diagnostics.push({
      code: "helper_degraded",
      severity: "warning",
      title: "Helper is connected but degraded",
      message: "The helper is online, but its last advertised state indicates at least one runner is not healthy.",
      action: "Run the helper doctor and dispatch test to identify the failing runner.",
      command: HELPER_DOCTOR_COMMAND,
      logPath: null,
      detail: { machineId: input.machine.id },
    });
  }

  return diagnostics;
}

export type { LocalRuntimeRegistrationRunnerKind };
