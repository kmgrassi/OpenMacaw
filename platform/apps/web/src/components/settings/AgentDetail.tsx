import { useCallback, useState } from "react";
import {
  useDeleteAgentMutation,
  useUpdateAgentMutation,
  type Agent,
} from "../../hooks/useAgents";
import { invalidateAgentData } from "../../api/query-client";
import { useLocalRuntimesQuery } from "../../hooks/useServerStateQueries";
import { useAuthStore } from "../../stores/auth";
import type {
  AgentType,
  PlanningDestination,
} from "../../../../../contracts/agents";
import { ToolDefinitionsPanel } from "../agent-settings/ToolDefinitionsPanel";
import { Alert } from "../ui/Alert";
import { LocalRuntimeStatusChip } from "../local-runtime/LocalRuntimeStatusChip";
import { AgentCredentialsPanel } from "./AgentDetail/AgentCredentialsPanel";
import { AgentDangerZone } from "./AgentDetail/AgentDangerZone";
import { AgentDetailHeader } from "./AgentDetail/AgentDetailHeader";
import { AgentIdentityEditor } from "./AgentDetail/AgentIdentityEditor";
import { AgentRuntimeEditor } from "./AgentDetail/AgentRuntimeEditor";
import { AgentWorkspacePathPanel } from "./AgentDetail/AgentWorkspacePathPanel";
import { AGENT_DETAIL_TABS } from "./AgentDetail/constants";
import { useAgentRuntimeProfile } from "./AgentDetail/useAgentRuntimeProfile";

