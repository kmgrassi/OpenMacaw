import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LocalModelProbeResponse } from "../../../api/local-runtime";
import { prepareRuntime } from "../../../api/broker-runtime";
import { ensureStoredAgentDefaultRouting } from "../../../api/stored-agents";
import {
  useLocalRuntimeMutations,
  useLocalRuntimesQuery,
  useResolvedCredentialQuery,
} from "../../../hooks/useServerStateQueries";
import type { Agent } from "../../../types/agents";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import { type ModelTierFloor } from "../../../../../../contracts/model-tiers";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Select } from "../../ui/Select";
import { HostedModelSelect } from "../HostedModelSelect";
import { RUNTIME_PROVIDER_OPTIONS } from "./constants";
import {
  buildLocalRuntimeRunnerOptions,
  buildRoutingWarnings,
  localRunnerLabel,
  MODEL_TIER_FLOOR_OPTIONS,
} from "./agent-runtime-editor-shared";
import { FallbackChainBuilder } from "./FallbackChainBuilder";
import { LocalRuntimeBindingPanel } from "./LocalRuntimeBindingPanel";

type AgentRuntimeEditorProps = {
  agent: Agent;
  runtimeProfile: AgentRuntimeProfile | null;
  runtimeProvider: AgentRuntimeProfile["provider"];
  setRuntimeProvider: (value: AgentRuntimeProfile["provider"]) => void;
  runtimeModel: string;
  setRuntimeModel: (value: string) => void;
  runtimeFallbacks: AgentRuntimeProfile["fallbacks"];
  setRuntimeFallbacks: (value: AgentRuntimeProfile["fallbacks"]) => void;
  runtimeModelTierFloor: ModelTierFloor;
  setRuntimeModelTierFloor: (value: ModelTierFloor) => void;
  runtimeProfileLoading: boolean;
  runtimeProfileSaving: boolean;
  runtimeProfileDirty: boolean;
  runtimeProviderIsLocal: boolean;
  runtimeCredentialMissing: boolean;
  onRuntimeProfileSaveInput: (input: {
    provider: AgentRuntimeProfile["provider"];
    model: string;
    credentialRef?: AgentRuntimeProfile["credentialRef"];
    fallbacks?: AgentRuntimeProfile["fallbacks"];
    modelTierFloor?: ModelTierFloor;
    localEndpointUrl?: string | null;
  }) => Promise<void> | void;
  onAgentReload: () => Promise<void>;
  onError: (message: string) => void;
  onClearError: () => void;
};

