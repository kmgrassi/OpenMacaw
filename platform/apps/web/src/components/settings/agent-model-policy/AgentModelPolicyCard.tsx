import type {
  ApprovalPolicy,
  LocalCodingRunnerOption,
} from "../../../lib/agent-model-policy";
import { Alert } from "../../ui/Alert";
import { Card } from "../../ui/Card";
import { LoadingState } from "../../ui/LoadingState";
import { Select } from "../../ui/Select";
import { CredentialSelectionSection } from "./CredentialSelectionSection";
import { LearningProviderChangeDialog } from "./LearningProviderChangeDialog";
import { LocalCodingRunnerPanel } from "./LocalCodingRunnerPanel";
import { NoModelsState } from "./NoModelsState";
import { PolicyActionButtons } from "./PolicyActionButtons";

type SelectOption = {
  value: string;
  label: string;
};

type AgentModelPolicyCardProps = {
  approvalPolicy: ApprovalPolicy;
  credentialProviderLabel: string;
  credentialSelectionRequired: boolean;
  dirty: boolean;
  disableSave: boolean;
  error: string | null;
  isCodingAgent: boolean;
  loadingCredentials: boolean;
  loadingModels: boolean;
  localCodingSelected: boolean;
  localRelaySelected: boolean;
  localRelayTarget: string;
  modelOptions: SelectOption[];
  pendingProviderChange: {
    fromProvider: string | null;
    toProvider: string | null;
  } | null;
  saving: boolean;
  selectedCodingOption: LocalCodingRunnerOption | null;
  selectedCredentialOptions: SelectOption[];
  selectedCredentialRef: string;
  selectedLocalRunnerId: string;
  selectedModel: string;
  selectedModelAvailable: boolean;
  selectedProvider: string | null;
  selectedRunnerKind: string;
  showNoModelsState: boolean;
  workspaceId: string | null | undefined;
  codingOptions: LocalCodingRunnerOption[];
  onApprovalPolicyChange: (value: ApprovalPolicy) => void;
  onCancelPendingProviderChange: () => void;
  onConfirmPendingProviderChange: () => Promise<void>;
  onCredentialRefChange: (value: string) => void;
  onLocalRelayTargetChange: (value: string) => void;
  onLocalRunnerIdChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onReset: () => void;
  onRunnerKindChange: (runnerKind: string) => void;
  onSave: () => void;
};

export function AgentModelPolicyCard({
  approvalPolicy,
  credentialProviderLabel,
  credentialSelectionRequired,
  dirty,
  disableSave,
  error,
  isCodingAgent,
  loadingCredentials,
  loadingModels,
  localCodingSelected,
  localRelaySelected,
  localRelayTarget,
  modelOptions,
  pendingProviderChange,
  saving,
  selectedCodingOption,
  selectedCredentialOptions,
  selectedCredentialRef,
  selectedLocalRunnerId,
  selectedModel,
  selectedModelAvailable,
  selectedProvider,
  selectedRunnerKind,
  showNoModelsState,
  workspaceId,
  codingOptions,
  onApprovalPolicyChange,
  onCancelPendingProviderChange,
  onConfirmPendingProviderChange,
  onCredentialRefChange,
  onLocalRelayTargetChange,
  onLocalRunnerIdChange,
  onModelChange,
  onReset,
  onRunnerKindChange,
  onSave,
}: AgentModelPolicyCardProps) {
  return (
    <Card>
      {pendingProviderChange && (
        <LearningProviderChangeDialog
          saving={saving}
          onCancel={onCancelPendingProviderChange}
          onConfirm={onConfirmPendingProviderChange}
        />
      )}
      <h4 className="mb-3 text-sm font-medium text-slate-300">
        Coding Runner
      </h4>
      {loadingModels || loadingCredentials ? (
        <LoadingState label="Loading runner settings..." />
      ) : showNoModelsState ? (
        <NoModelsState />
      ) : (
        <div className="space-y-3">
          {isCodingAgent && (
            <LocalCodingRunnerPanel
              workspaceId={workspaceId}
              codingOptions={codingOptions}
              selectedRunnerKind={selectedRunnerKind}
              selectedCodingOption={selectedCodingOption}
              selectedLocalRunnerId={selectedLocalRunnerId}
              localCodingSelected={localCodingSelected}
              localRelaySelected={localRelaySelected}
              localRelayTarget={localRelayTarget}
              approvalPolicy={approvalPolicy}
              onRunnerKindChange={onRunnerKindChange}
              onLocalRunnerIdChange={onLocalRunnerIdChange}
              onLocalRelayTargetChange={onLocalRelayTargetChange}
              onApprovalPolicyChange={onApprovalPolicyChange}
            />
          )}

          {!localCodingSelected && !localRelaySelected && (
            <Select
              label="Primary model"
              value={selectedModelAvailable ? selectedModel : ""}
              onChange={(event) => onModelChange(event.target.value)}
              options={modelOptions}
            />
          )}
          <CredentialSelectionSection
            localCodingSelected={localCodingSelected}
            selectedProvider={selectedProvider}
            selectedCredentialRef={selectedCredentialRef}
            selectedCredentialOptions={selectedCredentialOptions}
            credentialSelectionRequired={credentialSelectionRequired}
            credentialProviderLabel={credentialProviderLabel}
            onCredentialRefChange={onCredentialRefChange}
          />
          {error && (
            <Alert tone="error" compact>
              {error}
            </Alert>
          )}
          <PolicyActionButtons
            dirty={dirty}
            disableSave={disableSave}
            saving={saving}
            onReset={onReset}
            onSave={onSave}
          />
        </div>
      )}
    </Card>
  );
}
