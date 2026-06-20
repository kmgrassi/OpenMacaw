export type QueryKeyFactory = readonly unknown[];

export const queryKeys = {
  auth: {
    all: ["auth"] as const,
    state: () => [...queryKeys.auth.all, "state"] as const,
  },
  agents: {
    all: ["agents"] as const,
    lists: () => [...queryKeys.agents.all, "list"] as const,
    list: (workspaceId?: string | null) =>
      [
        ...queryKeys.agents.lists(),
        { workspaceId: workspaceId ?? "all" },
      ] as const,
    details: () => [...queryKeys.agents.all, "detail"] as const,
    detail: (agentId: string) =>
      [...queryKeys.agents.details(), { agentId }] as const,
    runtimeProfiles: () => [...queryKeys.agents.all, "runtimeProfile"] as const,
    runtimeProfile: (agentId: string, workspaceId: string) =>
      [
        ...queryKeys.agents.runtimeProfiles(),
        { agentId, workspaceId },
      ] as const,
  },
  setup: {
    all: ["setup"] as const,
    byAgents: () => [...queryKeys.setup.all, "byAgent"] as const,
    byAgent: (agentId: string) =>
      [...queryKeys.setup.byAgents(), { agentId }] as const,
  },
  agentHealth: {
    all: ["agentHealth"] as const,
    details: () => [...queryKeys.agentHealth.all, "detail"] as const,
    detail: (agentId: string) =>
      [...queryKeys.agentHealth.details(), { agentId }] as const,
  },
  agentDiagnostics: {
    all: ["agentDiagnostics"] as const,
    details: () => [...queryKeys.agentDiagnostics.all, "detail"] as const,
    detail: (agentId: string, workspaceId?: string | null) =>
      [
        ...queryKeys.agentDiagnostics.details(),
        { agentId, workspaceId: workspaceId ?? null },
      ] as const,
  },
  workspaceAgentDiagnostics: {
    all: ["workspaceAgentDiagnostics"] as const,
    details: () =>
      [...queryKeys.workspaceAgentDiagnostics.all, "detail"] as const,
    detail: (workspaceId: string) =>
      [
        ...queryKeys.workspaceAgentDiagnostics.details(),
        { workspaceId },
      ] as const,
  },
  runtimeAgents: {
    all: ["runtimeAgents"] as const,
    list: () => [...queryKeys.runtimeAgents.all, "list"] as const,
  },
  agentDashboard: {
    all: ["agentDashboard"] as const,
    latestRuns: () => [...queryKeys.agentDashboard.all, "latestRun"] as const,
    latestRun: (agentId: string) =>
      [...queryKeys.agentDashboard.latestRuns(), { agentId }] as const,
    runHistories: () =>
      [...queryKeys.agentDashboard.all, "runHistory"] as const,
    runHistory: (agentId: string, page: number) =>
      [...queryKeys.agentDashboard.runHistories(), { agentId, page }] as const,
    tasksLists: () => [...queryKeys.agentDashboard.all, "tasks"] as const,
    tasks: (agentId: string, runIds: readonly string[]) =>
      [
        ...queryKeys.agentDashboard.tasksLists(),
        { agentId, runIds: [...runIds].sort() },
      ] as const,
    configStates: () =>
      [...queryKeys.agentDashboard.all, "configState"] as const,
    configState: (agentId: string, workspaceId?: string | null) =>
      [
        ...queryKeys.agentDashboard.configStates(),
        { agentId, workspaceId: workspaceId ?? null },
      ] as const,
    versions: () => [...queryKeys.agentDashboard.all, "version"] as const,
    version: (agentId: string, workspaceId?: string | null) =>
      [
        ...queryKeys.agentDashboard.versions(),
        { agentId, workspaceId: workspaceId ?? null },
      ] as const,
  },
  messages: {
    all: ["messages"] as const,
    histories: () => [...queryKeys.messages.all, "history"] as const,
    history: (agentId: string, sessionKey: string) =>
      [...queryKeys.messages.histories(), { agentId, sessionKey }] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    orchestratorLists: () =>
      [...queryKeys.sessions.all, "orchestrator"] as const,
    orchestrator: (scopeKey: string) =>
      [...queryKeys.sessions.orchestratorLists(), { scopeKey }] as const,
    worker: () => [...queryKeys.sessions.all, "worker"] as const,
  },
  tools: {
    all: ["tools"] as const,
    agentLists: () => [...queryKeys.tools.all, "agent"] as const,
    agent: (agentId: string, workspaceId: string) =>
      [...queryKeys.tools.agentLists(), { agentId, workspaceId }] as const,
    catalogs: () => [...queryKeys.tools.all, "catalog"] as const,
    catalog: (workspaceId: string) =>
      [...queryKeys.tools.catalogs(), { workspaceId }] as const,
  },
  localRuntimes: {
    all: ["localRuntimes"] as const,
    lists: () => [...queryKeys.localRuntimes.all, "list"] as const,
    list: (workspaceId: string) =>
      [...queryKeys.localRuntimes.lists(), { workspaceId }] as const,
  },
  plans: {
    all: ["plans"] as const,
    lists: () => [...queryKeys.plans.all, "list"] as const,
    list: (workspaceId: string) =>
      [...queryKeys.plans.lists(), { workspaceId }] as const,
  },
  workItems: {
    all: ["workItems"] as const,
    lists: () => [...queryKeys.workItems.all, "list"] as const,
    list: (workspaceId: string) =>
      [...queryKeys.workItems.lists(), { workspaceId }] as const,
    cutovers: () => [...queryKeys.workItems.all, "cutovers"] as const,
    cutover: (workItemId: string) =>
      [...queryKeys.workItems.cutovers(), { workItemId }] as const,
    recentCutovers: (workspaceId: string, limit: number) =>
      [
        ...queryKeys.workItems.cutovers(),
        "recent",
        { workspaceId, limit },
      ] as const,
  },
  manager: {
    all: ["manager"] as const,
    statuses: () => [...queryKeys.manager.all, "status"] as const,
    status: (workspaceId: string) =>
      [...queryKeys.manager.statuses(), { workspaceId }] as const,
    configs: () => [...queryKeys.manager.all, "config"] as const,
    config: (workspaceId: string, agentId: string) =>
      [...queryKeys.manager.configs(), { workspaceId, agentId }] as const,
  },
  scheduledTasks: {
    all: ["scheduledTasks"] as const,
    lists: () => [...queryKeys.scheduledTasks.all, "list"] as const,
    list: (workspaceId: string, agentId: string) =>
      [...queryKeys.scheduledTasks.lists(), { workspaceId, agentId }] as const,
  },
  memoryItems: {
    all: ["memoryItems"] as const,
    lists: () => [...queryKeys.memoryItems.all, "list"] as const,
    list: (
      workspaceId: string,
      filters: {
        agentId?: string | null;
        scope?: string;
        importanceMin?: number;
        sourceRunId?: string;
        limit?: number;
      },
    ) =>
      [
        ...queryKeys.memoryItems.lists(),
        {
          workspaceId,
          agentId:
            filters.agentId === undefined
              ? "all"
              : (filters.agentId ?? "workspace"),
          scope: filters.scope ?? "all",
          importanceMin: filters.importanceMin ?? 1,
          sourceRunId: filters.sourceRunId ?? "",
          limit: filters.limit ?? 100,
        },
      ] as const,
  },
  skills: {
    all: ["skills"] as const,
    lists: () => [...queryKeys.skills.all, "list"] as const,
    list: (
      workspaceId: string,
      filters: {
        agentId?: string;
        status?: string;
        limit?: number;
      },
    ) =>
      [
        ...queryKeys.skills.lists(),
        {
          workspaceId,
          agentId: filters.agentId ?? "all",
          status: filters.status ?? "all",
          limit: filters.limit ?? 100,
        },
      ] as const,
  },
  learningMemory: {
    all: ["learningMemory"] as const,
    statuses: () => [...queryKeys.learningMemory.all, "status"] as const,
    status: (workspaceId: string) =>
      [...queryKeys.learningMemory.statuses(), { workspaceId }] as const,
  },
  credentials: {
    all: ["credentials"] as const,
    workspaceLists: () => [...queryKeys.credentials.all, "workspace"] as const,
    workspace: (workspaceId: string) =>
      [...queryKeys.credentials.workspaceLists(), { workspaceId }] as const,
    resolvedLists: () => [...queryKeys.credentials.all, "resolved"] as const,
    resolved: (scope: string, refreshToken = 0) =>
      [
        ...queryKeys.credentials.resolvedLists(),
        { scope, refreshToken },
      ] as const,
  },
  models: {
    all: ["models"] as const,
    catalogs: () => [...queryKeys.models.all, "catalog"] as const,
    catalog: (
      workspaceId: string,
      options: {
        agentId?: string | null;
        refresh?: boolean;
        refreshToken?: number;
      } = {},
    ) =>
      [
        ...queryKeys.models.catalogs(),
        {
          workspaceId,
          agentId: options.agentId ?? "all",
          refresh: Boolean(options.refresh),
          refreshToken: options.refreshToken ?? 0,
        },
      ] as const,
    providers: (
      workspaceId: string,
      options: { refresh?: boolean; refreshToken?: number } = {},
    ) =>
      [
        ...queryKeys.models.all,
        "providers",
        {
          workspaceId,
          refresh: Boolean(options.refresh),
          refreshToken: options.refreshToken ?? 0,
        },
      ] as const,
  },
  workspaceSettings: {
    all: ["workspaceSettings"] as const,
    details: () => [...queryKeys.workspaceSettings.all, "detail"] as const,
    detail: (workspaceId: string) =>
      [...queryKeys.workspaceSettings.details(), { workspaceId }] as const,
  },
} as const;
