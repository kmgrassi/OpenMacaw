import {
  agentAssignLocalModelRoute,
  localRuntimeConfigRoute,
  localRuntimeEventsRoute,
  localRuntimeProbeRoute,
  localRuntimesRoute,
  localRuntimeRotateTokenRoute,
  localRuntimeRoute,
  localRuntimeRunnerProbeRoute,
  localRuntimeTestDispatchRoute,
} from "../../../../contracts/routes";
import { workspaceScopedFetch } from "./workspace-scoped-fetch";

async function readErrorBody(response: Response) {
  return response.text().catch(() => "");
}

function buildRequestError(
  action: string,
  response: Response,
  body: string,
): Error {
  return new Error(
    `Failed to ${action} (${response.status})${body ? `: ${body}` : ""}`,
  );
}

async function requestLocalRuntimeJson<T>(
  workspaceId: string,
  path: string,
  action: string,
  init?: RequestInit,
): Promise<T> {
  const response = await workspaceScopedFetch(workspaceId, path, init);
  if (!response.ok) {
    throw buildRequestError(action, response, await readErrorBody(response));
  }
  return (await response.json()) as T;
}

async function requestLocalRuntimeVoid(
  workspaceId: string,
  path: string,
  action: string,
  init?: RequestInit,
): Promise<void> {
  const response = await workspaceScopedFetch(workspaceId, path, init);
  if (!response.ok) {
    throw buildRequestError(action, response, await readErrorBody(response));
  }
}

// ── Types ──────────────────────────────────────────────────────────────

export type LocalRuntimeAgent = {
  agentId: string;
  agentName: string;
};

export type LocalToolCallCapability =
  | "native_tools"
  | "prompt_fallback"
  | "no_tool_support";

export type LocalRuntimeRegistrationRunnerKind =
  | "openai_compatible"
  | "openclaw";

export type LocalExecutionTarget = {
  machineId: string | null;
  machineDisplayName: string | null;
  helperOnline: boolean;
  status: "online" | "offline" | "degraded";
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  workspaceRoot: string | null;
  registered: boolean;
  helperVersion: string | null;
  advertisedRunnerKinds: string[];
  advertisedModels: string[];
  runtimeManagedTools: boolean | null;
  diagnostics: LocalRuntimeDiagnostic[];
};

export type LocalRuntimeDiagnostic = {
  code:
    | "helper_not_connected"
    | "helper_heartbeat_stale"
    | "workspace_root_missing"
    | "helper_degraded"
    | "helper_not_registered";
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  action: string | null;
  command: string | null;
  logPath: string | null;
  detail: Record<string, unknown>;
};

export type LocalRuntimeModel = {
  id: string;
  machineId: string;
  runnerKind: string;
  model: string;
  provider: string | null;
  capabilities: Record<string, unknown>;
  lastAdvertisedAt: string;
};

/** One advertised runner attached to a registered helper machine. */
export type LocalRuntimeRunner = {
  /** Routing-rule id — the binding handle for agent assignments. */
  id: string;
  kind: LocalRuntimeRegistrationRunnerKind;
  runnerKind: string;
  endpoint: string;
  model: string;
  provider: string;
  toolCallCapability: LocalToolCallCapability | null;
  models: LocalRuntimeModel[];
  lastError: string | null;
  lastErrorAt: string | null;
  agents: LocalRuntimeAgent[];
};

export type LocalRuntime = {
  /** Machine id — identifies the helper registration. */
  id: string;
  machineDisplayName: string;
  status: "online" | "offline" | "degraded";
  lastError: string | null;
  models: LocalRuntimeModel[];
  localExecution: LocalExecutionTarget;
  runners: LocalRuntimeRunner[];
};

export type LocalRuntimeListResponse = {
  runtimes: LocalRuntime[];
  heartbeatIntervalMs: number;
};

export type OpenAICompatibleRunnerInput = {
  kind: "openai_compatible";
  endpoint: string;
  model: string;
  provider?: string;
  apiKey?: string;
  workspaceRoot?: string;
  toolCallCapability?: LocalToolCallCapability;
};

