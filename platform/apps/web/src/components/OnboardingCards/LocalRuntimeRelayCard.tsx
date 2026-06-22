import { useEffect, useState } from "react";
import { type LocalModelProbeResponse } from "../../api/local-runtime";
import {
  useAuthStateQuery,
  useLocalRuntimeMutations,
} from "../../hooks/useServerStateQueries";
import { cn } from "../../lib/cn";
import { useAuthStore } from "../../stores/auth";
import {
  summarizeOnboardingBlockers,
  useOnboardingStore,
} from "../../stores/onboarding";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { useDefaultAgentRows } from "./useDefaultAgentRows";

type Props = {
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
};

const LOCAL_SETUP_COMMANDS = [
  {
    label: "Install Ollama and pull a model",
    command: "ollama pull qwen2.5-coder",
  },
  {
    label: "Start local-runtime-helper from that repo root",
    command: "pnpm run start:local-helper",
  },
];

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button size="sm" variant="secondary" onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function relayProbeMessage(probe: LocalModelProbeResponse) {
  if (probe.reachable && probe.modelFound) {
    return `Local model endpoint reachable - model ${probe.model} detected.`;
  }
  if (!probe.reachable) {
    return `Couldn't reach the local model endpoint at ${probe.endpoint}.${probe.error ? ` ${probe.error}` : ""}`;
  }
  return `Reached ${probe.endpoint}, but model ${probe.model} was not found.`;
}

export function LocalRuntimeRelayCard({ onBack, onContinue, onSkip }: Props) {
  const auth = useAuthStore();
  const authStateQuery = useAuthStateQuery(false);
  const localRuntimeMutations = useLocalRuntimeMutations(auth.workspaceId);
  const agents = useDefaultAgentRows();
  const {
    localEndpoint,
    localModel,
    localRepositoryPath,
    saving,
    error,
    setError,
    setLocalEndpoint,
    setLocalModel,
    setLocalRepositoryPath,
    setSaving,
    setSelectedAgentIds,
  } = useOnboardingStore();
  const [probe, setProbe] = useState<LocalModelProbeResponse | null>(null);
  const [probing, setProbing] = useState(false);

  const missingAgents = agents.filter((agent) => !agent.agentId);
  const agentIds = agents
    .map((agent) => agent.agentId)
    .filter((agentId): agentId is string => Boolean(agentId));
  const canTest =
    Boolean(auth.workspaceId) &&
    localEndpoint.trim().length > 0 &&
    localModel.trim().length > 0 &&
    !probing;
  const canContinue =
    canTest &&
    Boolean(probe?.reachable && probe.modelFound) &&
    missingAgents.length === 0 &&
    !saving;

  useEffect(() => {
    if (!probe?.reachable || !probe.modelFound || !auth.workspaceId) return;

    const interval = window.setInterval(() => {
      localRuntimeMutations.probeDraft
        .mutateAsync({
          endpoint: localEndpoint.trim(),
          model: localModel.trim(),
        })
        .then(setProbe)
        .catch((caught) => setError((caught as Error).message));
    }, 5000);
    return () => window.clearInterval(interval);
  }, [auth.workspaceId, localEndpoint, localModel, probe, setError]);

  async function handleProbe() {
    if (!auth.workspaceId) {
      setError("Workspace context is required before testing a local model.");
      return;
    }

    setProbing(true);
    setError(null);
    try {
      setProbe(
        await localRuntimeMutations.probeDraft.mutateAsync({
          endpoint: localEndpoint.trim(),
          model: localModel.trim(),
        }),
      );
    } catch (caught) {
      setProbe(null);
      setError((caught as Error).message);
    } finally {
      setProbing(false);
    }
  }

  async function handleRegister() {
    if (!auth.workspaceId || missingAgents.length > 0) {
      setError(
        "Default agents are still being provisioned. Try again shortly.",
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const registered = await localRuntimeMutations.register.mutateAsync({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: localEndpoint.trim(),
            model: localModel.trim(),
            provider: "openai_compatible",
            workspaceRoot: localRepositoryPath.trim() || undefined,
            toolCallCapability: "native_tools",
          },
        ],
      });
      const codingRunner =
        registered.runners.find(
          (runner) => runner.kind === "openai_compatible",
        ) ?? registered.runners[0];
      if (!codingRunner) {
        throw new Error(
          "Local runtime relay registration returned no runners — cannot bind agents.",
        );
      }
      await Promise.all(
        agentIds.map((agentId) =>
          localRuntimeMutations.assignLocalModel.mutateAsync({
            machineId: registered.machine.id,
            localRuntimeId: codingRunner.id,
            agentId,
          }),
        ),
      );
      const authState = await authStateQuery.refetch();
      if (!authState.data) {
        throw new Error(
          "Setup state did not refresh after local runtime relay setup",
        );
      }
      auth.applyAuthState(authState.data);
      setSelectedAgentIds(agentIds);
      if (authState.data.onboarding.required) {
        setError(
          summarizeOnboardingBlockers(authState.data.onboarding.reasons),
        );
        return;
      }
      onContinue();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-slate-800 bg-slate-900/70 p-6">
      <div className="text-lg font-semibold text-white">
        Run a model on this machine
      </div>

      <div className="mt-5 grid gap-3">
        {LOCAL_SETUP_COMMANDS.map((step, index) => (
          <div
            key={step.command}
            className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/55 p-3"
          >
            <div>
              <div className="text-sm font-medium text-white">
                {index + 1}. {step.label}
              </div>
              <code className="mt-1 block break-all text-xs text-slate-400">
                {step.command}
              </code>
            </div>
            <CopyCommandButton command={step.command} />
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Input
          label="Endpoint"
          value={localEndpoint}
          onChange={(event) => {
            setLocalEndpoint(event.target.value);
            setProbe(null);
          }}
          placeholder="http://localhost:11434/v1"
        />
        <Input
          label="Model"
          value={localModel}
          onChange={(event) => {
            setLocalModel(event.target.value);
            setProbe(null);
          }}
          placeholder="qwen2.5-coder"
        />
        <Input
          label="Workspace Root"
          value={localRepositoryPath}
          onChange={(event) => setLocalRepositoryPath(event.target.value)}
          placeholder="/path/to/repository"
          className="md:col-span-2"
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void handleProbe()}
          loading={probing}
          disabled={!canTest}
        >
          Test connection
        </Button>
        <button
          type="button"
          className="text-sm text-slate-400 underline underline-offset-4 hover:text-slate-200"
          onClick={onSkip}
        >
          I'll set this up later
        </button>
      </div>

      {probe && (
        <div
          className={cn(
            "mt-4 rounded-lg border px-4 py-3 text-sm",
            probe.reachable && probe.modelFound
              ? "border-emerald-800/70 bg-emerald-950/30 text-emerald-300"
              : "border-amber-800/70 bg-amber-950/30 text-amber-300",
          )}
        >
          {relayProbeMessage(probe)}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => void handleRegister()}
          disabled={!canContinue}
          loading={saving}
        >
          Connect relay and continue
        </Button>
      </div>
    </Card>
  );
}
