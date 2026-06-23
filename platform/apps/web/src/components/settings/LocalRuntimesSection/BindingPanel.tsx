import { Link } from "react-router-dom";
import type {
  LocalRuntime,
  LocalRuntimeRunner,
} from "../../../api/local-runtime";
import type { Agent } from "../../../types/agents";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import type { LocalRuntimeRunnerAssignment } from "./useLocalRuntimesPage";

function agentLabel(agent: Agent) {
  return agent.agentType === "manager"
    ? `${agent.name} (manager)`
    : `${agent.name} (${agent.agentType})`;
}

function runnerLabel(runner: LocalRuntimeRunner) {
  if (runner.kind === "openclaw") {
    return `OpenClaw (${runner.endpoint})`;
  }
  return runner.model
    ? `${runner.model} (${runner.provider})`
    : `${runner.provider} (${runner.endpoint})`;
}

export function BindingPanel({
  agents,
  assignedRunnerByAgent,
  bindingAgentId,
  bindingRunnerId,
  runtime,
  onBindAgentToRunner,
}: {
  agents: Agent[];
  assignedRunnerByAgent: Map<string, LocalRuntimeRunnerAssignment>;
  bindingAgentId: string | null;
  bindingRunnerId: string | null;
  runtime: LocalRuntime;
  onBindAgentToRunner: (input: {
    agentId: string;
    runtime: LocalRuntime;
    runner: LocalRuntimeRunner;
  }) => void;
}) {
  const runners = runtime.runners;
  const canBind = runtime.localExecution.helperOnline;
  const boundAgentIds = new Set<string>();
  for (const runner of runners) {
    for (const agent of runner.agents) {
      boundAgentIds.add(agent.agentId);
    }
  }
  const unboundAgents = agents.filter((agent) => !boundAgentIds.has(agent.id));

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Agent bindings</h3>
        <p className="mt-1 text-xs text-slate-500">
          Bind agents to the local runner they should dispatch to from this
          machine.
        </p>
      </div>

      <div className="space-y-2">
        {runners.map((runner) => (
          <div
            key={runner.id}
            className="rounded-md border border-white/5 bg-surface px-3 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-slate-200">
                  {runnerLabel(runner)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {runner.endpoint}
                </div>
              </div>
              <div className="text-xs text-slate-500">
                {runner.agents.length} bound
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {runner.agents.map((boundAgent) => (
                <AgentLink
                  key={boundAgent.agentId}
                  agentId={boundAgent.agentId}
                  label={boundAgent.agentName}
                />
              ))}
              {runner.agents.length === 0 && (
                <div className="text-xs text-slate-500">
                  No agents currently use this runner.
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {unboundAgents.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-400">
            Available agents
          </div>
          {unboundAgents.map((agent) => {
            const assignedElsewhere = assignedRunnerByAgent.get(agent.id);
            return (
              <div
                key={agent.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/5 bg-surface px-3 py-2"
              >
                <div>
                  <div className="text-sm text-slate-200">
                    {agentLabel(agent)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {assignedElsewhere
                      ? `Currently bound to ${runnerLabel(assignedElsewhere.runner)}.`
                      : "Hosted/default until bound to a local runner."}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {runners.map((runner) => {
                    const isBinding =
                      bindingAgentId === agent.id &&
                      bindingRunnerId === runner.id;
                    return (
                      <Button
                        key={runner.id}
                        size="sm"
                        variant="secondary"
                        loading={isBinding}
                        disabled={!canBind}
                        onClick={() =>
                          onBindAgentToRunner({
                            agentId: agent.id,
                            runtime,
                            runner,
                          })
                        }
                      >
                        {runners.length === 1
                          ? assignedElsewhere
                            ? "Move binding here"
                            : "Bind to this agent"
                          : `Bind to ${runner.model || runner.provider}`}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AgentLink({ agentId, label }: { agentId: string; label: string }) {
  return (
    <Link
      to={`/settings/agents/${encodeURIComponent(agentId)}`}
      className="inline-flex items-center rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-surface-overlay"
    >
      {label}
    </Link>
  );
}
