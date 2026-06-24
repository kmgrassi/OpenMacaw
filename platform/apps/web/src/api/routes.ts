import {
  agentRuntimeProfileRoute,
  storedAgentActivateRoute,
  storedAgentCredentialLaunchRoute,
  storedAgentCredentialReferenceRoute,
  storedAgentCredentialsRoute,
  storedAgentEnsureDefaultRoutingRoute,
  storedAgentGatewayConfigRoute,
  storedAgentRoute,
  storedAgentRuntimeProfileRoute,
} from "../../../../contracts/routes";

/**
 * Broker API route helpers for the minimal frontend contract.
 *
 * Keep this module as the single source of truth for all backend HTTP routes.
 * The proxy exposes only:
 * - /health
 * - /api/agents*
 * - /ws
 */

const AGENTS_PREFIX = "/api/agents";
const SETUP_PREFIX = "/api/setup";
const AUTH_STATE_PATH = "/api/auth/state";
const DEFAULT_AGENTS_PREFIX = "/api/default-agents";
const MANAGER_AGENT_ACTIVATION_PATH = "/api/manager-agent/activation";
const AGENT_DASHBOARD_PREFIX = "/api/agent-dashboard";
const AGENT_DIAGNOSTIC_PREFIX = "/api/diagnostic/agents";
const WORKSPACE_DIAGNOSTIC_PREFIX = "/api/diagnostic/workspace";
const CREDENTIALS_PREFIX = "/api/credentials";
const CREDENTIAL_ALIASES_PREFIX = "/api/credential-aliases";
const WORKER_BRIDGE_PREFIX = "/api/worker-bridge/sessions";
const LOCAL_RUNTIME_PREFIX = "/api/local-runtime";
const WORK_ITEMS_PREFIX = "/api/work-items";
const PLANS_PREFIX = "/api/plans";
const SMOKE_PREFIX = "/api/smoke";
const WORKSPACES_PREFIX = "/api/workspaces";
const TOOLS_PREFIX = "/api/tools";