export function AgentDetail({ agent }: { agent: Agent }) {
  const updateAgent = useUpdateAgentMutation();
  const deleteAgent = useDeleteAgentMutation();
  const { workspaceId } = useAuthStore();
  const toolWorkspaceId = agent.workspaceId ?? workspaceId;
  const { data: localRuntimes } = useLocalRuntimesQuery(toolWorkspaceId);
  const [name, setName] = useState(agent.name);
  const [agentType, setAgentType] = useState<AgentType>(agent.agentType);
  const [model, setModel] = useState(agent.model ?? "");
  const [context, setContext] = useState(agent.context ?? "");
  const [planningDestination, setPlanningDestination] =
    useState<PlanningDestination>(agent.planningDestination ?? "database");
  const [customBackendType, setCustomBackendType] = useState(
    agent.customTarget?.backendType ?? "openclaw_ws",
  );
  const [customBaseUrl, setCustomBaseUrl] = useState(
    agent.customTarget?.baseUrl ?? "ws://127.0.0.1:7788",
  );
  const [customAgentId, setCustomAgentId] = useState(
    agent.customTarget?.agentId ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"general" | "tools">("general");
  const [credentialRefreshKey, setCredentialRefreshKey] = useState(0);

  const handleError = useCallback((message: string) => {
    setError(message);
  }, []);
  const clearError = useCallback(() => {
    setError(null);
  }, []);
  const reloadAgents = useCallback(
    async () =>
      invalidateAgentData({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? workspaceId,
      }),
    [agent.id, agent.workspaceId, workspaceId],
  );

  const {
    runtimeProfile,
    runtimeProvider,
    setRuntimeProvider,
    runtimeModel,
    setRuntimeModel,
    runtimeFallbacks,
    setRuntimeFallbacks,
    runtimeModelTierFloor,
    setRuntimeModelTierFloor,
    runtimeProfileLoading,
    runtimeProfileSaving,
    runtimeProfileDirty,
    runtimeProviderIsLocal,
    runtimeCredentialMissing,
    loadRuntimeProfile,
    saveRuntimeProfile,
  } = useAgentRuntimeProfile({
    agent,
    workspaceId,
    onError: handleError,
    onClearError: clearError,
    onSaved: reloadAgents,
  });

  const dirty =
    name.trim() !== agent.name ||
    agentType !== agent.agentType ||
    model.trim() !== (agent.model ?? "") ||
    context.trim() !== (agent.context ?? "") ||
    (agentType === "planning" &&
      planningDestination !== (agent.planningDestination ?? "database")) ||
    (agentType === "custom" &&
      (customBackendType.trim() !==
        (agent.customTarget?.backendType ?? "openclaw_ws") ||
        customBaseUrl.trim() !==
          (agent.customTarget?.baseUrl ?? "ws://127.0.0.1:7788") ||
        customAgentId.trim() !== (agent.customTarget?.agentId ?? "")));

  const handleSave = async () => {
    if (!dirty) return;
    if (
      agentType === "custom" &&
      (!customBackendType.trim() ||
        !customBaseUrl.trim() ||
        !customAgentId.trim())
    ) {
      setError(
        "Custom agents require a backend type, base URL, and target agent ID.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateAgent.mutateAsync({
        agentId: agent.id,
        patch: {
          name: name.trim(),
          type: agentType,
          model: model.trim() || null,
          context: context.trim() || null,
          planningDestination,
          customTarget:
            agentType === "custom"
              ? {
                  backendType: customBackendType.trim(),
                  baseUrl: customBaseUrl.trim(),
                  agentId: customAgentId.trim(),
                }
              : undefined,
        },
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await deleteAgent.mutateAsync(agent.id);
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  };

  const handleCredentialSaved = async () => {
    await loadRuntimeProfile();
    setCredentialRefreshKey((key) => key + 1);
  };

  return (
    <div className="space-y-6">
      <AgentDetailHeader agent={agent} />

      <LocalRuntimeStatusChip
        agentId={agent.id}
        runtimes={localRuntimes?.runtimes ?? []}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex gap-2 border-b border-border">
        {AGENT_DETAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "border-blue-500 text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "tools" ? (
        <ToolDefinitionsPanel
          agentId={agent.id}
          workspaceId={toolWorkspaceId}
        />
      ) : (
        <>
          <AgentIdentityEditor
            agent={agent}
            name={name}
            setName={setName}
            agentType={agentType}
            setAgentType={setAgentType}
            model={model}
            setModel={setModel}
            context={context}
            setContext={setContext}
            planningDestination={planningDestination}
            setPlanningDestination={setPlanningDestination}
            customBackendType={customBackendType}
            setCustomBackendType={setCustomBackendType}
            customBaseUrl={customBaseUrl}
            setCustomBaseUrl={setCustomBaseUrl}
            customAgentId={customAgentId}
            setCustomAgentId={setCustomAgentId}
            dirty={dirty}
            saving={saving}
            onSave={handleSave}
          />

          <AgentRuntimeEditor
            agent={agent}
            runtimeProfile={runtimeProfile}
            runtimeProvider={runtimeProvider}
            setRuntimeProvider={setRuntimeProvider}
            runtimeModel={runtimeModel}
            setRuntimeModel={setRuntimeModel}
            runtimeFallbacks={runtimeFallbacks}
            setRuntimeFallbacks={setRuntimeFallbacks}
            runtimeModelTierFloor={runtimeModelTierFloor}
            setRuntimeModelTierFloor={setRuntimeModelTierFloor}
            runtimeProfileLoading={runtimeProfileLoading}
            runtimeProfileSaving={runtimeProfileSaving}
            runtimeProfileDirty={runtimeProfileDirty}
            runtimeProviderIsLocal={runtimeProviderIsLocal}
            runtimeCredentialMissing={runtimeCredentialMissing}
            onRuntimeProfileSaveInput={saveRuntimeProfile}
            onAgentReload={reloadAgents}
            onError={handleError}
            onClearError={clearError}
          />

          <AgentWorkspacePathPanel
            agentId={agent.id}
            visible={runtimeProfile?.runnerKind === "local_model_coding"}
          />

          <AgentCredentialsPanel
            agent={agent}
            workspaceId={workspaceId}
            runtimeProvider={runtimeProvider}
            runtimeModel={runtimeModel}
            runtimeProfileRunnerKind={runtimeProfile?.runnerKind}
            refreshKey={credentialRefreshKey}
            onSaved={handleCredentialSaved}
          />

          <AgentDangerZone deleting={deleting} onDelete={handleDelete} />
        </>
      )}
    </div>
  );
}
