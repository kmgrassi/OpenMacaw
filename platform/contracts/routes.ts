function appendWorkspaceQuery(path: string, workspaceId?: string | null) {
  return workspaceId
    ? `${path}?workspaceId=${encodeURIComponent(workspaceId)}`
    : path;
}

function appendQuery(
  path: string,
  params: Record<string, string | number | null | undefined>,
) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

const STORED_AGENTS_PREFIX = "/api/stored-agents";
const AGENTS_PREFIX = "/api/agents";
const SESSIONS_PREFIX = "/api/sessions";
const LOCAL_RUNTIME_PREFIX = "/api/local-runtime/runtimes";
const AGENT_DASHBOARD_PREFIX = "/api/agent-dashboard";
const AGENT_DIAGNOSTIC_PREFIX = "/api/diagnostic/agents";
const WORKSPACE_DIAGNOSTIC_PREFIX = "/api/diagnostic/workspace";
const CREDENTIAL_ALIASES_PREFIX = "/api/credential-aliases";
const WORKER_BRIDGE_PREFIX = "/api/worker-bridge/sessions";
const MANAGER_RUNTIME_PREFIX = "/api/runtime";

export const StoredAgentRouteTemplates = {
  collection: STORED_AGENTS_PREFIX,
  item: `${STORED_AGENTS_PREFIX}/:agentId`,
  gatewayConfig: `${STORED_AGENTS_PREFIX}/:agentId/gateway-config`,
  runtimeProfile: `${STORED_AGENTS_PREFIX}/:agentId/runtime-profile`,
  credentials: `${STORED_AGENTS_PREFIX}/:id/credentials`,
  credentialReference: `${STORED_AGENTS_PREFIX}/:id/credential-reference`,
  ensureDefaultRouting: `${STORED_AGENTS_PREFIX}/:agentId/ensure-default-routing`,
  credentialLaunch: `${STORED_AGENTS_PREFIX}/:agentId/credentials/:credentialId/launch`,
  activate: `${STORED_AGENTS_PREFIX}/:agentId/activate`,
} as const;

export const AgentRouteTemplates = {
  runtimeProfile: `${AGENTS_PREFIX}/:agentId/runtime-profile`,
  assignLocalModel: `${AGENTS_PREFIX}/:agentId/assign-local-model`,
  schedulerConfig: `${AGENTS_PREFIX}/:agentId/scheduler-config`,
  policies: `${AGENTS_PREFIX}/:agentId/policies`,
  policy: `${AGENTS_PREFIX}/:agentId/policies/:policyId`,
  liveInput: `${AGENTS_PREFIX}/:agentId/input`,
  liveInterrupt: `${AGENTS_PREFIX}/:agentId/interrupt`,
  liveStream: `${AGENTS_PREFIX}/:agentId/stream`,
} as const;

export const AgentDashboardRouteTemplates = {
  item: `${AGENT_DASHBOARD_PREFIX}/:agentId`,
  latestRun: `${AGENT_DASHBOARD_PREFIX}/:agentId/latest-run`,
  runs: `${AGENT_DASHBOARD_PREFIX}/:agentId/runs`,
  tasks: `${AGENT_DASHBOARD_PREFIX}/:agentId/tasks`,
  toolEvents: `${AGENT_DASHBOARD_PREFIX}/:agentId/tool-events`,
  gatewayConfigState: `${AGENT_DASHBOARD_PREFIX}/:agentId/gateway-config-state`,
  events: `${AGENT_DASHBOARD_PREFIX}/:agentId/events`,
  version: `${AGENT_DASHBOARD_PREFIX}/:agentId/version`,
} as const;

export const DiagnosticRouteTemplates = {
  workspaceAgents: `${WORKSPACE_DIAGNOSTIC_PREFIX}/:workspaceId/agents`,
  agent: `${AGENT_DIAGNOSTIC_PREFIX}/:agentId`,
} as const;

export const CredentialAliasRouteTemplates = {
  collection: CREDENTIAL_ALIASES_PREFIX,
  item: `${CREDENTIAL_ALIASES_PREFIX}/:alias`,
} as const;

export const WorkerBridgeRouteTemplates = {
  collection: WORKER_BRIDGE_PREFIX,
  item: `${WORKER_BRIDGE_PREFIX}/:id`,
} as const;

