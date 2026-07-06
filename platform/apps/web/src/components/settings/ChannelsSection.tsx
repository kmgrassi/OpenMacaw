import { useState } from "react";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
} from "../../api/ws-types";
import { useGatewayContext } from "../../context/GatewayContext";
import { useLoadOnConnect } from "../../hooks/useLoadOnConnect";
import { Alert } from "../ui/Alert";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { LoadingState } from "../ui/LoadingState";

export function ChannelsSection() {
  const { request, connected } = useGatewayContext();
  const [snapshot, setSnapshot] = useState<ChannelsStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WhatsApp login flow
  const [waQr, setWaQr] = useState<string | null>(null);
  const [waMsg, setWaMsg] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);

  const loadChannels = async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await request("channels.status", {
        probe: true,
        timeoutMs: 8000,
      });
      setSnapshot(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useLoadOnConnect(connected, loadChannels);

  const startWhatsAppLogin = async () => {
    setWaBusy(true);
    try {
      const res = await request("web.login.start", {
        force: false,
        timeoutMs: 30000,
      });
      setWaMsg(res.message ?? null);
      setWaQr(res.qrDataUrl ?? null);
      // Wait for scan
      const wait = await request("web.login.wait", { timeoutMs: 120000 });
      setWaMsg(wait.message ?? null);
      if (wait.connected) {
        setWaQr(null);
        await loadChannels();
      }
    } catch (err) {
      setWaMsg(String(err));
    } finally {
      setWaBusy(false);
    }
  };

  const statusBadge = (acct: ChannelAccountSnapshot) => {
    if (acct.connected) return <Badge variant="success">connected</Badge>;
    if (acct.running) return <Badge variant="warning">running</Badge>;
    if (acct.configured) return <Badge>configured</Badge>;
    return <Badge variant="error">not configured</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-200">Channels</h2>
          <p className="mt-1 text-sm text-slate-400">
            Connected messaging platforms and their status.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={loadChannels}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      {!connected && <LoadingState label="Connecting to gateway..." />}

      {error && <Alert tone="error">{error}</Alert>}

      {snapshot && (
        <div className="space-y-3">
          {snapshot.channelOrder.map((channelId) => {
            const label = snapshot.channelLabels[channelId] ?? channelId;
            const accounts = snapshot.channelAccounts[channelId] ?? [];
            const isWhatsApp = channelId === "whatsapp";

            return (
              <Card key={channelId}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-slate-200">
                    {label}
                  </h3>
                  {isWhatsApp && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={startWhatsAppLogin}
                      loading={waBusy}
                    >
                      {waBusy ? "Linking..." : "Link WhatsApp"}
                    </Button>
                  )}
                </div>

                {accounts.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No accounts configured.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {accounts.map((acct) => (
                      <div
                        key={acct.accountId}
                        className="flex items-center justify-between rounded-md bg-surface px-2.5 py-1.5"
                      >
                        <span className="text-xs text-slate-300">
                          {acct.name || acct.accountId}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {statusBadge(acct)}
                          {acct.lastError && (
                            <span
                              className="text-[10px] text-red-400 truncate max-w-[200px]"
                              title={acct.lastError}
                            >
                              {acct.lastError}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* WhatsApp QR */}
                {isWhatsApp && waQr && (
                  <div className="mt-3 flex flex-col items-center">
                    <img
                      src={waQr}
                      alt="WhatsApp QR"
                      className="w-48 h-48 rounded-md"
                    />
                    <p className="mt-2 text-xs text-slate-400">
                      Scan with WhatsApp to link
                    </p>
                  </div>
                )}
                {isWhatsApp && waMsg && !waQr && (
                  <p className="mt-2 text-xs text-slate-400">{waMsg}</p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {!loading && !snapshot && connected && (
        <Card>
          <EmptyState
            label="No channel data available."
            density="compact"
            align="left"
            className="border-0 bg-transparent px-0 py-0"
          />
        </Card>
      )}
    </div>
  );
}
