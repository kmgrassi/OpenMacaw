import { Link } from "react-router-dom";
import type { LocalModelProbeResponse } from "../../../api/local-runtime";
import { Button } from "../../ui/Button";
import { WizardCheck } from "./WizardCheck";
import {
  localRunnerLabel,
  type LocalRuntimeRunnerOption,
} from "./agent-runtime-editor-shared";

type LocalRuntimeBindingPanelProps = {
  localRuntimesLoading: boolean;
  helperRegistered: boolean;
  assignedLocalRunner: LocalRuntimeRunnerOption | null;
  selectedLocalRunner: LocalRuntimeRunnerOption | null;
  onlineLocalRunnerOptions: LocalRuntimeRunnerOption[];
  localProbeResult: LocalModelProbeResponse | null;
  localRuntimeTesting: boolean;
  localRuntimeSaving: boolean;
  runtimeProfileLoading: boolean;
  onTestLocalRunner: () => void;
  onUseLocalRunner: () => void;
};

export function LocalRuntimeBindingPanel({
  localRuntimesLoading,
  helperRegistered,
  assignedLocalRunner,
  selectedLocalRunner,
  onlineLocalRunnerOptions,
  localProbeResult,
  localRuntimeTesting,
  localRuntimeSaving,
  runtimeProfileLoading,
  onTestLocalRunner,
  onUseLocalRunner,
}: LocalRuntimeBindingPanelProps) {
  return (
    <div className="mt-4 space-y-3 rounded-md border border-white/5 bg-surface px-3 py-3">
      <div className="grid gap-2 text-xs md:grid-cols-3">
        <WizardCheck
          label="Helper connected"
          state={
            localRuntimesLoading
              ? "pending"
              : helperRegistered
                ? "pass"
                : "fail"
          }
          detail={
            helperRegistered
              ? "Relay registered for this workspace."
              : "Set up a helper from local runtime settings."
          }
        />
        <WizardCheck
          label="Model advertised"
          state={selectedLocalRunner ? "pass" : "fail"}
          detail={
            selectedLocalRunner
              ? localRunnerLabel(selectedLocalRunner)
              : "No online helper is advertising a model."
          }
        />
        <WizardCheck
          label="Dispatch test"
          state={
            localProbeResult
              ? localProbeResult.reachable && localProbeResult.modelFound
                ? "pass"
                : "fail"
              : "pending"
          }
          detail={
            localProbeResult
              ? localProbeResult.reachable && localProbeResult.modelFound
                ? "Connection test passed."
                : (localProbeResult.error ??
                  "The helper did not find the selected model.")
              : "Run a test before binding."
          }
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {assignedLocalRunner ? (
            <p className="text-xs text-green-400">
              Bound to {localRunnerLabel(assignedLocalRunner)}.
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Pick an advertised model, test the helper path, then bind this
              agent.
            </p>
          )}
          {selectedLocalRunner && (
            <p className="mt-1 text-xs text-slate-500">
              {selectedLocalRunner.runner.endpoint} ·{" "}
              {selectedLocalRunner.runner.toolCallCapability ??
                "tool support unknown"}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={localRuntimeTesting}
            disabled={
              runtimeProfileLoading ||
              localRuntimesLoading ||
              !selectedLocalRunner ||
              !selectedLocalRunner.runtime.localExecution.helperOnline
            }
            onClick={onTestLocalRunner}
          >
            Run test
          </Button>
          <Button
            size="sm"
            loading={localRuntimeSaving}
            disabled={
              runtimeProfileLoading ||
              localRuntimesLoading ||
              !selectedLocalRunner ||
              !selectedLocalRunner.runtime.localExecution.helperOnline ||
              !localProbeResult?.reachable ||
              !localProbeResult.modelFound
            }
            onClick={onUseLocalRunner}
          >
            Use local model
          </Button>
        </div>
      </div>
      {!localRuntimesLoading && onlineLocalRunnerOptions.length === 0 && (
        <p className="text-xs text-amber-400">
          No online local model runtime is registered for this workspace.{" "}
          <Link
            to="/settings/local-runtimes"
            className="underline hover:text-amber-300"
          >
            Set up local runtime
          </Link>
        </p>
      )}
    </div>
  );
}
