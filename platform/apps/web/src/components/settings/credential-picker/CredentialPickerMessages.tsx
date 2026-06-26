import type { SavedCredential } from "../../../api/credentials";
import { providerFilterLabel } from "./credential-picker-utils";

type CredentialPickerMessagesProps = {
  credentiallessRunner: boolean;
  referenceLoading: boolean;
  canClearSelectedReference: boolean;
  selectedRefAllowed: boolean;
  canAttachSelectedCredential: boolean;
  selectedReferenceMissingCredential: boolean;
  selectedCredential: SavedCredential | null;
  emptyFilteredCredentials: boolean;
  effectiveProviderFilter?: string | null;
  error: string | null;
  referenceSuccess: boolean;
  workspaceId?: string | null;
};

export function CredentialPickerMessages({
  credentiallessRunner,
  referenceLoading,
  canClearSelectedReference,
  selectedRefAllowed,
  canAttachSelectedCredential,
  selectedReferenceMissingCredential,
  selectedCredential,
  emptyFilteredCredentials,
  effectiveProviderFilter,
  error,
  referenceSuccess,
  workspaceId,
}: CredentialPickerMessagesProps) {
  const providerLabel = providerFilterLabel(effectiveProviderFilter);

  return (
    <>
      {referenceLoading && (
        <p className="text-xs text-slate-500">
          Loading credential references...
        </p>
      )}

      {credentiallessRunner && (
        <p className="text-xs text-slate-500">
          This runner dispatches through the registered local runtime relay and
          does not require a stored API key.
        </p>
      )}

      {canClearSelectedReference && (
        <p className="text-xs text-amber-400">
          This saved credential reference no longer matches an available
          credential. Saving will clear it.
        </p>
      )}

      {!canClearSelectedReference && !selectedRefAllowed && (
        <p className="text-xs text-amber-400">
          This credential does not match the selected provider
          {providerLabel ? ` (${providerLabel})` : ""}. Choose a matching stored
          credential before saving.
        </p>
      )}

      {!canClearSelectedReference && !canAttachSelectedCredential && (
        <p className="text-xs text-amber-400">
          {selectedReferenceMissingCredential
            ? "This credential reference could not be resolved to an available credential."
            : "This credential can be referenced, but it is not Codex-launchable for the selected runner."}
        </p>
      )}

      {selectedCredential?.validationState === "invalid" && (
        <p className="text-xs text-red-400">
          This credential was rejected by the provider. Update or replace it
          before launching the agent.
        </p>
      )}

      {selectedCredential?.validationState === "expired" && (
        <p className="text-xs text-amber-400">
          This credential is expired. Reconnect it before launching the agent.
        </p>
      )}

      {emptyFilteredCredentials && !referenceLoading && (
        <p className="text-xs text-slate-500">
          {providerLabel
            ? `No stored ${providerLabel} credentials are available to reference yet.`
            : "No workspace credentials are available to reference yet."}
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {referenceSuccess && (
        <p className="text-xs text-green-400">Credential reference updated.</p>
      )}
      {!workspaceId && (
        <p className="text-xs text-amber-400">
          Workspace context is required to save credential references.
        </p>
      )}
    </>
  );
}
