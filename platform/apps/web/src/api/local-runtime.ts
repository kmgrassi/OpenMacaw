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
  const response = await workspaceScopedFetch(workspaceId, localRuntimesRoute());
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to list local runtimes (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeListResponse;
}

export async function registerLocalRuntime(
  workspaceId: string,
  input: RegisterLocalRuntimeInput,
): Promise<RegisterLocalRuntimeResponse> {
  const response = await workspaceScopedFetch(workspaceId, localRuntimesRoute(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to register local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as RegisterLocalRuntimeResponse;
}

export async function removeLocalRuntime(
  workspaceId: string,
  machineId: string,
): Promise<void> {
  const response = await workspaceScopedFetch(workspaceId, localRuntimeRoute(machineId), {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to remove local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
}

export async function probeLocalModel(
  workspaceId: string,
  input: { endpoint: string; model: string },
): Promise<LocalModelProbeResponse> {
  const response = await workspaceScopedFetch(workspaceId, localRuntimeProbeRoute(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to probe local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalModelProbeResponse;
}

export async function probeRegisteredLocalRuntimeRunner(
  workspaceId: string,
  runnerId: string,
): Promise<LocalModelProbeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    localRuntimeRunnerProbeRoute(runnerId),
    { method: "POST" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to probe local runtime (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalModelProbeResponse;
}

export async function getLocalRuntimeConfig(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    localRuntimeConfigRoute(machineId),
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to regenerate local runtime config (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeConfigResponse;
}

export async function listLocalRuntimeEvents(
  workspaceId: string,
  machineId: string,
  limit = 50,
): Promise<LocalRuntimeEventsResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    localRuntimeEventsRoute(machineId, { limit }),
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to list local runtime events (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeEventsResponse;
}

export async function testLocalRuntimeDispatch(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeTestDispatchResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    localRuntimeTestDispatchRoute(machineId),
    { method: "POST" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to test local runtime dispatch (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeTestDispatchResponse;
}

export async function rotateLocalRuntimeToken(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeConfigResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    localRuntimeRotateTokenRoute(machineId),
    { method: "POST" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to rotate local runtime token (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as LocalRuntimeConfigResponse;
}

export async function assignLocalModelToAgent(
  workspaceId: string,
  agentId: string,
  input: AssignLocalModelInput,
): Promise<AssignLocalRuntimeResponse> {
  const response = await workspaceScopedFetch(
    workspaceId,
    agentAssignLocalModelRoute(agentId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to assign local model (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  return (await response.json()) as AssignLocalRuntimeResponse;
}
