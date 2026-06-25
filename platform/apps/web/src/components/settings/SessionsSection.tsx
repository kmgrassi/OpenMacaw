import { useState } from "react";
import {
  listOrchestratorSessions,
  type OrchestratorSessionsResult,
} from "../../api/orchestrator-sessions";
import { useGatewayContext } from "../../context/GatewayContext";
import { useLoadOnConnect } from "../../hooks/useLoadOnConnect";
import { Alert } from "../ui/Alert";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { LoadingState } from "../ui/LoadingState";
import { PageHeader } from "../ui/PageHeader";

export function SessionsSection() {
  const { request, connected } = useGatewayContext();
  const [result, setResult] = useState<OrchestratorSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await listOrchestratorSessions(request, 100));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useLoadOnConnect(connected, loadSessions);

  const handleDelete = async (key: string) => {
    if (
      !window.confirm(`Delete session "${key}"? This archives its transcript.`)
    )
      return;
    try {
      await request("sessions.delete", { key, deleteTranscript: true });
      await loadSessions();
    } catch (err) {
      setError(String(err));
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return "\u2014";
    const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleString();
  };

  const sessions = result?.sessions ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sessions"
        description={
          <>
            Active and recent chat sessions.
            {result ? ` ${result.count} total.` : ""}
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={loadSessions}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      {!connected && <LoadingState label="Connecting to gateway..." />}

      {error && <Alert tone="error">{error}</Alert>}

      {sessions.length === 0 && !loading && connected && (
        <Card>
          <EmptyState
            label="No sessions found."
            density="compact"
            align="left"
            className="border-0 bg-transparent px-0 py-0"
          />
        </Card>
      )}

      {sessions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left">
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Label
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Kind
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Surface
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Model
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Tokens
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Updated
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.key}
                  className="border-b border-border/50 hover:bg-surface-raised/50"
                >
                  <td className="px-3 py-2 text-slate-200 truncate max-w-[200px]">
                    {s.label || s.displayName || s.key}
                  </td>
                  <td className="px-3 py-2">
                    <Badge>{s.kind}</Badge>
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {s.surface || "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 font-mono">
                    {s.model || "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {s.totalTokens ? s.totalTokens.toLocaleString() : "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {formatTime(s.updatedAt)}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(s.key)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