export const ManagerRouteTemplates = {
  runtimeStatus: `${MANAGER_RUNTIME_PREFIX}/manager-status`,
} as const;

export const SessionRouteTemplates = {
  policies: `${SESSIONS_PREFIX}/:sessionThreadId/policies`,
  policy: `${SESSIONS_PREFIX}/:sessionThreadId/policies/:policyId`,
  policyState: `${SESSIONS_PREFIX}/:sessionThreadId/policy-state`,
} as const;

export const LocalRuntimeRouteTemplates = {
  collection: LOCAL_RUNTIME_PREFIX,
  item: `${LOCAL_RUNTIME_PREFIX}/:machineId`,
  probe: `${LOCAL_RUNTIME_PREFIX}/probe`,
  config: `${LOCAL_RUNTIME_PREFIX}/:machineId/config`,
  events: `${LOCAL_RUNTIME_PREFIX}/:machineId/events`,
  testDispatch: `${LOCAL_RUNTIME_PREFIX}/:machineId/test-dispatch`,
  rotateToken: `${LOCAL_RUNTIME_PREFIX}/:machineId/rotate-token`,
  runnerProbe: `${LOCAL_RUNTIME_PREFIX}/runners/:runnerId/probe`,
  assignRunner: `${LOCAL_RUNTIME_PREFIX}/runners/:runnerId/assign`,
  unassignRunner: `${LOCAL_RUNTIME_PREFIX}/runners/:runnerId/assign/:agentId`,
} as const;

export function storedAgentRoute(agentId: string) {
  return `${STORED_AGENTS_PREFIX}/${encodeURIComponent(agentId)}`;
}

export function storedAgentGatewayConfigRoute(agentId: string) {
  return `${storedAgentRoute(agentId)}/gateway-config`;
}

export function storedAgentRuntimeProfileRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${storedAgentRoute(agentId)}/runtime-profile`,
    workspaceId,
  );
}

export function storedAgentCredentialsRoute(agentId: string) {
  return `${storedAgentRoute(agentId)}/credentials`;
}

export function storedAgentCredentialReferenceRoute(agentId: string) {
  return `${storedAgentRoute(agentId)}/credential-reference`;
}

export function storedAgentEnsureDefaultRoutingRoute(agentId: string) {
  return `${storedAgentRoute(agentId)}/ensure-default-routing`;
}

export function storedAgentCredentialLaunchRoute(
  agentId: string,
  credentialId: string,
) {
  return `${storedAgentCredentialsRoute(agentId)}/${encodeURIComponent(credentialId)}/launch`;
}

export function storedAgentActivateRoute(agentId: string) {
  return `${storedAgentRoute(agentId)}/activate`;
}

export function agentRuntimeProfileRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/runtime-profile`,
    workspaceId,
  );
}

export function agentAssignLocalModelRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/assign-local-model`,
    workspaceId,
  );
}

export function agentSchedulerConfigRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/scheduler-config`,
    workspaceId,
  );
}

export function agentPoliciesRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/policies`,
    workspaceId,
  );
}

export function agentPolicyRoute(
  agentId: string,
  policyId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/policies/${encodeURIComponent(policyId)}`,
    workspaceId,
  );
}

export function sessionPoliciesRoute(
  sessionThreadId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${SESSIONS_PREFIX}/${encodeURIComponent(sessionThreadId)}/policies`,
    workspaceId,
  );
}

export function sessionPolicyRoute(
  sessionThreadId: string,
  policyId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${SESSIONS_PREFIX}/${encodeURIComponent(sessionThreadId)}/policies/${encodeURIComponent(policyId)}`,
    workspaceId,
  );
}

