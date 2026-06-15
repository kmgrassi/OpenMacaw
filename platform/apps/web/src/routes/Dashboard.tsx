import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { makeSessionKey, type RuntimeScope } from "../api/ws-types";
import type { AuthStateAgent } from "../api/ws-types";
import { invalidateAgentRuntimeQueries } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";
import { fetchRuntimeAgents } from "../api/runtime-agents";
import { stopWorkerBridgeSession } from "../api/worker-bridge";
import { invalidateAgentData } from "../api/query-client";
import { AppShell } from "../components/AppShell";
import { AgentDashboardPanel } from "../components/AgentDashboardPanel";
import { GatewayDebugPanel } from "../components/GatewayDebugPanel";
import { ConfigurationStatusCard } from "../components/dashboard/ConfigurationStatusCard";
import { DashboardHeader } from "../components/dashboard/DashboardHeader";
import { EngineInstanceCard } from "../components/dashboard/EngineInstanceCard";
import { RuntimeChatPanel } from "../components/dashboard/RuntimeChatPanel";
import { RuntimeDebugCard } from "../components/dashboard/RuntimeDebugCard";
import { OnboardingNudgeBanner } from "../components/dashboard/OnboardingNudgeBanner";
import { WorkspaceAgentDiagnosticsPanel } from "../components/dashboard/WorkspaceAgentHealthWidget";
import type { DashboardSetup } from "../components/dashboard/dashboardTypes";
import { Alert } from "../components/ui/Alert";
import {
  useAgentHealthQuery,
  useSetupByAgentQuery,
} from "../hooks/useSetupQueries";
import { useAuthStore } from "../stores/auth";
import {
  deriveProviderFromModel,
  extractPrimaryModel,
} from "../../../../contracts/agent-helpers";
import { useUiStore } from "../stores/ui";
import { GatewayProvider } from "../context/GatewayContext";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type CodeAccess = {
  type: "repository" | "workspace";
  label: string;
  value: string;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function repositoryLabel(repository: string): string {
  const normalized = repository
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || repository;
}

function workspaceLabel(workspace: string): string {
  const parts = workspace.split("/").filter(Boolean);
  return parts.at(-1) || workspace;
}

function codeAccessFromSetup(setup: DashboardSetup | null): CodeAccess | null {
  if (!setup) return null;

  const config = asRecord(setup.gatewayConfig?.configJson);
  const workflowTemplate = asRecord(config?.workflow_template);
  const tracker = asRecord(config?.tracker);
  const toolPolicy = asRecord(setup.agent.toolPolicy);
  const executionTarget = asRecord(toolPolicy?.executionTarget);

  const repository =
    stringValue(workflowTemplate?.repository_url) ??
    stringValue(tracker?.repository_url) ??
    stringValue(tracker?.tracker_repository_url);

  if (repository) {
    return {
      type: "repository",
      label: repositoryLabel(repository),
      value: repository,
    };
  }

  const workspace =
    stringValue(executionTarget?.workspaceRoot) ??
    stringValue(executionTarget?.workspaceRootRef) ??
    setup.agent.workspaceId;

  return {
    type: "workspace",
    label: workspaceLabel(workspace),
    value: workspace,
  };
}

export function Dashboard() {
  const { agentId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { defaultAgentOnboarding, resolvedAgentId, setResolvedContext } =
    useAuthStore();
  const debugMode = useUiStore((state) => state.debugMode);
  const focusMode = useUiStore((state) => state.focusMode);
  const toggleDebugMode = useUiStore((state) => state.toggleDebugMode);
  const toggleFocusMode = useUiStore((state) => state.toggleFocusMode);
  const setupQuery = useSetupByAgentQuery(agentId);
  const agentHealthQuery = useAgentHealthQuery(agentId);
  const runtimeAgentsQuery = useQuery({
    queryKey: queryKeys.runtimeAgents.list(),
    queryFn: fetchRuntimeAgents,
    enabled: Boolean(agentId) && debugMode,
    staleTime: 2_000,
  });
  const setup = setupQuery.data ?? null;
  const agentHealth = agentHealthQuery.data ?? null;
  const runtimeAgents = debugMode ? (runtimeAgentsQuery.data ?? null) : null;
  const loading = setupQuery.isLoading;
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [refreshingEngine, setRefreshingEngine] = useState(false);
  const codeAccess = useMemo(() => codeAccessFromSetup(setup), [setup]);

  useEffect(() => {
    if (setupQuery.error) {
      setError((setupQuery.error as Error).message);
    }
  }, [setupQuery.error]);

  useEffect(() => {
    if (setup?.requirements.configured) {
      setResolvedContext({
        agentId: setup.agent.id,
        workspaceId: setup.agent.workspaceId,
      });
    }
  }, [setup, setResolvedContext]);

  const scope = useMemo<RuntimeScope | null>(() => {
    if (
      !setup?.requirements.configured ||
      !setup.agent.id ||
      !setup.agent.workspaceId
    )
      return null;
    return {
      agentId: setup.agent.id,
      workspaceId: setup.agent.workspaceId,
      sessionKey: makeSessionKey(setup.agent.id),
    };
  }, [setup]);
  const target = useMemo<AuthStateAgent | null>(() => {
    if (!setup?.requirements.configured || !setup.agent.id) return null;
    const model = extractPrimaryModel(setup.agent.modelSettings);
    return {
      id: setup.agent.id,
      name: setup.agent.name?.trim() || setup.agent.id,
      model,
      provider: deriveProviderFromModel(model),
      hasCredentials: true,
      isResolved: true,
    };
  }, [setup]);

  const handleStop = useCallback(async () => {
    const instanceId = setup?.engine?.instanceId;
    if (!instanceId) return;
    setStopping(true);
    setError(null);
    try {
      await stopWorkerBridgeSession(instanceId);
      await Promise.all([
        invalidateAgentData({
          agentId,
          workspaceId: setup.agent.workspaceId,
        }),
        invalidateAgentRuntimeQueries(
          queryClient,
          agentId,
          setup.agent.workspaceId,
        ),
      ]);
    } catch (stopError) {
      setError((stopError as Error).message);
    } finally {
      setStopping(false);
    }
  }, [agentId, queryClient, setup]);

  const handleRefreshEngine = useCallback(async () => {
    setRefreshingEngine(true);
    setError(null);
    try {
      await Promise.all([
        invalidateAgentData({
          agentId,
          workspaceId: setup?.agent.workspaceId,
        }),
        invalidateAgentRuntimeQueries(
          queryClient,
          agentId,
          setup?.agent.workspaceId,
        ),
      ]);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    } finally {
      setRefreshingEngine(false);
    }
  }, [agentId, queryClient, setup?.agent.workspaceId]);

  const handleConfigured = useCallback(
    (configured: DashboardSetup) => {
      queryClient.setQueryData(
        queryKeys.setup.byAgent(configured.agent.id),
        configured,
      );
      setResolvedContext({
        agentId: configured.agent.id,
        workspaceId: configured.agent.workspaceId,
      });
      void Promise.all([
        invalidateAgentData({
          agentId: configured.agent.id,
          workspaceId: configured.agent.workspaceId,
        }),
        invalidateAgentRuntimeQueries(
          queryClient,
          configured.agent.id,
          configured.agent.workspaceId,
        ),
      ]);
    },
    [queryClient, setResolvedContext],
  );

  const handleViewEngineDetails = useCallback(() => {
    if (!debugMode) {
      toggleDebugMode();
    }
  }, [debugMode, toggleDebugMode]);

  const handleNoopToggleDetails = useCallback(() => undefined, []);

  // Don't redirect away from unconfigured agents — let the user stay
  // and see the configuration state so they can fix it.

  const detailsContent = useMemo(
    () => (
      <div className="space-y-3">
        {debugMode && scope && <GatewayDebugPanel />}
        <WorkspaceAgentDiagnosticsPanel
          workspaceId={setup?.agent.workspaceId}
        />
        <EngineInstanceCard
          setup={setup}
          health={agentHealth}
          detailsOpen
          detailsEnabled={false}
          stopping={stopping}
          refreshing={refreshingEngine}
          onToggleDetails={handleNoopToggleDetails}
          onStop={() => void handleStop()}
          onRefresh={() => void handleRefreshEngine()}
          onViewDetails={handleViewEngineDetails}
        />
        {debugMode && setup?.agent.workspaceId && (
          <AgentDashboardPanel
            agentId={agentId}
            workspaceId={setup.agent.workspaceId}
          />
        )}
        {debugMode && (
          <RuntimeDebugCard
            loading={
              runtimeAgentsQuery.isLoading || runtimeAgentsQuery.isFetching
            }
            runtimeAgents={runtimeAgents}
          />
        )}
      </div>
    ),
    [
      agentHealth,
      agentId,
      debugMode,
      handleNoopToggleDetails,
      handleRefreshEngine,
      handleStop,
      handleViewEngineDetails,
      runtimeAgents,
      runtimeAgentsQuery.isFetching,
      runtimeAgentsQuery.isLoading,
      scope,
      setup,
      stopping,
      refreshingEngine,
    ],
  );

  const dashboardContent = (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <DashboardHeader
        agentName={setup?.agent.name}
        codeAccess={codeAccess}
        debugMode={debugMode}
        focusMode={focusMode}
        detailsContent={detailsContent}
        onToggleDebugMode={toggleDebugMode}
        onToggleFocusMode={toggleFocusMode}
        onEditSetup={() => navigate(`/settings/agents/${agentId}`)}
      />

      <OnboardingNudgeBanner onboarding={defaultAgentOnboarding} />

      {error && <Alert tone="error">{error}</Alert>}

      <div className="min-h-0 flex-1">
        {setup && !setup.requirements.configured ? (
          <ConfigurationStatusCard
            setup={setup}
            onConfigured={handleConfigured}
          />
        ) : (
          <RuntimeChatPanel
            scope={scope}
            target={target}
            loading={loading}
            gatewayProvided
          />
        )}
      </div>
    </div>
  );

  if (!agentId && resolvedAgentId) {
    return <Navigate to={`/dashboard/${resolvedAgentId}`} replace />;
  }

  if (!agentId) {
    return <Navigate to="/settings/agents" replace />;
  }

  return (
    <AppShell focusMode={focusMode}>
      {scope ? (
        <GatewayProvider scopeOverride={scope} targetOverride={target}>
          {dashboardContent}
        </GatewayProvider>
      ) : (
        dashboardContent
      )}
    </AppShell>
  );
}
