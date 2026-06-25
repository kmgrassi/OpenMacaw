import type { Request } from "express";

import type { Tables } from "@kmgrassi/supabase-schema";
import { isLocalCodingRunnerKind, isLocalRunnerKind } from "../../../../contracts/runner-kinds.js";
import { isStoredAgentRuntimeSelectable, listStoredAgentsFromSupabase } from "./stored-agent-management.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { logHandledServiceError, withServiceLogging } from "./service-logging.js";
import type { UpstreamResponse } from "./upstream.js";

type EngineInstanceRow = Pick<
  Tables<"engine_instance">,
  "agent_id" | "host" | "instance_id" | "port" | "started_at" | "status" | "workspace_id"
>;

export type RuntimeTarget = {
  agentId: string;
  host: string;
  port: number;
  workspaceId: string;
  instanceId: string;
  startedAt: string;
  baseUrl: string;
  wsUrl: string;
};

export class RuntimeTargetError extends Error {
  statusCode: number;
  code: string;
  retriable: boolean;

  constructor(init: { message: string; statusCode: number; code: string; retriable?: boolean }) {
    super(init.message);
    this.name = "RuntimeTargetError";
    this.statusCode = init.statusCode;
    this.code = init.code;
    this.retriable = Boolean(init.retriable);
  }
}

function toRuntimeTarget(row: EngineInstanceRow): RuntimeTarget {
  const launcherBaseUrl = process.env.LAUNCHER_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:4100";
  const agentPath = `/agents/${encodeURIComponent(row.agent_id)}/runtime`;
  const launcherWsUrl = launcherBaseUrl.replace(/^http/i, "ws");

  return {
    agentId: row.agent_id,
    host: row.host,
    port: row.port,
    workspaceId: row.workspace_id,
    instanceId: row.instance_id,
    startedAt: row.started_at,
    baseUrl: `${launcherBaseUrl}${agentPath}`,
    wsUrl: `${launcherWsUrl}${agentPath}/ws`,
  };
}

function orchestratorBaseUrl(): string {
  return (process.env.ORCHESTRATOR_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
}

function orchestratorWsUrl(): string {
  const explicit = process.env.ORCHESTRATOR_WS_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  return orchestratorBaseUrl().replace(/^http/i, "ws");
}

/**
 * Runtime target for the shared local orchestrator process. Local-runner
 * agents resolve to this target; callers without an agent in scope (e.g.
 * machine-level local runtime diagnostics before an agent is assigned) use it
 * directly so every consumer reads the orchestrator location from one place.
 */
export function localOrchestratorRuntimeTarget(init: { agentId?: string; workspaceId?: string } = {}): RuntimeTarget {
  const baseUrl = orchestratorBaseUrl();
  const parsedBaseUrl = new URL(baseUrl);
  return {
    agentId: init.agentId ?? "unscoped",
    host: parsedBaseUrl.hostname || "orchestrator",
    port: Number(parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? 443 : 80)),
    workspaceId: init.workspaceId ?? "unknown",
    instanceId: "local-orchestrator",
    startedAt: new Date(0).toISOString(),
    baseUrl,
    wsUrl: `${orchestratorWsUrl()}/ws`,
  };
}

async function resolveLocalOrchestratorTarget(agentId: string): Promise<RuntimeTarget | null> {
  let resolution: Awaited<ReturnType<typeof resolveExecutionProfile>>;
  try {
    resolution = await resolveExecutionProfile({ agentId, skipCredentialCheck: true });
  } catch (error) {
    logHandledServiceError({
      operation: "runtime_target.resolve_local_orchestrator",
      inputSummary: { agent_id: agentId },
      error,
      nextAction: "fallback_to_launcher",
    });
    return null;
  }

  const runnerKind = resolution.profile?.runnerKind;
  if (!runnerKind) return null;
  if (!isLocalRunnerKind(runnerKind) && !isLocalCodingRunnerKind(runnerKind)) {
    return null;
  }

  return localOrchestratorRuntimeTarget({
    agentId,
    workspaceId: resolution.profile?.workspaceId ?? "unknown",
  });
}

function launcherRuntimeTarget(
  agentId: string,
  workspaceId = "unknown",
  instanceId = "launcher-runtime",
): RuntimeTarget {
  const launcherBaseUrl = process.env.LAUNCHER_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:4100";
  const agentPath = `/agents/${encodeURIComponent(agentId)}/runtime`;
  const launcherWsUrl = launcherBaseUrl.replace(/^http/i, "ws");
  const parsedBaseUrl = new URL(launcherBaseUrl);

  return {
    agentId,
    host: parsedBaseUrl.hostname || "launcher",
    port: Number(parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? 443 : 80)),
    workspaceId,
    instanceId,
    startedAt: new Date(0).toISOString(),
    baseUrl: `${launcherBaseUrl}${agentPath}`,
    wsUrl: `${launcherWsUrl}${agentPath}/ws`,
  };
}

function isRetriableEngineStatus(status: string | null | undefined) {
  return status === "starting" || status === "draining";
}

function isReadyEngineStatus(status: string | null | undefined) {
  return status === "running" || status === "healthy";
}

