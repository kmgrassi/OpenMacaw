import { Badge } from "../../ui/Badge";
import { Select } from "../../ui/Select";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { LocalRelayTargetSelector } from "./LocalRelayTargetSelector";
import {
  CLOUD_CODING_RUNNER_KIND,
  LOCAL_MODEL_CODING_RUNNER_KIND,
  LOCAL_RELAY_RUNNER_KIND,
  type ApprovalPolicy,
  type LocalCodingRunnerOption,
} from "../../../lib/agent-model-policy";

const CLAUDE_CODE_RUNNER_KIND = "claude_code";

type LocalCodingRunnerPanelProps = {
  workspaceId: string | null | undefined;
  codingOptions: LocalCodingRunnerOption[];
  selectedRunnerKind: string;
  selectedCodingOption: LocalCodingRunnerOption | null;
  selectedLocalRunnerId: string;
  localCodingSelected: boolean;
  localRelaySelected: boolean;
  localRelayTarget: string;
  approvalPolicy: ApprovalPolicy;
  onRunnerKindChange: (runnerKind: string) => void;
  onLocalRunnerIdChange: (runnerId: string) => void;
  onLocalRelayTargetChange: (target: string) => void;
  onApprovalPolicyChange: (approvalPolicy: ApprovalPolicy) => void;
};

export function LocalCodingRunnerPanel({
  workspaceId,
  codingOptions,
  selectedRunnerKind,
  selectedCodingOption,
  selectedLocalRunnerId,
  localCodingSelected,
  localRelaySelected,
  localRelayTarget,
  approvalPolicy,
  onRunnerKindChange,
  onLocalRunnerIdChange,
  onLocalRelayTargetChange,
  onApprovalPolicyChange,
}: LocalCodingRunnerPanelProps) {
  const localOptions = codingOptions.map((option) => ({
    value: option.id,
    label: `${option.runner.model} (${option.runner.provider}) — ${option.runtime.machineDisplayName}`,
  }));

  const segmentValue = localCodingSelected
    ? LOCAL_MODEL_CODING_RUNNER_KIND
    : localRelaySelected
      ? LOCAL_RELAY_RUNNER_KIND
      : selectedRunnerKind;

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-raised p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-300">
            Coding runner
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Local model coding runs shell and patch tools in a workspace-write
            runtime. Local relay dispatches through the registered workspace
            relay to another runner kind such as OpenClaw.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={codingOptions.length > 0 ? "success" : "warning"}>
            {codingOptions.length > 0
              ? "endpoint configured"
              : "endpoint missing"}
          </Badge>
          <Badge variant={selectedCodingOption ? "success" : "warning"}>
            {selectedCodingOption ? "model selected" : "model missing"}
          </Badge>
          <Badge variant="warning">workspace-write</Badge>
        </div>
      </div>

      <SegmentedControl
        ariaLabel="Coding runner"
        value={segmentValue}
        onValueChange={(runnerKind) => {
          if (runnerKind === LOCAL_MODEL_CODING_RUNNER_KIND) {
            const firstOption = codingOptions[0];
            if (selectedLocalRunnerId || !firstOption) {
              onRunnerKindChange(LOCAL_MODEL_CODING_RUNNER_KIND);
              return;
            }
            onLocalRunnerIdChange(firstOption.id);
            return;
          }
          onRunnerKindChange(runnerKind);
        }}
        options={[
          { value: CLOUD_CODING_RUNNER_KIND, label: "Codex" },
          { value: CLAUDE_CODE_RUNNER_KIND, label: "Claude Code" },
          {
            value: LOCAL_MODEL_CODING_RUNNER_KIND,
            label: "Local model coding",
          },
          { value: LOCAL_RELAY_RUNNER_KIND, label: "Local relay" },
        ]}
        columns={4}
        fullWidth
      />

      {localCodingSelected && (
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            label="Local coding model"
            value={selectedLocalRunnerId}
            onChange={(event) => onLocalRunnerIdChange(event.target.value)}
            options={[
              {
                value: "",
                label: "Select a registered local model...",
              },
              ...localOptions,
            ]}
            error={
              selectedLocalRunnerId
                ? undefined
                : "Register or select a local model before saving."
            }
          />
          <Select
            label="Approval policy"
            value={approvalPolicy}
            onChange={(event) =>
              onApprovalPolicyChange(event.target.value as ApprovalPolicy)
            }
            options={[
              { value: "on_request", label: "Ask before risky tools" },
              { value: "never", label: "Never ask" },
            ]}
          />
        </div>
      )}

      {localRelaySelected && (
        <LocalRelayTargetSelector
          workspaceId={workspaceId}
          value={localRelayTarget}
          onChange={onLocalRelayTargetChange}
        />
      )}

      {localCodingSelected && (
        <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
          <div className="rounded-md border border-white/10 bg-surface-overlay px-2 py-2">
            Tool calls and JSON mode required
          </div>
          <div className="rounded-md border border-white/10 bg-surface-overlay px-2 py-2">
            Runtime owns shell.exec and apply_patch
          </div>
          <div className="rounded-md border border-yellow-600/30 bg-yellow-900/10 px-2 py-2 text-yellow-300">
            File writes can modify the workspace
          </div>
        </div>
      )}
    </div>
  );
}
