import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiClientError } from "../../api/client";
import {
  listGitHubAppInstallationCredentials,
  listGitHubAppPullRequests,
  saveGitHubAppInstallationCredential,
  type GitHubAppInstallationCredential,
  type GitHubAppPullRequestListResponse,
} from "../../api/resource-credentials";
import {
  useCredentialMutations,
  useWorkspaceCredentialsQuery,
} from "../../hooks/useServerStateQueries";
import { useAuthStore } from "../../stores/auth";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import { CredentialEditor } from "./CredentialEditor";

type ConnectionType = "api_key" | "github_app";

const CONNECTION_TYPE_OPTIONS: Array<{ value: ConnectionType; label: string }> =
  [
    { value: "api_key", label: "Model provider API key" },
    { value: "github_app", label: "GitHub App" },
  ];

function githubAppCredentialsKey(workspaceId: string) {
  return ["resource-credentials", "github-app", workspaceId] as const;
}

// Pull the server's `remediation` detail (e.g. "the App isn't installed —
// install it here") out of the structured error so the user sees the fix.
function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const remediation = (error.details as { remediation?: string } | undefined)
      ?.remediation;
    return remediation ? `${error.message} — ${remediation}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ConnectionsSection() {
  const { workspaceId } = useAuthStore();

  if (!workspaceId) {
    return (
      <PageHeader
        title="Connections"
        description="No active workspace. Pick one to manage its connections."
      />
    );
  }

  return <ConnectionsContent workspaceId={workspaceId} />;
}

function ConnectionsContent({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const apiKeyCredentialsQuery = useWorkspaceCredentialsQuery(workspaceId);
  const githubAppCredentialsQuery = useQuery({
    queryKey: githubAppCredentialsKey(workspaceId),
    queryFn: () => listGitHubAppInstallationCredentials(workspaceId),
    staleTime: 30_000,
  });

  const [connectionType, setConnectionType] =
    useState<ConnectionType>("api_key");

  const apiKeyCredentials = apiKeyCredentialsQuery.data ?? [];
  const githubAppCredentials = githubAppCredentialsQuery.data ?? [];
  const loading =
    apiKeyCredentialsQuery.isPending || githubAppCredentialsQuery.isPending;

  const refreshGitHubApps = () =>
    queryClient.invalidateQueries({
      queryKey: githubAppCredentialsKey(workspaceId),
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="One place to add and manage the credentials this workspace uses — model provider keys and GitHub App access."
      />

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Add a connection
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Pick a connection type, then enter its details.
          </p>
        </div>

        <Select
          label="Connection type"
          value={connectionType}
          onChange={(event) =>
            setConnectionType(event.target.value as ConnectionType)
          }
          options={CONNECTION_TYPE_OPTIONS}
        />

        {connectionType === "api_key" ? (
          <ApiKeyConnectionForm workspaceId={workspaceId} />
        ) : (
          <GitHubAppConnectionForm
            workspaceId={workspaceId}
            onSaved={refreshGitHubApps}
          />
        )}
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Your connections
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Credentials saved for this workspace.
          </p>
        </div>

        {loading ? (
          <LoadingState label="Loading connections..." variant="inline" />
        ) : apiKeyCredentials.length === 0 &&
          githubAppCredentials.length === 0 ? (
          <p className="text-sm text-slate-400">
            No connections yet. Add one above.
          </p>
        ) : (
          <div className="space-y-3">
            {apiKeyCredentials.map((credential) => (
              <div
                key={credential.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-surface-raised/40 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-100">
                    {credential.label}
                  </div>
                  <div className="text-xs text-slate-500">
                    {credential.provider ?? "provider"} · API key
                  </div>
                </div>
                <Badge value={credential.validationState} />
              </div>
            ))}
            {githubAppCredentials.map((credential) => (
              <GitHubAppCredentialRow
                key={credential.credentialId}
                workspaceId={workspaceId}
                credential={credential}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ApiKeyConnectionForm({ workspaceId }: { workspaceId: string }) {
  const credentialMutations = useCredentialMutations(null, workspaceId);
  return (
    <CredentialEditor
      workspaceId={workspaceId}
      enabledFormats={["api_key"]}
      submitLabel="Save connection"
      successMessage="Connection saved."
      onApiKeyCredential={async (credential) => {
        await credentialMutations.saveStored.mutateAsync({
          scope: { kind: "workspace", workspaceId },
          provider: credential.provider,
          apiKey: credential.secret,
        });
      }}
    />
  );
}

function GitHubAppConnectionForm({
  workspaceId,
  onSaved,
}: {
  workspaceId: string;
  onSaved: () => Promise<unknown> | void;
}) {
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canSubmit =
    appId.trim().length > 0 &&
    installationId.trim().length > 0 &&
    privateKey.trim().length > 0 &&
    !saving;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await saveGitHubAppInstallationCredential({
        workspaceId,
        appId: appId.trim(),
        installationId: installationId.trim(),
        privateKey: privateKey.trim(),
        displayName: displayName.trim() || undefined,
      });
      setAppId("");
      setInstallationId("");
      setPrivateKey("");
      setDisplayName("");
      setSuccess(true);
      await onSaved();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Input
          label="App ID"
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder="4133775"
        />
        <Input
          label="Installation ID"
          value={installationId}
          onChange={(event) => setInstallationId(event.target.value)}
          placeholder="142356030"
        />
      </div>
      <Input
        label="Name (optional)"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder="GitHub App"
      />
      <Textarea
        label="Private key (.pem)"
        className="font-mono text-xs"
        rows={6}
        value={privateKey}
        onChange={(event) => setPrivateKey(event.target.value)}
        placeholder={"-----BEGIN RSA PRIVATE KEY-----\n..."}
      />
      {error && <Alert tone="error">{error}</Alert>}
      {success && <p className="text-xs text-green-400">Connection saved.</p>}
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={!canSubmit}>
          Save connection
        </Button>
      </div>
    </form>
  );
}

function GitHubAppCredentialRow({
  workspaceId,
  credential,
}: {
  workspaceId: string;
  credential: GitHubAppInstallationCredential;
}) {
  const [repo, setRepo] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<GitHubAppPullRequestListResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    if (!repo.trim() || testing) return;
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      const response = await listGitHubAppPullRequests({
        credentialId: credential.credentialId,
        workspaceId,
        repo: repo.trim(),
      });
      setResult(response);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rounded-md border border-border/50 bg-surface-raised/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-slate-100">
            {credential.displayName}
          </div>
          <div className="text-xs text-slate-500">
            GitHub App · app {credential.appId} · installation{" "}
            {credential.installationId}
          </div>
        </div>
        <Badge variant="info">GitHub App</Badge>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <Input
          label="Test: list PRs for repo"
          className="font-mono"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/name"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={testing}
          disabled={!repo.trim() || testing}
          onClick={() => void handleTest()}
        >
          List PRs
        </Button>
      </div>

      {error && (
        <div className="mt-2">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {result && (
        <div className="mt-2 text-xs text-slate-300">
          <div className="text-slate-400">
            {result.pullRequests.length} open PR(s) in {result.repo}
          </div>
          <ul className="mt-1 space-y-0.5">
            {result.pullRequests.map((pr) => (
              <li key={pr.number} className="truncate">
                <span className="text-slate-500">#{pr.number}</span> {pr.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
