import { useGatewayContext } from "../context/GatewayContext";
import { formatProviderLabel } from "../lib/provider-labels";
import { formatStatusLabel } from "../lib/status-labels";
import { DiagnosticsExportButton } from "./DiagnosticsExportButton";
import { Badge } from "./ui/Badge";

function badgeVariant(
  status: string,
): "default" | "success" | "warning" | "error" {
  if (status === "connected") return "success";
  if (status === "error" || status === "scope_missing") return "error";
  if (status === "connecting" || status === "resolving_scope") return "warning";
  return "default";
}

type Props = {
  realtimeError?: string | null;
};

export function GatewayDebugPanel({ realtimeError = null }: Props) {
  const { connected, status, diagnostics, gatewayReady, hello, scope, target } =
    useGatewayContext();
  const targetModel = target?.model ?? "Unconfigured";
  const targetProvider = formatProviderLabel(target?.provider, {
    fallback: "Unknown",
  });

  return (
    <div className="border-b border-slate-800 bg-slate-950/70 px-4 py-3 text-xs text-slate-300">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase tracking-[0.22em] text-slate-500">
          Gateway
        </span>
        <DiagnosticsExportButton label="Copy JSON" />
        <Badge variant={badgeVariant(status)}>
          {formatStatusLabel(status)}
        </Badge>
        <span>Socket: {connected ? "Open" : "Closed"}</span>
        <span>
          Launcher:{" "}
          {gatewayReady === null
            ? "Unknown"
            : gatewayReady
              ? "Reachable"
              : "Down"}
        </span>
        <span>
          Agent: {scope?.agentId ? `${scope.agentId.slice(0, 8)}...` : "None"}
        </span>
        <span>Model: {targetModel}</span>
        <span>Provider: {targetProvider}</span>
        <span>Session: {scope?.sessionKey ?? "None"}</span>
        <span>Protocol: {hello?.protocol ?? "N/A"}</span>
        <span>Conn: {hello?.server?.connId ?? "N/A"}</span>
        <span>Attempts: {diagnostics.connectAttempts}</span>
        <span>
          Last open:{" "}
          {diagnostics.lastOpenAt
            ? new Date(diagnostics.lastOpenAt).toLocaleTimeString()
            : "N/A"}
        </span>
        <span>
          Last connect send:{" "}
          {diagnostics.lastConnectSentAt
            ? new Date(diagnostics.lastConnectSentAt).toLocaleTimeString()
            : "N/A"}
        </span>
        <span>
          Last hello:{" "}
          {diagnostics.lastHelloAt
            ? new Date(diagnostics.lastHelloAt).toLocaleTimeString()
            : "N/A"}
        </span>
        <span>
          Last frame: {diagnostics.lastFrameType ?? "N/A"}{" "}
          {diagnostics.lastFrameAt
            ? `@ ${new Date(diagnostics.lastFrameAt).toLocaleTimeString()}`
            : ""}
        </span>
        <span>
          Last close: {diagnostics.lastCloseCode ?? "N/A"}{" "}
          {diagnostics.lastCloseReason ?? ""}
        </span>
      </div>
      {realtimeError && (
        <div className="mt-2 rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1 text-amber-200">
          Realtime disabled: {realtimeError}
        </div>
      )}
    </div>
  );
}
