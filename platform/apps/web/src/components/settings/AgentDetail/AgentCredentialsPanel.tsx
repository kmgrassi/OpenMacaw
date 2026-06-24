import type { Agent } from "../../../types/agents";
import { AgentCredentials } from "../AgentCredentials";
import { AgentModelPolicy } from "../AgentModelPolicy";
import { AgentWorkerLaunch } from "../AgentWorkerLaunch";
import { CredentialPicker } from "../CredentialPicker";
import { runtimeRunnerKindForAgent } from "./utils";

type AgentCredentialsPanelProps = {
  agent: Agent;
  workspaceId: string | null | undefined;
  runtimeProvider: string;
  runtimeModel: string;
  runtimeProfileRunnerKind: string | null | undefined;
  refreshKey: number;
  onSaved: () => void;
};

export function AgentCredentialsPanel({
  agent,
  workspaceId,
  runtimeProvider,
  runtimeModel,
  runtimeProfileRunnerKind,
  refreshKey,
  onSaved,
}: AgentCredentialsPanelProps) {
  const runnerKind = runtimeRunnerKindForAgent(
    agent,
    runtimeProvider,
    runtimeProfileRunnerKind,
  );

  return (
    <>
      <AgentWorkerLaunch
        agentId={agent.id}
        agentName={agent.name}
        provider={agent.provider}
        agentType={agent.agentType}
      />

      <CredentialPicker
        agentId={agent.id}
        workspaceId={workspaceId}
        providerFilter={runtimeProvider === "local" ? null : runtimeProvider}
        runnerKind={runnerKind}
        model={runtimeModel || agent.model}
        refreshKey={refreshKey}
        onSaved={onSaved}
      />

      {agent.agentType !== "manager" && (
        <AgentCredentials agent={agent} onSaved={onSaved} />
      )}

      {agent.agentType === "coding" && (
        <AgentModelPolicy
          agent={agent}
          refreshKey={refreshKey}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