export function sessionPolicyStateRoute(
  sessionThreadId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${SESSIONS_PREFIX}/${encodeURIComponent(sessionThreadId)}/policy-state`,
    workspaceId,
  );
}

export function agentLiveInputRoute(agentId: string) {
  return `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/input`;
}

export function agentLiveInterruptRoute(agentId: string) {
  return `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/interrupt`;
}

export function agentLiveStreamRoute(
  agentId: string,
  options: { workspaceId?: string | null; sessionKey?: string | null } = {},
) {
  return appendQuery(`${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/stream`, {
    workspaceId: options.workspaceId,
    sessionKey: options.sessionKey,
  });
}

export function agentDashboardRoute(agentId: string) {
  return `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}`;
}

export function agentDashboardLatestRunRoute(agentId: string) {
  return `${agentDashboardRoute(agentId)}/latest-run`;
}

export function agentDashboardRunsRoute(agentId: string, page: number) {
  return appendQuery(`${agentDashboardRoute(agentId)}/runs`, { page });
}

export function agentDashboardTasksRoute(agentId: string) {
  return `${agentDashboardRoute(agentId)}/tasks`;
}

export function agentDashboardToolEventsRoute(agentId: string) {
  return `${agentDashboardRoute(agentId)}/tool-events`;
}

export function agentDashboardGatewayConfigStateRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${agentDashboardRoute(agentId)}/gateway-config-state`,
    workspaceId,
  );
}

export function agentDashboardEventsRoute(agentId: string) {
  return `${agentDashboardRoute(agentId)}/events`;
}

export function agentDashboardVersionRoute(
  agentId: string,
  workspaceId?: string | null,
) {
  return appendWorkspaceQuery(
    `${agentDashboardRoute(agentId)}/version`,
    workspaceId,
  );
}

export function workspaceAgentDiagnosticsRoute(workspaceId: string) {
  return `${WORKSPACE_DIAGNOSTIC_PREFIX}/${encodeURIComponent(workspaceId)}/agents`;
}

export function agentDiagnosticRoute(
  agentId: string,
  options: { workspaceId?: string | null; workItemId?: string | null } = {},
) {
  return appendQuery(
    `${AGENT_DIAGNOSTIC_PREFIX}/${encodeURIComponent(agentId)}`,
    {
      workspaceId: options.workspaceId,
      workItemId: options.workItemId,
    },
  );
}

export function credentialAliasesRoute() {
  return CREDENTIAL_ALIASES_PREFIX;
}

export function credentialAliasRoute(alias: string) {
  return `${CREDENTIAL_ALIASES_PREFIX}/${encodeURIComponent(alias)}`;
}

export function localRuntimeRoute(machineId: string) {
  return `${LOCAL_RUNTIME_PREFIX}/${encodeURIComponent(machineId)}`;
}

export function localRuntimesRoute() {
  return LOCAL_RUNTIME_PREFIX;
}

export function localRuntimeProbeRoute() {
  return `${LOCAL_RUNTIME_PREFIX}/probe`;
}

export function localRuntimeConfigRoute(machineId: string) {
  return `${localRuntimeRoute(machineId)}/config`;
}

export function localRuntimeEventsRoute(
  machineId: string,
  options: { limit?: number | null } = {},
) {
  return appendQuery(`${localRuntimeRoute(machineId)}/events`, {
    limit: options.limit,
  });
}

export function localRuntimeTestDispatchRoute(machineId: string) {
  return `${localRuntimeRoute(machineId)}/test-dispatch`;
}

export function localRuntimeRotateTokenRoute(machineId: string) {
  return `${localRuntimeRoute(machineId)}/rotate-token`;
}

export function localRuntimeRunnerProbeRoute(runnerId: string) {
  return `${LOCAL_RUNTIME_PREFIX}/runners/${encodeURIComponent(runnerId)}/probe`;
}

export function localRuntimeAssignRunnerRoute(runnerId: string) {
  return `${LOCAL_RUNTIME_PREFIX}/runners/${encodeURIComponent(runnerId)}/assign`;
}

export function localRuntimeUnassignRunnerRoute(
  runnerId: string,
  agentId: string,
) {
  return `${localRuntimeAssignRunnerRoute(runnerId)}/${encodeURIComponent(agentId)}`;
}

export function workerBridgeSessionsRoute() {
  return WORKER_BRIDGE_PREFIX;
}

export function workerBridgeSessionRoute(id: string) {
  return `${WORKER_BRIDGE_PREFIX}/${encodeURIComponent(id)}`;
}

export function managerRuntimeStatusRoute(workspaceId?: string | null) {
  return appendQuery(ManagerRouteTemplates.runtimeStatus, {
    workspace_id: workspaceId,
  });
}
