import { useEffect, useMemo, useState } from "react";

import {
  TRACKER_KIND_DESCRIPTIONS,
  TRACKER_KINDS,
  type TrackerKind,
  trackerCredentialProvider,
  trackerKindRequiresCredential,
} from "../../../../../contracts/tracker-kinds";
import {
  useCredentialMutations,
  useWorkspaceCredentialsQuery,
  useWorkspaceSettingsMutation,
  useWorkspaceSettingsQuery,
} from "../../hooks/useServerStateQueries";
import { useAuthStore } from "../../stores/auth";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { ButtonLink } from "../ui/ButtonLink";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Checkbox";
import { LoadingState } from "../ui/LoadingState";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { CredentialEditor } from "./CredentialEditor";

function credentialRowId(credential: { credentialRowId?: string; id: string }) {
  return (
    credential.credentialRowId ??
    credential.id.split(":", 1)[0] ??
    credential.id
  );
}

export function WorkspaceSection() {
  const { workspaceId } = useAuthStore();
  const settingsQuery = useWorkspaceSettingsQuery(workspaceId);
  const credentialsQuery = useWorkspaceCredentialsQuery(workspaceId);
  const settingsMutation = useWorkspaceSettingsMutation(workspaceId);
  const credentialMutations = useCredentialMutations(null, workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [trackerSuccess, setTrackerSuccess] = useState(false);
  const [trackerKind, setTrackerKind] = useState<TrackerKind>("database");
  const [trackerCredentialId, setTrackerCredentialId] = useState("");
  const [addingTrackerCredential, setAddingTrackerCredential] = useState(false);

  const settings = settingsQuery.data;
  const trackerProvider = trackerCredentialProvider(trackerKind);
  const trackerRequiresCredential = trackerKindRequiresCredential(trackerKind);
  const credentials = credentialsQuery.data ?? [];
  const trackerCredentials = useMemo(
    () =>
      credentials.filter(
        (credential) =>
          !trackerProvider || credential.provider === trackerProvider,
      ),
    [credentials, trackerProvider],
  );

  useEffect(() => {
    if (!settings) return;
    setTrackerKind(settings.trackerKind);
    setTrackerCredentialId(settings.trackerCredentialId ?? "");
  }, [settings]);

  if (!workspaceId) {
    return (
      <PageHeader
        title="Workspace"
        description="No active workspace. Pick one to manage its settings."
      />
    );
  }

  if (settingsQuery.isPending) {
    return (
      <LoadingState label="Loading workspace settings..." variant="route" />
    );
  }

  if (settingsQuery.isError) {
    return (
      <Alert tone="error">
        Could not load workspace settings.{" "}
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : ""}
      </Alert>
    );
  }

  if (!settings) {
    return (
      <LoadingState label="Loading workspace settings..." variant="route" />
    );
  }

  const learningEnabled = settings.learningEnabled;
  const isSaving = settingsMutation.isPending;
  const trackerCredentialOptions = [
    { value: "", label: `No ${trackerProvider ?? "tracker"} credential` },
    ...trackerCredentials.map((credential) => ({
      value: credentialRowId(credential),
      label: `${credential.label} (${credential.validationState})`,
    })),
  ];
  const selectedTrackerCredentialAvailable =
    !trackerCredentialId ||
    trackerCredentials.some(
      (credential) => credentialRowId(credential) === trackerCredentialId,
    );
  const trackerChanged =
    trackerKind !== settings.trackerKind ||
    trackerCredentialId !== (settings.trackerCredentialId ?? "");
  const canSaveTracker =
    !isSaving &&
    trackerChanged &&
    (!trackerRequiresCredential ||
      (Boolean(trackerCredentialId) && selectedTrackerCredentialAvailable));

  async function handleLearningToggle(nextValue: boolean) {
    setError(null);
    try {
      await settingsMutation.mutateAsync({
        workspaceId: workspaceId!,
        patch: { learningEnabled: nextValue },
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update workspace settings",
      );
    }
  }

  function handleTrackerKindChange(nextKind: TrackerKind) {
    setTrackerKind(nextKind);
    setTrackerError(null);
    setTrackerSuccess(false);
    const nextProvider = trackerCredentialProvider(nextKind);
    if (!nextProvider) {
      setTrackerCredentialId("");
      return;
    }
    const firstMatchingCredential = credentials.find(
      (credential) => credential.provider === nextProvider,
    );
    setTrackerCredentialId(
      firstMatchingCredential ? credentialRowId(firstMatchingCredential) : "",
    );
  }

  async function handleTrackerSave() {
    setTrackerError(null);
    setTrackerSuccess(false);
    try {
      await settingsMutation.mutateAsync({
        workspaceId: workspaceId!,
        patch: {
          trackerKind,
          trackerCredentialId: trackerCredentialId || null,
        },
      });
      setTrackerSuccess(true);
      window.setTimeout(() => setTrackerSuccess(false), 3000);
    } catch (caught) {
      setTrackerError(
        caught instanceof Error
          ? caught.message
          : "Could not update work tracker settings",
      );
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace"
        description="Settings that apply to every agent in this workspace."
      />

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Memory & learning
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            When on, OpenMacaw schedules a daily learning agent review for this
            workspace. The learning agent samples a recent transcript and can
            create draft skills, save durable facts, or hand bugs to the
            planning agent.
          </p>
        </div>

        <Checkbox
          checked={learningEnabled}
          disabled={isSaving}
          onChange={(event) => void handleLearningToggle(event.target.checked)}
          label={
            learningEnabled
              ? "Daily learning agent review enabled"
              : "Daily learning agent review disabled"
          }
          description="Existing memories and approved skills remain available when this schedule is off."
        />

        {settings.updatedAt && (
          <p className="text-xs text-slate-500">
            Last updated{" "}
            {new Date(settings.updatedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            {settings.updatedByUserId ? "." : "."}
          </p>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Work tracker</h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose where planner work items are created for this workspace.
          </p>
        </div>

        <Alert tone="info" compact>
          Changes take effect within ~30 seconds.
        </Alert>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr]">
          <Select
            label="Tracker"
            value={trackerKind}
            onChange={(event) =>
              handleTrackerKindChange(event.target.value as TrackerKind)
            }
            options={TRACKER_KINDS.map((kind) => ({
              value: kind,
              label: `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`,
            }))}
            disabled={isSaving}
          />

          <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
            <p className="text-sm font-medium text-slate-200">
              {TRACKER_KIND_DESCRIPTIONS[trackerKind]}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {trackerKind === "database"
                ? "Recommended for the canonical platform work queue."
                : trackerKind === "memory"
                  ? "Useful for local development; state is not durable."
                  : trackerKind === "api"
                    ? "Sends work item events to an external tracker endpoint."
                    : `Requires a saved ${trackerKind} workspace credential.`}
            </p>
          </div>
        </div>

        {trackerRequiresCredential && (
          <div className="space-y-3">
            <Select
              label={`${trackerKind === "github" ? "GitHub" : "Linear"} credential`}
              value={
                selectedTrackerCredentialAvailable ? trackerCredentialId : ""
              }
              onChange={(event) => {
                setTrackerCredentialId(event.target.value);
                setTrackerError(null);
                setTrackerSuccess(false);
              }}
              options={trackerCredentialOptions}
              disabled={isSaving || credentialsQuery.isLoading}
              error={
                !trackerCredentialId
                  ? `${trackerKind === "github" ? "GitHub" : "Linear"} requires a workspace credential.`
                  : undefined
              }
            />

            {credentialsQuery.isLoading && (
              <p className="text-xs text-slate-500">
                Loading workspace credentials...
              </p>
            )}

            {credentialsQuery.isError && (
              <Alert tone="error" compact>
                Could not load workspace credentials.{" "}
                {credentialsQuery.error instanceof Error
                  ? credentialsQuery.error.message
                  : ""}
              </Alert>
            )}

            {trackerCredentials.length === 0 && !credentialsQuery.isLoading && (
              <Alert
                tone="warning"
                compact
                actions={
                  <ButtonLink
                    to="/settings/models"
                    size="sm"
                    variant="secondary"
                  >
                    Credentials settings
                  </ButtonLink>
                }
              >
                No {trackerKind === "github" ? "GitHub" : "Linear"} credentials
                are available in this workspace yet.
              </Alert>
            )}

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setAddingTrackerCredential((value) => !value)}
            >
              {addingTrackerCredential ? "Cancel" : "Add credential"}
            </Button>

            {addingTrackerCredential && trackerProvider && (
              <div className="rounded-md border border-border bg-surface-raised p-3">
                <CredentialEditor
                  workspaceId={workspaceId}
                  initialProvider={trackerProvider}
                  providerOptions={[trackerProvider]}
                  enabledFormats={["api_key"]}
                  submitLabel="Save credential"
                  successMessage="Credential saved."
                  onApiKeyCredential={async (credential) => {
                    if (!workspaceId) return;
                    const response =
                      await credentialMutations.saveStored.mutateAsync({
                        scope: { kind: "workspace", workspaceId },
                        provider: credential.provider,
                        apiKey: credential.secret,
                      });
                    setTrackerCredentialId(
                      credentialRowId(response.credential),
                    );
                    setAddingTrackerCredential(false);
                    await credentialsQuery.refetch();
                  }}
                />
              </div>
            )}
          </div>
        )}

        {!selectedTrackerCredentialAvailable && (
          <Alert tone="warning" compact>
            The saved tracker credential is no longer available. Choose a
            matching credential before saving.
          </Alert>
        )}

        {trackerError && <Alert tone="error">{trackerError}</Alert>}
        {trackerSuccess && (
          <Alert tone="success" compact>
            Work tracker settings saved.
          </Alert>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            loading={isSaving}
            disabled={!canSaveTracker}
            onClick={() => void handleTrackerSave()}
          >
            Save tracker
          </Button>
        </div>
      </Card>
    </div>
  );
}
