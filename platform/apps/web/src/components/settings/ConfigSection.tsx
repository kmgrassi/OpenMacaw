import { useEffect, useState, useCallback } from "react";
import type { ConfigSnapshot } from "../../api/ws-types";
import { useGatewayContext } from "../../context/GatewayContext";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { LoadingState } from "../ui/LoadingState";
import { PageHeader } from "../ui/PageHeader";
import { Textarea } from "../ui/Textarea";

export function ConfigSection() {
  const { request, connected } = useGatewayContext();
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [rawEdit, setRawEdit] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await request("config.get", {});
      if (res) {
        setSnapshot(res);
        setRawEdit(res.raw ?? JSON.stringify(res.config ?? {}, null, 2));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [connected, request]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await request("config.set", {
        raw: rawEdit,
        baseHash: snapshot?.hash ?? undefined,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      await loadConfig();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    rawEdit !==
    (snapshot?.raw ?? JSON.stringify(snapshot?.config ?? {}, null, 2));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Config"
        description="Advanced runtime configuration editor."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={loadConfig}
            loading={loading}
          >
            Reload
          </Button>
        }
      />

      {!connected && <LoadingState label="Connecting to gateway..." />}

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">Configuration saved.</Alert>}

      {/* Validation issues */}
      {snapshot?.issues && snapshot.issues.length > 0 && (
        <Alert tone="warning" title="Validation issues">
          <ul className="space-y-1">
            {snapshot.issues.map((issue, i) => (
              <li key={i} className="text-xs text-slate-400">
                <span className="font-mono text-yellow-400">{issue.path}</span>:{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {/* JSON editor */}
      {snapshot && (
        <div className="space-y-3">
          {(snapshot.source || snapshot.hash) && (
            <p className="text-xs text-slate-500 font-mono">
              {snapshot.source ?? `hash: ${snapshot.hash}`}
            </p>
          )}
          <Textarea
            value={rawEdit}
            onChange={(e) => setRawEdit(e.target.value)}
            spellCheck={false}
            wrapperClassName="space-y-0"
            className="h-96 resize-y font-mono"
          />
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRawEdit(
                    snapshot.raw ??
                      JSON.stringify(snapshot.config ?? {}, null, 2),
                  )
                }
              >
                Reset
              </Button>
            )}
            <Button
              size="sm"
              disabled={!dirty}
              loading={saving}
              onClick={handleSave}
            >
              Save config
            </Button>
          </div>
        </div>
      )}

      {!loading && !snapshot && connected && (
        <Card>
          <EmptyState
            label="No configuration loaded."
            density="compact"
            align="left"
            className="border-0 bg-transparent px-0 py-0"
          />
        </Card>
      )}
    </div>
  );
}
