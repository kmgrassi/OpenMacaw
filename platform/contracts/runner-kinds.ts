type RunnerWorkspaceWritePolicy = "role_coding" | "always" | "never";
type RunnerToolCallPolicy = "always" | "except_custom" | "never";
type RunnerCapabilityRole =
  | "planning"
  | "coding"
  | "manager"
  | "learning"
  | "router"
  | "learning"
  | "custom";
type RawRunnerRegistryEntry = {
  runnerFamily: string;
  executionLocation: string;
  transport: string;
  credentialless: boolean;
  localModelRuntime: boolean;
  localCodingRuntime: boolean;
  workspaceWrite: RunnerWorkspaceWritePolicy;
  toolCalls: RunnerToolCallPolicy;
  structuredOutput: boolean;
  interrupt: boolean;
};

export type RunnerExecutionCapabilities = {
  streaming: boolean;
  toolCalls: boolean;
  workspaceWrite: boolean;
  structuredOutput: boolean;
  interrupt: boolean;
};

/**
 * Valid runner_kind values and their execution policy metadata.
 * Must match the routing_rule.runner_kind check constraint in the database.
 *
 * To add a new runner kind:
 * 1. Add a DB migration updating the check constraint
 * 2. Run pnpm run supabase:schema:sync
 * 3. Add the value and dimensions here
 */
export const RUNNER_REGISTRY = {
  codex: {
    runnerFamily: "workspace_coding",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "always",
    toolCalls: "except_custom",
    structuredOutput: false,
    interrupt: true,
  },
  claude_code: {
    runnerFamily: "workspace_coding",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "always",
    toolCalls: "always",
    structuredOutput: false,
    interrupt: false,
  },
  openclaw: {
    runnerFamily: "custom_runtime",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "role_coding",
    toolCalls: "always",
    structuredOutput: false,
    interrupt: false,
  },
  local_model_coding: {
    runnerFamily: "workspace_coding",
    executionLocation: "local",
    transport: "local_relay",
    credentialless: true,
    localModelRuntime: false,
    localCodingRuntime: true,
    workspaceWrite: "role_coding",
    toolCalls: "always",
    structuredOutput: true,
    interrupt: true,
  },
  llm_tool_runner: {
    runnerFamily: "tool_calling_llm",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "role_coding",
    toolCalls: "always",
    structuredOutput: true,
    interrupt: false,
  },
  planner: {
    runnerFamily: "tool_calling_llm",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "never",
    toolCalls: "always",
    structuredOutput: true,
    interrupt: false,
  },
  openclaw_ws: {
    runnerFamily: "custom_runtime",
    executionLocation: "external",
    transport: "websocket",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "always",
    toolCalls: "always",
    structuredOutput: false,
    interrupt: true,
  },
  openclaw_http_sse: {
    runnerFamily: "custom_runtime",
    executionLocation: "external",
    transport: "http_sse",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "role_coding",
    toolCalls: "always",
    structuredOutput: false,
    interrupt: false,
  },
  computer_use: {
    runnerFamily: "computer_use",
    executionLocation: "cloud",
    transport: "launcher",
    credentialless: false,
    localModelRuntime: false,
    localCodingRuntime: false,
    workspaceWrite: "role_coding",
    toolCalls: "always",
    structuredOutput: false,
    interrupt: true,
  },
  /**
   * Local model chat reached via the helper-daemon websocket relay
   * (see runtime's SymphonyElixir.LocalRelay module). The runtime side
   * dispatches this via the relay socket; the helper daemon connects out
   * and registers its capabilities. Registered local-machine identities
   * (local_runtime_machine table + apps/api/src/routes/local-runtime.ts)
   * route through this kind — the runtime has no direct-connection
   * transport for local models.
   */
  local_relay: {
    runnerFamily: "model_chat",
    executionLocation: "local",
    transport: "local_relay",
    credentialless: true,
    localModelRuntime: true,
    localCodingRuntime: false,
    workspaceWrite: "never",
    toolCalls: "never",
    structuredOutput: false,
    interrupt: false,
  },
} as const satisfies Record<string, RawRunnerRegistryEntry>;

