import { useEffect, useMemo, useState } from "react";
import {
  launchSavedCredential,
  listSavedCredentialsForAgent,
  type SavedCredential,
  type StoredCredentialActivationResponse,
} from "../../api/credentials";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { useAuthStore } from "../../stores/auth";
import {
  PlanReviewHandoff,
  type SelectedCodingHandoff,
} from "./PlanReviewHandoff";
import type { AgentType } from "../../../../../contracts/agents";

type Props = {
  agentId: string;
  agentName: string;
  provider: string | null;
  agentType: AgentType;
};

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function AgentWorkerLaunch({
  agentId,
  agentName,
  provider,
  agentType,
}: Props) {
  const { workspaceId } = useAuthStore();
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<SelectedCodingHandoff | null>(null);

  useEffect(() => {
    if (!agentId || !workspaceId) {
      setCredentials([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void listSavedCredentialsForAgent(agentId, workspaceId)
      .then((rows) => {
        if (!cancelled) setCredentials(rows);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, workspaceId]);

  const launchable = useMemo(
    () =>
      credentials.filter((credential) => credential.launchableKind === "codex"),
    [credentials],
  );

  async function handleLaunch(credential: SavedCredential) {
    setLaunchingId(credential.id);
    setError(null);
    setLaunchResult(null);

    try {
      if (!workspaceId) {
        throw new Error("workspaceId is required");
      }

      const response: StoredCredentialActivationResponse =
        await launchSavedCredential(
          agentId,
          credential.id,
          workspaceId,
          agentType === "coding" ? handoff : null,
        );
      if (!response.validation.ok) {
        setLaunchResult(
          `Credential validation failed for ${agentName}: ${response.validation.message}`,
        );
        return;
      }

      setLaunchResult(
        `Started worker session ${response.launch?.sessionId ?? "unknown"} for ${agentName}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLaunchingId(null);
    }
  }

  return (
    <Card>
      <h4 className="mb-3 text-sm font-medium text-slate-300">
        Saved Credentials
      </h4>
      <div className="space-y-3">
        {agentType === "coding" && (
          <PlanReviewHandoff
            workspaceId={workspaceId}
            value={handoff}
            onChange={setHandoff}
          />
        )}

        {loading && (
          <p className="text-xs text-slate-500">Loading saved credentials…</p>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {launchResult && (
          <p className="text-xs text-green-400">{launchResult}</p>
        )}

        {!loading && credentials.length === 0 && (
          <p className="text-xs text-slate-500">
            No saved credentials found for this agent
            {provider ? ` (${provider})` : ""}.
          </p>
        )}

        {credentials.map((credential) => {
          const launchableNow = credential.launchableKind === "codex";
          return (
            <div
              key={credential.id}
              className="rounded-md border border-border bg-surface px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-200">
                      {credential.label}
                    </span>
                    <Badge variant={launchableNow ? "success" : "warning"}>
                      {launchableNow ? "launchable" : "stored only"}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    env var:{" "}
                    <span className="font-mono">{credential.envVar}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    updated: {formatUpdatedAt(credential.updatedAt)}
                  </div>
                </div>

                <Button
                  size="sm"
                  disabled={!launchableNow}
                  loading={launchingId === credential.id}
                  onClick={() => void handleLaunch(credential)}
                >
                  Start worker
                </Button>
              </div>

              {!launchableNow && (
                <p className="mt-2 text-xs text-slate-500">
                  This stored credential is visible, but the worker launcher
                  currently starts Codex workers with OpenAI credentials only.
                </p>
              )}
            </div>
          );
        })}

        {!loading && launchable.length > 0 && (
          <p className="text-xs text-slate-500">
            Credentials are displayed without revealing secret values. Launch
            happens through the local API, which reads the stored secret and
            resolves the authorized worker workspace server-side.
          </p>
        )}
      </div>
    </Card>
  );
}
