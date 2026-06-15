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
const LOCAL_RUNTIME_PREFIX = "/api/local-runtime/runtimes";

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