export type RunnerKind = keyof typeof RUNNER_REGISTRY;
export type RunnerFamily = (typeof RUNNER_REGISTRY)[RunnerKind]["runnerFamily"];
export type ExecutionLocation =
  (typeof RUNNER_REGISTRY)[RunnerKind]["executionLocation"];
export type RoutingTransport =
  (typeof RUNNER_REGISTRY)[RunnerKind]["transport"];

export type RoutingExecutionDimensions = {
  runnerFamily: RunnerFamily;
  executionLocation: ExecutionLocation;
  transport: RoutingTransport;
};

export type RunnerRegistryEntry = RoutingExecutionDimensions &
  Omit<
    RawRunnerRegistryEntry,
    "runnerFamily" | "executionLocation" | "transport"
  >;

export const RUNNER_KINDS = Object.keys(RUNNER_REGISTRY) as [
  RunnerKind,
  ...RunnerKind[],
];

function uniqueRegistryValues<Key extends keyof RunnerRegistryEntry>(key: Key) {
  return Array.from(
    new Set(RUNNER_KINDS.map((kind) => RUNNER_REGISTRY[kind][key])),
  ) as [RunnerRegistryEntry[Key], ...RunnerRegistryEntry[Key][]];
}

export const RUNNER_FAMILIES = uniqueRegistryValues("runnerFamily") as [
  RunnerFamily,
  ...RunnerFamily[],
];

export const EXECUTION_LOCATIONS = uniqueRegistryValues(
  "executionLocation",
) as [ExecutionLocation, ...ExecutionLocation[]];

export const ROUTING_TRANSPORTS = uniqueRegistryValues("transport") as [
  RoutingTransport,
  ...RoutingTransport[],
];

export const ROUTING_EXECUTION_DIMENSIONS_BY_RUNNER_KIND: Record<
  RunnerKind,
  RoutingExecutionDimensions
> = Object.fromEntries(
  RUNNER_KINDS.map((kind) => [kind, dimensionsForRunnerKind(kind)]),
) as Record<RunnerKind, RoutingExecutionDimensions>;

export function dimensionsForRunnerKind(
  kind: RunnerKind,
): RoutingExecutionDimensions {
  const { runnerFamily, executionLocation, transport } = RUNNER_REGISTRY[kind];
  return { runnerFamily, executionLocation, transport };
}

/** Runner kinds that represent local model execution (skip credential checks). */
export const LOCAL_RUNNER_KIND_VALUES = RUNNER_KINDS.filter(
  (kind) => RUNNER_REGISTRY[kind].localModelRuntime,
) as [RunnerKind, ...RunnerKind[]];

export const LOCAL_RUNNER_KINDS = new Set<RunnerKind>(LOCAL_RUNNER_KIND_VALUES);

const RUNNER_KIND_SET = new Set<RunnerKind>(RUNNER_KINDS);

export function isRunnerKind(value: string): value is RunnerKind {
  return RUNNER_KIND_SET.has(value as RunnerKind);
}

export function normalizeRunnerKind(value: unknown): RunnerKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return isRunnerKind(normalized) ? normalized : null;
}

/** Check if a runner kind represents local model execution. */
export function isLocalRunnerKind(kind: string): boolean {
  return isRunnerKind(kind) && RUNNER_REGISTRY[kind].localModelRuntime;
}

export function isCredentiallessRunnerKind(kind: RunnerKind): boolean {
  return RUNNER_REGISTRY[kind].credentialless;
}

export function isLocalCodingRunnerKind(kind: RunnerKind): boolean {
  return RUNNER_REGISTRY[kind].localCodingRuntime;
}

export function capabilitiesForRunnerKind(
  kind: RunnerKind,
  role: RunnerCapabilityRole,
): RunnerExecutionCapabilities {
  const entry = RUNNER_REGISTRY[kind];

  return {
    streaming: true,
    toolCalls:
      entry.toolCalls === "always" ||
      (entry.toolCalls === "except_custom" && role !== "custom"),
    workspaceWrite:
      entry.workspaceWrite === "always" ||
      (entry.workspaceWrite === "role_coding" && role === "coding"),
    structuredOutput: entry.structuredOutput,
    interrupt: entry.interrupt,
  };
}
