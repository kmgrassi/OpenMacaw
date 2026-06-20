import type {
  AgentType,
  PlanningDestination,
} from "../../../../../../contracts/agents";
import type { Agent } from "../../../types/agents";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { HostedModelSelect } from "../HostedModelSelect";
import { AGENT_KIND_OPTIONS, PLANNING_DESTINATION_OPTIONS } from "./constants";

type AgentIdentityEditorProps = {
  agent: Agent;
  name: string;
  setName: (value: string) => void;
  agentType: AgentType;
  setAgentType: (value: AgentType) => void;
  model: string;
  setModel: (value: string) => void;
  context: string;
  setContext: (value: string) => void;
  planningDestination: PlanningDestination;
  setPlanningDestination: (value: PlanningDestination) => void;
  customBackendType: string;
  setCustomBackendType: (value: string) => void;
  customBaseUrl: string;
  setCustomBaseUrl: (value: string) => void;
  customAgentId: string;
  setCustomAgentId: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
};

export function AgentIdentityEditor({
  agent,
  name,
  setName,
  agentType,
  setAgentType,
  model,
  setModel,
  context,
  setContext,
  planningDestination,
  setPlanningDestination,
  customBackendType,
  setCustomBackendType,
  customBaseUrl,
  setCustomBaseUrl,
  customAgentId,
  setCustomAgentId,
  dirty,
  saving,
  onSave,
}: AgentIdentityEditorProps) {
  const handleCancel = () => {
    setName(agent.name);
    setAgentType(agent.agentType);
    setModel(agent.model ?? "");
    setContext(agent.context ?? "");
    setPlanningDestination(agent.planningDestination ?? "database");
    setCustomBackendType(agent.customTarget?.backendType ?? "openclaw_ws");
    setCustomBaseUrl(agent.customTarget?.baseUrl ?? "ws://127.0.0.1:7788");
    setCustomAgentId(agent.customTarget?.agentId ?? "");
  };

  return (
    <Card>
      <h4 className="text-sm font-medium text-slate-300 mb-3">Identity</h4>
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            label="Agent name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My Agent"
          />
          <HostedModelSelect
            label="Primary model"
            value={model}
            workspaceId={agent.workspaceId}
            onChange={setModel}
          />
        </div>

        <Textarea
          label="Context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          placeholder="Standing instructions or background added to this agent's system prompt on every message."
          rows={5}
        />

        <SegmentedControl
          label="Agent type"
          value={agentType}
          onValueChange={setAgentType}
          options={AGENT_KIND_OPTIONS}
          columns={4}
          fullWidth
          surface="raised"
        />

        {agentType === "planning" && (
          <Select
            label="Planning destination"
            value={planningDestination}
            onChange={(event) =>
              setPlanningDestination(event.target.value as PlanningDestination)
            }
            options={PLANNING_DESTINATION_OPTIONS}
          />
        )}

        {agentType === "custom" && (
          <div className="grid gap-3 md:grid-cols-3">
            <Input
              label="Backend type"
              value={customBackendType}
              onChange={(event) => setCustomBackendType(event.target.value)}
              placeholder="openclaw_ws"
            />
            <Input
              label="Base URL"
              value={customBaseUrl}
              onChange={(event) => setCustomBaseUrl(event.target.value)}
              placeholder="ws://127.0.0.1:7788"
            />
            <Input
              label="Target agent ID"
              value={customAgentId}
              onChange={(event) => setCustomAgentId(event.target.value)}
              placeholder="planner-local"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={!dirty} loading={saving} onClick={onSave}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