export const ROUTES = {
  /** List all agents / create a new agent */
  agents: AGENTS_PREFIX,
  authState: AUTH_STATE_PATH,
  defaultAgentAssignment: `${DEFAULT_AGENTS_PREFIX}/assignment`,
  defaultAgentCredentials: `${DEFAULT_AGENTS_PREFIX}/credentials`,
  managerAgentActivation: MANAGER_AGENT_ACTIVATION_PATH,
  setup: SETUP_PREFIX,
  setupAgentCredentials: `${SETUP_PREFIX}/agent-credentials`,
  setupByAgent: (agentId: string) =>
    `${SETUP_PREFIX}?agentId=${encodeURIComponent(agentId)}`,

  /** Single agent by ID (GET / PATCH / DELETE) */
  agent: (id: string) => `${AGENTS_PREFIX}/${encodeURIComponent(id)}`,
  agentRuntimeProfile: agentRuntimeProfileRoute,
  agentHealth: (id: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(id)}/health`,
  agentDashboardVersion: (agentId: string, workspaceId?: string | null) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    const query = params.toString();
    return `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/version${query ? `?${query}` : ""}`;
  },
  agentDiagnostic: (agentId: string, workspaceId?: string | null) => {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    const query = params.toString();
    return `${AGENT_DIAGNOSTIC_PREFIX}/${encodeURIComponent(agentId)}${query ? `?${query}` : ""}`;
  },
  workspaceAgentDiagnostics: (workspaceId: string) =>
    `${WORKSPACE_DIAGNOSTIC_PREFIX}/${encodeURIComponent(workspaceId)}/agents`,

  /** Start or reuse the orchestrator runtime for an agent */
  agentStart: (id: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(id)}/start`,

  /** Supabase-backed agent dashboard data via the local API */
  agentDashboardLatestRun: (agentId: string) =>
    `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/latest-run`,
  agentDashboardRuns: (agentId: string, page: number) =>
    `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/runs?page=${encodeURIComponent(page)}`,
  agentDashboardTasks: (agentId: string) =>
    `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/tasks`,
  agentDashboardGatewayConfigState: (
    agentId: string,
    workspaceId?: string | null,
  ) => {
    const path = `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/gateway-config-state`;
    return workspaceId
      ? `${path}?workspaceId=${encodeURIComponent(workspaceId)}`
      : path;
  },

  /** Messages for an agent (fallback/chat history endpoint) */
  agentMessages: (agentId: string, before?: string | null) => {
    const path = `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/messages`;
    return before ? `${path}?before=${encodeURIComponent(before)}` : path;
  },

  /** Tool definitions and agent assignment */
  tools: TOOLS_PREFIX,
  tool: (toolId: string) => `${TOOLS_PREFIX}/${encodeURIComponent(toolId)}`,
  agentTools: (agentId: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/tools`,
  agentTool: (agentId: string, toolId: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`,
  agentToolsOrder: (agentId: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/tools/order`,

  /** Supabase-backed stored agent metadata via the local API */
  storedAgents: "/api/stored-agents",
  storedAgent: storedAgentRoute,
  storedAgentGatewayConfig: storedAgentGatewayConfigRoute,
  storedAgentRuntimeProfile: storedAgentRuntimeProfileRoute,
  storedAgentCredentials: storedAgentCredentialsRoute,
  storedAgentActivate: storedAgentActivateRoute,
  storedAgentCredentialLaunch: storedAgentCredentialLaunchRoute,
  storedAgentCredentialReference: storedAgentCredentialReferenceRoute,
  storedAgentEnsureDefaultRouting: storedAgentEnsureDefaultRoutingRoute,
  credentials: CREDENTIALS_PREFIX,
  credentialAliases: CREDENTIAL_ALIASES_PREFIX,
  credentialAlias: (alias: string) =>
    `${CREDENTIAL_ALIASES_PREFIX}/${encodeURIComponent(alias)}`,
  openaiCodexOAuthStart: "/api/credentials/openai-codex/oauth/start",
  openaiCodexOAuthPoll: "/api/credentials/openai-codex/oauth/poll",
  openaiCodexOAuthImport: "/api/credentials/openai-codex/oauth/import",

  githubAppInstallations: "/api/resource-credentials/github-app-installations",
  githubAppInstallationPulls: (credentialId: string) =>
    `/api/resource-credentials/github-app-installations/${encodeURIComponent(credentialId)}/pulls`,

  /** Manual work-item ingest into canonical task/work_items */
  workItems: WORK_ITEMS_PREFIX,
  workspaceWorkItems: (workspaceId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/work-items`,
  workspaceWorkItem: (workspaceId: string, workItemId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}`,
  workItemSnooze: (workspaceId: string, workItemId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/snooze`,
  workItemWake: (workspaceId: string, workItemId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(workItemId)}/wake`,
  workItemCutovers: (workItemId: string) =>
    `${WORK_ITEMS_PREFIX}/${encodeURIComponent(workItemId)}/cutovers`,
  workspaceRecentCutovers: (
    workspaceId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/cutovers/recent${query ? `?${query}` : ""}`;
  },
  workspaceScheduledTasks: (workspaceId: string, agentId?: string | null) => {
    const path = `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/scheduled-tasks`;
    return agentId ? `${path}?agentId=${encodeURIComponent(agentId)}` : path;
  },
  workspaceMemoryItems: (
    workspaceId: string,
    filters: {
      agentId?: string | null;
      scope?: string;
      importanceMin?: number;
      sourceRunId?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.agentId !== undefined)
      params.set("agentId", filters.agentId ?? "");
    if (filters.scope) params.set("scope", filters.scope);
    if (filters.importanceMin !== undefined)
      params.set("importanceMin", String(filters.importanceMin));
    if (filters.sourceRunId) params.set("sourceRunId", filters.sourceRunId);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    const query = params.toString();
    return `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/memory-items${query ? `?${query}` : ""}`;
  },
  workspaceSkills: (
    workspaceId: string,
    filters: {
      agentId?: string;
      status?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.agentId) params.set("agentId", filters.agentId);
    if (filters.status) params.set("status", filters.status);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    const query = params.toString();
    return `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/skills${query ? `?${query}` : ""}`;
  },
  workspaceSkill: (workspaceId: string, skillId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}`,
  scheduledTaskCancel: (
    workspaceId: string,
    scheduledTaskId: string,
    agentId?: string | null,
  ) => {
    const path = `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/cancel`;
    return agentId ? `${path}?agentId=${encodeURIComponent(agentId)}` : path;
  },
  scheduledTaskRunNow: (
    workspaceId: string,
    scheduledTaskId: string,
    agentId?: string | null,
  ) => {
    const path = `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/run-now`;
    return agentId ? `${path}?agentId=${encodeURIComponent(agentId)}` : path;
  },
  workspaceLearningMemoryStatus: (workspaceId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/learning/memory-status`,
  workspaceLearningProviderWarningEvents: (workspaceId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/learning/provider-warning-events`,

  /** Structured plan creation */
  plans: PLANS_PREFIX,
  workspacePlans: (workspaceId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/plans`,
  workspacePlan: (workspaceId: string, planId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}`,
  planDraftFromPrompt: `${PLANS_PREFIX}/draft-from-prompt`,
  planReviews: (workspaceId: string) =>
    `${WORKSPACES_PREFIX}/${encodeURIComponent(workspaceId)}/plan-reviews`,

  /** Agent dashboard reads */
  agentDashboard: (agentId: string) =>
    `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}`,
  agentDashboardEvents: (agentId: string) =>
    `${AGENT_DASHBOARD_PREFIX}/${encodeURIComponent(agentId)}/events`,

  /** Local runtime model management */
  localRuntimeModels: `${LOCAL_RUNTIME_PREFIX}/models`,
  localRuntimeModel: (id: string) =>
    `${LOCAL_RUNTIME_PREFIX}/models/${encodeURIComponent(id)}`,
  localRuntimeModelAssign: (id: string) =>
    `${LOCAL_RUNTIME_PREFIX}/models/${encodeURIComponent(id)}/assign`,
  localRuntimeModelUnassign: (id: string, agentId: string) =>
    `${LOCAL_RUNTIME_PREFIX}/models/${encodeURIComponent(id)}/assign/${encodeURIComponent(agentId)}`,

  /** Deterministic smoke fixtures */
  claudeCodeSmoke: `${SMOKE_PREFIX}/claude-code-dispatch`,
  modelAgnosticSmoke: `${SMOKE_PREFIX}/model-agnostic-handoff`,
  localModelCodingSmoke: `${SMOKE_PREFIX}/local-model-coding-runner`,
  containerArtifactHandoffSmoke: `${SMOKE_PREFIX}/container-execution-e1-handoff`,

  /** Scheduled agent config and live manager status */
  managerAgentConfig: (agentId: string, workspaceId: string) =>
    `${AGENTS_PREFIX}/${encodeURIComponent(agentId)}/scheduler-config?workspaceId=${encodeURIComponent(workspaceId)}`,
  managerAgentStatus: (workspaceId: string) =>
    `/api/runtime/manager-status?workspace_id=${encodeURIComponent(workspaceId)}`,

  /** Worker bridge session lifecycle */
  workerBridgeSessions: WORKER_BRIDGE_PREFIX,
  workerBridgeSession: (id: string) =>
    `${WORKER_BRIDGE_PREFIX}/${encodeURIComponent(id)}`,
} as const;