export type OpenClawRunnerInput = {
  kind: "openclaw";
  endpoint: string;
  apiKey?: string;
};

export type LocalRuntimeRunnerInput =
  | OpenAICompatibleRunnerInput
  | OpenClawRunnerInput;

export type RegisterLocalRuntimeInput = {
  machineDisplayName?: string;
  runners: LocalRuntimeRunnerInput[];
};

export type RegisterLocalRuntimeResponse = {
  id: string;
  machine: {
    id: string;
    displayName: string;
  };
  token: string;
  configSnippet: string;
  setupCommand: string;
  launchCommand: string;
  localExecution: LocalExecutionTarget;
  runners: LocalRuntimeRunner[];
};

export type LocalRuntimeConfigResponse = {
  id: string;
  token: string | null;
  tokenAvailable: boolean;
  configSnippet: string;
  setupCommand: string;
  launchCommand: string;
  filename: "runtime.toml";
};

export type LocalModelProbeResponse = {
  endpoint: string;
  model: string;
  reachable: boolean;
  modelFound: boolean;
  checkedAt: string;
  error: string | null;
};

export type AssignLocalModelInput = {
  machineId: string;
  localRuntimeId: string;
};

export type LocalRuntimeEvent = {
  id: string;
  machineId: string;
  workspaceId: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type LocalRuntimeEventsResponse = {
  events: LocalRuntimeEvent[];
};

export type LocalRuntimeTestDispatchError = {
  code: string;
  message: string;
  detail: {
    httpStatus?: number;
    dialError?: string;
    endpoint?: string;
    rawMessage?: string;
  } | null;
};

export type LocalRuntimeTestDispatchResponse = {
  machineId: string;
  helperConnected: boolean;
  modelAdvertised: boolean;
  dispatchSucceeded: boolean;
  error: LocalRuntimeTestDispatchError | null;
};

export type AssignLocalRuntimeResponse = {
  routingRuleId: string;
  agentId: string;
  machineId: string;
  model: string;
};

// ── API functions ──────────────────────────────────────────────────────

export async function listLocalRuntimes(
  workspaceId: string,
): Promise<LocalRuntimeListResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimesRoute(),
    "list local runtimes",
  );
}

export async function registerLocalRuntime(
  workspaceId: string,
  input: RegisterLocalRuntimeInput,
): Promise<RegisterLocalRuntimeResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimesRoute(),
    "register local runtime",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function removeLocalRuntime(
  workspaceId: string,
  machineId: string,
): Promise<void> {
  await requestLocalRuntimeVoid(
    workspaceId,
    localRuntimeRoute(machineId),
    "remove local runtime",
    {
      method: "DELETE",
    },
  );
}

export async function probeLocalModel(
  workspaceId: string,
  input: { endpoint: string; model: string },
): Promise<LocalModelProbeResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeProbeRoute(),
    "probe local runtime",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function probeRegisteredLocalRuntimeRunner(
  workspaceId: string,
  runnerId: string,
): Promise<LocalModelProbeResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeRunnerProbeRoute(runnerId),
    "probe local runtime",
    { method: "POST" },
  );
}

export async function getLocalRuntimeConfig(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeConfigRoute(machineId),
    "regenerate local runtime config",
  );
}

export async function listLocalRuntimeEvents(
  workspaceId: string,
  machineId: string,
  limit = 50,
): Promise<LocalRuntimeEventsResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeEventsRoute(machineId, { limit }),
    "list local runtime events",
  );
}

export async function testLocalRuntimeDispatch(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeTestDispatchResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeTestDispatchRoute(machineId),
    "test local runtime dispatch",
    { method: "POST" },
  );
}

export async function rotateLocalRuntimeToken(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    localRuntimeRotateTokenRoute(machineId),
    "rotate local runtime token",
    { method: "POST" },
  );
}

export async function assignLocalModelToAgent(
  workspaceId: string,
  agentId: string,
  input: AssignLocalModelInput,
): Promise<AssignLocalRuntimeResponse> {
  return requestLocalRuntimeJson(
    workspaceId,
    agentAssignLocalModelRoute(agentId),
    "assign local model",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
