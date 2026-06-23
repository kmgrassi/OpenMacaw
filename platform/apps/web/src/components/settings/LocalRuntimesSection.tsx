import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { BindingPanel } from "./LocalRuntimesSection/BindingPanel";
import { BoundSummary } from "./LocalRuntimesSection/BoundSummary";
import { DoctorPanel } from "./LocalRuntimesSection/DoctorPanel";
import { LocalRuntimeRegistrationCard } from "./LocalRuntimesSection/LocalRuntimeRegistrationCard";
import { LocalRuntimeConfigPanel } from "./LocalRuntimesSection/LocalRuntimeConfigPanel";
import { RuntimeStatusCard } from "./LocalRuntimesSection/RuntimeStatusCard";
import { useLocalRuntimesPage } from "./LocalRuntimesSection/useLocalRuntimesPage";
import { WizardSteps } from "./LocalRuntimesSection/WizardSteps";

export function LocalRuntimesSection() {
  const {
    agents,
    assignedRunnerByAgent,
    configActionRuntimeId,
    configResult,
    currentRuntime,
    error,
    events,
    eventsLoading,
    heartbeatIntervalMs,
    loading,
    runnerProbes,
    bindingAgentId,
    bindingPending,
    bindingRunnerId,
    probingRunnerId,
    registration,
    removingId,
    testDispatchResults,
    testingMachineId,
    wizardState,
    handleBindAgentToRunner,
    handleConfigAction,
    handleProbeRunner,
    handleTestDispatch,
    handleRemove,
    loadRuntimes,
    setConfigResult,
  } = useLocalRuntimesPage();

  return (
    <div className="w-full max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">
            Local runtimes
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Connect one local runtime relay to this workspace. A single relay
            can advertise more than one runner kind, so bind each agent to the
            exact runner it should dispatch to.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={loading}
          onClick={() => void loadRuntimes()}
        >
          Refresh
        </Button>
      </div>

      <WizardSteps state={wizardState} />

      {error && <Alert tone="error">{error}</Alert>}

      {wizardState === "not_registered" && (
        <LocalRuntimeRegistrationCard
          registration={registration}
          waitingForHelper={false}
        />
      )}

      {wizardState === "waiting" && (
        <div className="space-y-4">
          {registration.registrationResult && (
            <LocalRuntimeConfigPanel
              config={registration.registrationResult}
              onClear={() => registration.setRegistrationResult(null)}
            />
          )}
          {configResult && (
            <LocalRuntimeConfigPanel
              config={configResult}
              onClear={() => setConfigResult(null)}
            />
          )}
          <Card className="border-amber-600/30 bg-amber-950/10">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-amber-200">
                  Waiting for relay connection
                </h3>
                <p className="mt-1 text-xs text-amber-200/80">
                  This page is polling every 2 seconds and will continue once a
                  fresh heartbeat advertises every selected runner kind.
                </p>
              </div>
              {currentRuntime && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={configActionRuntimeId === currentRuntime.id}
                  onClick={() =>
                    void handleConfigAction(currentRuntime.id, "rotate")
                  }
                >
                  Reset token
                </Button>
              )}
            </div>
          </Card>
        </div>
      )}

      {currentRuntime && wizardState !== "not_registered" && (
        <div className="space-y-4">
          <RuntimeStatusCard
            runtime={currentRuntime}
            heartbeatIntervalMs={heartbeatIntervalMs}
          />
          <DoctorPanel
            runtime={currentRuntime}
            events={events}
            eventsLoading={eventsLoading}
            testResult={testDispatchResults[currentRuntime.id] ?? null}
            testing={testingMachineId === currentRuntime.id}
            onRunTest={() => void handleTestDispatch(currentRuntime.id)}
          />
        </div>
      )}

      {configResult && wizardState !== "waiting" && (
        <LocalRuntimeConfigPanel
          config={configResult}
          onClear={() => setConfigResult(null)}
        />
      )}

      {currentRuntime &&
        (wizardState === "connected" || wizardState === "bound") && (
          <BindingPanel
            agents={agents}
            assignedRunnerByAgent={assignedRunnerByAgent}
            bindingAgentId={bindingAgentId}
            bindingPending={bindingPending}
            bindingRunnerId={bindingRunnerId}
            runtime={currentRuntime}
            onBindAgentToRunner={handleBindAgentToRunner}
          />
        )}

      {currentRuntime && wizardState === "bound" && (
        <BoundSummary
          runtime={currentRuntime}
          runnerProbes={runnerProbes}
          probingRunnerId={probingRunnerId}
          resetting={configActionRuntimeId === currentRuntime.id}
          removing={removingId === currentRuntime.id}
          onProbeRunner={(runnerId) => void handleProbeRunner(runnerId)}
          onResetToken={() =>
            void handleConfigAction(currentRuntime.id, "rotate")
          }
          onDisconnect={() => void handleRemove(currentRuntime.id)}
        />
      )}
    </div>
  );
}