async function queryLatestEngineInstance(agentId: string): Promise<EngineInstanceRow | null> {
  const rows = await executeSupabaseRows<EngineInstanceRow>(
    "engine_instance query",
    getServiceRoleSupabase()
      .from("engine_instance")
      .select("agent_id,host,instance_id,port,started_at,status,workspace_id")
      .eq("agent_id", agentId)
      .order("started_at", { ascending: false })
      .limit(1),
  );

  return rows[0] ?? null;
}

async function refreshAgentOnLauncher(
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  agentId: string,
) {
  try {
    await launcherRequest(`/agents/${encodeURIComponent(agentId)}`, { method: "GET" });
  } catch (error) {
    logHandledServiceError({
      operation: "runtime_target.refresh_launcher_agent",
      inputSummary: { agent_id: agentId },
      error,
      nextAction: "requery_engine_instance",
    });
  }
}

async function resolveLauncherRuntimeTarget(
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
  agentId: string,
): Promise<RuntimeTarget | null> {
  try {
    const response = await launcherRequest(`/agents/${encodeURIComponent(agentId)}/runtime/api/v1/health`, {
      method: "GET",
    });

    if (response.status >= 200 && response.status < 300) {
      return launcherRuntimeTarget(agentId);
    }
  } catch (error) {
    logHandledServiceError({
      operation: "runtime_target.probe_launcher_health",
      inputSummary: { agent_id: agentId },
      error,
      nextAction: "fallback_to_engine_instance",
    });
  }

  return null;
}

function runtimeUnavailableForStatus(agentId: string, status: string) {
  return new RuntimeTargetError({
    statusCode: 503,
    code: "runtime_not_ready",
    retriable: true,
    message: `Runtime for agent ${agentId} is ${status}. Retry shortly.`,
  });
}

function runtimeMissing(agentId: string) {
  return new RuntimeTargetError({
    statusCode: 404,
    code: "runtime_not_found",
    message: `No running runtime found for agent ${agentId}.`,
  });
}

export async function resolveRuntimeTargetForAgent(
  agentId: string,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
): Promise<RuntimeTarget> {
  return withServiceLogging(
    {
      operation: "runtime_target.resolve_for_agent",
      inputSummary: { agent_id: agentId },
    },
    () => resolveRuntimeTargetForAgentImpl(agentId, launcherRequest),
  );
}

async function resolveRuntimeTargetForAgentImpl(
  agentId: string,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
): Promise<RuntimeTarget> {
  // Local-runner agents (local_relay / local_model_coding)
  // do not run as launcher-managed per-agent instances. They share the main
  // orchestrator process and dispatch via the local-relay socket / helper.
  // Route their websocket directly to the orchestrator's gateway endpoint.
  const localTarget = await resolveLocalOrchestratorTarget(agentId);
  if (localTarget) {
    return localTarget;
  }

  let latest = await queryLatestEngineInstance(agentId);

  if (isReadyEngineStatus(latest?.status)) {
    return toRuntimeTarget(latest);
  }
  if (isRetriableEngineStatus(latest?.status)) {
    throw runtimeUnavailableForStatus(agentId, String(latest?.status));
  }

  const launcherTarget = await resolveLauncherRuntimeTarget(launcherRequest, agentId);
  if (launcherTarget) {
    return launcherTarget;
  }

  await refreshAgentOnLauncher(launcherRequest, agentId);
  latest = await queryLatestEngineInstance(agentId);

  if (isReadyEngineStatus(latest?.status)) {
    return toRuntimeTarget(latest);
  }
  if (isRetriableEngineStatus(latest?.status)) {
    throw runtimeUnavailableForStatus(agentId, String(latest?.status));
  }

  const refreshedLauncherTarget = await resolveLauncherRuntimeTarget(launcherRequest, agentId);
  if (refreshedLauncherTarget) {
    return refreshedLauncherTarget;
  }

  throw runtimeMissing(agentId);
}

export async function resolveDefaultAgentId(accessToken: string): Promise<string | null> {
  const agents = await listStoredAgentsFromSupabase({ accessToken, userId: "" });
  return (
    agents.find((agent) => agent.isResolved && isStoredAgentRuntimeSelectable(agent))?.id ??
    agents.find(isStoredAgentRuntimeSelectable)?.id ??
    null
  );
}

function valueFromQuery(source: unknown): string | null {
  if (typeof source === "string" && source.trim().length > 0) return source.trim();
  if (Array.isArray(source)) {
    const first = source.find((value) => typeof value === "string" && value.trim().length > 0);
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
}

function valueFromWildcardPath(source: unknown): string | null {
  const raw = valueFromQuery(source);
  if (!raw) return null;

  const candidate = raw.replace(/^\/+/, "").split("/", 1)[0]?.trim() || "";
  if (!candidate) return null;

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

export function requestAgentId(req: Request): string | null {
  return (
    valueFromQuery(req.params.id) ||
    valueFromQuery(req.params.identifier) ||
    valueFromWildcardPath(req.params[0]) ||
    valueFromQuery(req.query.agentId) ||
    (typeof req.body?.agentId === "string" && req.body.agentId.trim().length > 0 ? req.body.agentId.trim() : null)
  );
}

export async function resolveRequestAgentId(req: Request, accessToken: string): Promise<string | null> {
  return requestAgentId(req) ?? (await resolveDefaultAgentId(accessToken));
}
