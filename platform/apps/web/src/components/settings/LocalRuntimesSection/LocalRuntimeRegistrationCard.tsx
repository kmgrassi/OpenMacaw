import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { LocalRuntimeConfigPanel } from "./LocalRuntimeConfigPanel";
import type { LocalRuntimeRegistrationState } from "./useLocalRuntimeRegistration";
import {
  LOCAL_MODEL_OPTIONS,
  PROVIDER_OPTIONS,
  TOOL_CALL_CAPABILITY_OPTIONS,
} from "./utils";

type Props = {
  registration: LocalRuntimeRegistrationState;
  waitingForHelper: boolean;
};

export function LocalRuntimeRegistrationCard({
  registration,
  waitingForHelper,
}: Props) {
  const noneSelected =
    !registration.modelEnabled && !registration.openClawEnabled;

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">
          Set up local runtime
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          One local runtime relay can advertise more than one runner kind.
          Select every kind you want this relay to handle — the install command
          will write all selected stanzas into runtime.toml.
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-white/5 bg-surface-raised p-3">
        <Checkbox
          containerClassName="flex items-start gap-3"
          checked={registration.modelEnabled}
          onChange={(event) =>
            registration.handleModelEnabledChange(event.target.checked)
          }
          label={
            <span className="text-sm font-medium text-slate-200">
              Local model
            </span>
          }
          description="OpenAI-compatible chat endpoint (e.g. Ollama, llama.cpp, vLLM)."
        />
        {registration.modelEnabled && (
          <div className="grid gap-3 pl-7">
            <Input
              label="Endpoint URL"
              value={registration.modelEndpoint}
              onChange={(e) =>
                registration.handleModelEndpointChange(e.target.value)
              }
              placeholder="http://localhost:11434/v1"
            />
            <Input
              label="Model name"
              value={registration.modelName}
              onChange={(e) =>
                registration.handleModelNameChange(e.target.value)
              }
              placeholder="qwen3-coder:30b"
              list="local-runtime-model-options"
              onKeyDown={(e) =>
                e.key === "Enter" && void registration.handleRegister()
              }
            />
            <datalist id="local-runtime-model-options">
              {LOCAL_MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </datalist>
            <Select
              label="Provider"
              value={registration.provider}
              onChange={(e) => registration.setProvider(e.target.value)}
              options={PROVIDER_OPTIONS}
            />
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <Input
                  label="Local repository path"
                  value={registration.repositoryPath}
                  onChange={(e) =>
                    registration.setRepositoryPath(e.target.value)
                  }
                  placeholder="/Users/me/project"
                  className="font-mono"
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={registration.pickingRepositoryPath}
                    onClick={() =>
                      void registration.handlePickRepositoryPath()
                    }
                  >
                    Browse...
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Paste an absolute path or choose a directory. The local agent
                can read and write under this root.
              </p>
            </div>
            <Select
              label="Tool-call support"
              value={registration.toolCallCapability}
              onChange={(e) =>
                registration.setToolCallCapability(
                  e.target.value as typeof registration.toolCallCapability,
                )
              }
              options={TOOL_CALL_CAPABILITY_OPTIONS}
            />
            <Input
              label="API key (optional)"
              type="password"
              value={registration.modelApiKey}
              onChange={(e) => registration.setModelApiKey(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-white/5 bg-surface-raised p-3">
        <Checkbox
          containerClassName="flex items-start gap-3"
          checked={registration.openClawEnabled}
          onChange={(event) =>
            registration.handleOpenClawEnabledChange(event.target.checked)
          }
          label={
            <span className="text-sm font-medium text-slate-200">OpenClaw</span>
          }
          description="HTTP endpoint of a local OpenClaw runtime (manages its own tool loop)."
        />
        {registration.openClawEnabled && (
          <div className="grid gap-3 pl-7">
            <Input
              label="Endpoint URL"
              value={registration.openClawEndpoint}
              onChange={(e) => registration.setOpenClawEndpoint(e.target.value)}
              placeholder="http://localhost:7100"
            />
            <Input
              label="API key (optional)"
              type="password"
              value={registration.openClawApiKey}
              onChange={(e) => registration.setOpenClawApiKey(e.target.value)}
              placeholder="sk-openclaw-..."
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-h-4 text-xs">
          {noneSelected && (
            <span className="text-amber-300">
              Select at least one runner kind to register this relay.
            </span>
          )}
          {!noneSelected && registration.registerError && (
            <span className="text-red-400">{registration.registerError}</span>
          )}
          {registration.draftProbeAvailable &&
            registration.modelEnabled &&
            registration.draftProbe && (
            <span
              className={
                registration.draftProbe.reachable &&
                registration.draftProbe.modelFound
                  ? "text-green-300"
                  : "text-amber-300"
              }
            >
              {registration.draftProbe.reachable &&
              registration.draftProbe.modelFound
                ? "Probe succeeded."
                : registration.draftProbe.error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {registration.draftProbeAvailable && registration.modelEnabled && (
            <Button
              size="sm"
              variant="secondary"
              loading={registration.probingDraft}
              disabled={
                !registration.modelEndpoint.trim() ||
                !registration.modelName.trim()
              }
              onClick={() => void registration.handleProbeDraft()}
            >
              Probe model
            </Button>
          )}
          <Button
            size="sm"
            loading={registration.registering}
            disabled={!registration.canSubmit}
            onClick={() => void registration.handleRegister()}
          >
            Set up local computer
          </Button>
        </div>
      </div>

      {registration.registrationResult && (
        <LocalRuntimeConfigPanel
          config={registration.registrationResult}
          onClear={() => registration.setRegistrationResult(null)}
        />
      )}
      {waitingForHelper && (
        <div className="rounded-md border border-amber-600/30 bg-amber-950/10 px-3 py-2 text-sm text-amber-200">
          Waiting for relay connection. This page is polling status every 5
          seconds.
        </div>
      )}
    </Card>
  );
}