export function AgentRuntimeEditor({
  agent,
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
  onRuntimeProfileSaveInput,
  onAgentReload,
  onError,
  onClearError,
}: AgentRuntimeEditorProps) {
  const [startingRuntime, setStartingRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [ensuringRouting, setEnsuringRouting] = useState(false);
  const [selectedLocalRunnerId, setSelectedLocalRunnerId] = useState("");
  const [localProbeResult, setLocalProbeResult] =
    useState<LocalModelProbeResponse | null>(null);

  const workspaceId = agent.workspaceId;
  const localRuntimesQuery = useLocalRuntimesQuery(workspaceId);
  const localRuntimeMutations = useLocalRuntimeMutations(workspaceId);
  const credentialQuery = useResolvedCredentialQuery(agent.id, workspaceId);
  const localRunnerOptions = useMemo(
    () =>
      (localRuntimesQuery.data?.runtimes ?? []).flatMap((runtime) =>
        runtime.runners
          .filter((runner) => runner.kind === "openai_compatible")
          .map((runner) => ({ id: runner.id, runtime, runner })),
      ),
    [localRuntimesQuery.data?.runtimes],
  );
  const onlineLocalRunnerOptions = useMemo(
    () =>
      localRunnerOptions.filter(
        (option) => option.runtime.localExecution.helperOnline,
      ),
    [localRunnerOptions],
  );
  const assignedLocalRunner = useMemo(
    () =>
      localRunnerOptions.find((option) =>
        option.runner.agents.some((assigned) => assigned.agentId === agent.id),
      ) ?? null,
    [agent.id, localRunnerOptions],
  );
  const assignedLocalRunnerId = assignedLocalRunner?.id ?? "";
  const helperRegistered = localRunnerOptions.length > 0;
  const firstOnlineLocalRunnerId = onlineLocalRunnerOptions[0]?.id ?? "";
  const selectedLocalRunner = useMemo(
    () =>
      localRunnerOptions.find(
        (option) => option.id === selectedLocalRunnerId,
      ) ?? null,
    [localRunnerOptions, selectedLocalRunnerId],
  );
  const previousLocalRuntimeSelectionRef = useRef<{
    agentId: string;
    assignedLocalRunnerId: string;
  } | null>(null);

  useEffect(() => {
    if (runtimeProvider !== "local") {
      setLocalProbeResult(null);
      return;
    }

    const previous = previousLocalRuntimeSelectionRef.current;
    const agentChanged = previous === null || previous.agentId !== agent.id;
    const assignmentChanged =
      previous === null ||
      previous.assignedLocalRunnerId !== assignedLocalRunnerId;
    previousLocalRuntimeSelectionRef.current = {
      agentId: agent.id,
      assignedLocalRunnerId,
    };

    if (agentChanged || assignmentChanged) {
      setSelectedLocalRunnerId(
        assignedLocalRunnerId || firstOnlineLocalRunnerId,
      );
      return;
    }

    if (!selectedLocalRunnerId && firstOnlineLocalRunnerId) {
      setSelectedLocalRunnerId(firstOnlineLocalRunnerId);
      return;
    }
  }, [
    agent.id,
    assignedLocalRunnerId,
    firstOnlineLocalRunnerId,
    runtimeProvider,
    selectedLocalRunnerId,
  ]);

  useEffect(() => {
    setLocalProbeResult(null);
  }, [selectedLocalRunnerId]);

  useEffect(() => {
    const missing = agent.configurationStatus?.missing ?? [];
    const shouldEnsure =
      agent.agentType !== "custom" &&
      Boolean(agent.model) &&
      missing.some(
        (requirement) =>
          requirement === "runner" || requirement === "gateway_config",
      );

    if (!shouldEnsure) return;

    let cancelled = false;
    setEnsuringRouting(true);
    ensureStoredAgentDefaultRouting(agent.id)
      .then(async (result) => {
        if (!cancelled && result.changed) {
          await onAgentReload();
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEnsuringRouting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    agent.id,
    agent.agentType,
    agent.model,
    agent.configurationStatus,
    onAgentReload,
    onError,
  ]);

  const handleStartRuntime = async () => {
    setStartingRuntime(true);
    onClearError();
    setRuntimeMessage(null);
    try {
      const result = await prepareRuntime(agent.id);
      if (!result.readyToConnect) {
        throw new Error(
          result.reasons.join(", ") || "Could not start orchestrator runtime.",
        );
      }
      setRuntimeMessage("Orchestrator runtime is ready for this agent.");
    } catch (err) {
      onError(String(err));
    } finally {
      setStartingRuntime(false);
    }
  };

  const handleUseLocalRunner = async () => {
    if (!selectedLocalRunner) {
      onError("Select an advertised local model before saving.");
      return;
    }
    if (!selectedLocalRunner.runtime.localExecution.helperOnline) {
      onError("Selected local runtime is offline.");
      return;
    }

    onClearError();
    setRuntimeMessage(null);
    try {
      await localRuntimeMutations.assignLocalModel.mutateAsync({
        agentId: agent.id,
        machineId: selectedLocalRunner.runtime.id,
        localRuntimeId: selectedLocalRunner.runner.id,
      });
      await onRuntimeProfileSaveInput({
        provider: "local",
        model: selectedLocalRunner.runner.model,
        credentialRef: null,
        localEndpointUrl: selectedLocalRunner.runner.endpoint,
      });
      setRuntimeProvider("local");
      setRuntimeModel(selectedLocalRunner.runner.model);
      setRuntimeMessage(
        `Local runtime bound: ${localRunnerLabel(selectedLocalRunner)}.`,
      );
      await onAgentReload();
    } catch (err) {
      onError(String(err));
    }
  };

  const handleTestLocalRunner = async () => {
    if (!selectedLocalRunner) {
      onError("Select an advertised local model before testing.");
      return;
    }
    onClearError();
    setRuntimeMessage(null);
    try {
      const result = await localRuntimeMutations.probeRegistered.mutateAsync(
        selectedLocalRunner.runner.id,
      );
      setLocalProbeResult(result);
    } catch (err) {
      onError(String(err));
    }
  };

  const localRuntimeSaving =
    localRuntimeMutations.assignLocalModel.isPending || runtimeProfileSaving;
  const localRuntimeTesting = localRuntimeMutations.probeRegistered.isPending;
  const routingWarnings = buildRoutingWarnings({
    primaryProvider: runtimeProvider,
    primaryModel: runtimeModel,
    modelTierFloor: runtimeModelTierFloor,
    fallbacks: runtimeFallbacks,
  });

  const saveRuntimeWithCutover = async () => {
    await onRuntimeProfileSaveInput({
      provider: runtimeProvider,
      model: runtimeModel,
      credentialRef: runtimeProfile?.credentialRef ?? null,
      fallbacks: runtimeFallbacks,
      modelTierFloor: runtimeModelTierFloor,
      localEndpointUrl: runtimeProfile?.localEndpointUrl ?? null,
    });
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-medium text-slate-300">Runtime</h4>
          <p className="mt-1 text-xs text-slate-500">
            Select the provider and model this agent uses at dispatch time.
          </p>
          {runtimeMessage && (
            <p className="mt-2 text-xs text-green-400">{runtimeMessage}</p>
          )}
          {runtimeProviderIsLocal &&
            runtimeProfile &&
            !runtimeProfile.localHelperRegistered && (
              <p className="mt-2 text-xs text-amber-400">
                No local runtime relay helper is registered for this workspace.{" "}
                <Link
                  to="/settings/local-runtimes"
                  className="underline hover:text-amber-300"
                >
                  Open local runtimes
                </Link>
              </p>
            )}
          {runtimeCredentialMissing && (
            <p className="mt-2 text-xs text-amber-400">
              Save a credential reference before using this hosted provider.
            </p>
          )}
          {ensuringRouting && (
            <p className="mt-2 text-xs text-slate-500">
              Preparing default routing...
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            loading={runtimeProfileSaving}
            disabled={
              runtimeProfileLoading ||
              runtimeProvider === "local" ||
              !runtimeProfileDirty ||
              runtimeCredentialMissing
            }
            onClick={saveRuntimeWithCutover}
          >
            Save runtime
          </Button>
          <Button
            size="sm"
            loading={startingRuntime}
            onClick={handleStartRuntime}
          >
            Start orchestrator
          </Button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Select
          label="Provider"
          value={runtimeProvider}
          onChange={(event) =>
            setRuntimeProvider(
              event.target.value as AgentRuntimeProfile["provider"],
            )
          }
          options={RUNTIME_PROVIDER_OPTIONS}
          disabled={runtimeProfileLoading}
        />
        {runtimeProvider === "local" ? (
          <Select
            label="Model"
            value={selectedLocalRunnerId}
            onChange={(event) => setSelectedLocalRunnerId(event.target.value)}
            disabled={
              runtimeProfileLoading ||
              localRuntimesQuery.isLoading ||
              onlineLocalRunnerOptions.length === 0
            }
            options={buildLocalRuntimeRunnerOptions(
              onlineLocalRunnerOptions,
              selectedLocalRunnerId,
            )}
          />
        ) : (
          <HostedModelSelect
            label="Model"
            value={runtimeModel}
            workspaceId={agent.workspaceId}
            provider={runtimeProvider}
            onChange={setRuntimeModel}
            disabled={runtimeProfileLoading}
          />
        )}
      </div>
      {runtimeProvider !== "local" && (
        <div className="mt-4 space-y-3 rounded-md border border-white/5 bg-surface px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h5 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Cutover policy
              </h5>
            </div>
            <Select
              aria-label="Adequacy floor"
              value={runtimeModelTierFloor}
              onChange={(event) =>
                setRuntimeModelTierFloor(event.target.value as ModelTierFloor)
              }
              options={MODEL_TIER_FLOOR_OPTIONS}
              disabled={runtimeProfileLoading}
              className="min-w-36"
            />
          </div>

          <FallbackChainBuilder
            agentId={agent.id}
            workspaceId={workspaceId}
            fallbacks={runtimeFallbacks}
            disabled={runtimeProfileLoading || runtimeProfileSaving}
            credentialState={credentialQuery.data ?? null}
            onChange={setRuntimeFallbacks}
          />

          {routingWarnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-600/30 bg-amber-950/20 px-3 py-2">
              {routingWarnings.map((warning) => (
                <p key={warning} className="text-xs text-amber-200">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      {runtimeProvider === "local" && (
        <LocalRuntimeBindingPanel
          localRuntimesLoading={localRuntimesQuery.isLoading}
          helperRegistered={helperRegistered}
          assignedLocalRunner={assignedLocalRunner}
          selectedLocalRunner={selectedLocalRunner}
          onlineLocalRunnerOptions={onlineLocalRunnerOptions}
          localProbeResult={localProbeResult}
          localRuntimeTesting={localRuntimeTesting}
          localRuntimeSaving={localRuntimeSaving}
          runtimeProfileLoading={runtimeProfileLoading}
          onTestLocalRunner={handleTestLocalRunner}
          onUseLocalRunner={handleUseLocalRunner}
        />
      )}
    </Card>
  );
}
