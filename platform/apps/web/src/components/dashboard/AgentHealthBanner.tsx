import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  type AgentDiagnosticFetchResult,
  useAgentDiagnostic,
} from "../../api/use-agent-diagnostic";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { StatusBanner } from "../ui/StatusBanner";

type AgentHealthBannerProps = {
  agentId: string;
  workspaceId: string | null;
  /**
   * Why the banner is being shown. Today the only trigger is a non-1000
   * websocket close ("ws_close_abnormal"). Kept as a discriminated string
   * so future surfaces (manual probe, runtime preflight) can reuse it.
   */
  reason: "ws_close_abnormal";
  /**
   * Optional close code from the gateway, surfaced to the user so they
   * can attach it to support tickets.
   */
  closeCode?: number | null;
  /**
   * Called when the user dismisses the banner. The parent decides
   * whether to clear its "show banner" state or keep it visible.
   */
  onDismiss?: () => void;
  /**
   * Called by the transient-close CTA to reconnect the dropped gateway
   * context immediately instead of waiting for the background reconnect timer.
   */
  onReconnect?: () => Promise<void> | void;
};

/**
 * Friendly description of each value the diagnostic endpoint may return
 * in `executionProfile.missing`. Keep keys in sync with
 * `resolveExecutionProfile` in apps/api.
 */
const MISSING_DESCRIPTIONS: Record<string, string> = {
  credential: "No credential attached to this agent's execution profile.",
  route:
    "No routing rule matches this agent — the gateway can't pick a runner or model.",
  runner: "Routing rule selected, but it has no runner kind configured.",
  model: "Routing rule selected, but no model is set on it.",
  provider: "Routing rule selected, but no provider is configured.",
};

function describeMissing(key: string): string {
  return MISSING_DESCRIPTIONS[key] ?? `Missing: ${key}`;
}

function diagnosticProfileResolved(result: AgentDiagnosticFetchResult) {
  return result.ok && (result.data?.executionProfile?.resolved ?? true);
}

export function AgentHealthBanner({
  agentId,
  workspaceId,
  reason,
  closeCode,
  onDismiss,
  onReconnect,
}: AgentHealthBannerProps) {
  const navigate = useNavigate();
  const [showRaw, setShowRaw] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useAgentDiagnostic(
    agentId,
    workspaceId,
  );

  async function handleRecheck(dismissOnSuccess = false) {
    if (isRechecking) return;
    setIsRechecking(true);
    setRecheckError(null);

    const reconnect = async () => {
      if (onReconnect) await onReconnect();
    };
    const results = await Promise.allSettled([refetch(), reconnect()]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const diagnosticResult = results[0];
    const diagnosticError =
      diagnosticResult.status === "fulfilled" && !diagnosticResult.value.ok
        ? diagnosticResult.value.error
        : null;

    if (rejected || diagnosticError) {
      const reason = diagnosticError ?? rejected?.reason;
      setRecheckError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } else if (
      dismissOnSuccess &&
      onReconnect &&
      diagnosticResult.status === "fulfilled" &&
      diagnosticProfileResolved(diagnosticResult.value)
    ) {
      onDismiss?.();
    }
    setIsRechecking(false);
  }

  if (isLoading && !data) {
    return (
      <StatusBanner
        tone="info"
        density="compact"
        contentClassName="block"
        className="mx-3 mt-2 mb-1 sm:mx-4"
        data-banner-reason={reason}
      >
        <LoadingState
          label="Checking agent health..."
          className="flex items-center"
        />
      </StatusBanner>
    );
  }

  if (error && !data) {
    return (
      <StatusBanner
        tone="error"
        density="compact"
        title="Agent connection dropped"
        contentClassName="block"
        className="mx-3 mt-2 mb-1 sm:mx-4"
        data-banner-reason={reason}
        actions={
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={isRechecking}
            onClick={() => void handleRecheck(false)}
          >
            Retry diagnostic
          </Button>
        }
      >
        <p className="mt-1 text-sm">
          The websocket closed
          {typeof closeCode === "number" ? ` (code ${closeCode})` : ""} and we
          couldn't reach the diagnostic endpoint to learn why.
        </p>
        <p className="mt-1 text-xs opacity-80">{error.message}</p>
        {recheckError && (
          <p className="mt-1 text-xs text-red-200">{recheckError}</p>
        )}
      </StatusBanner>
    );
  }

  if (!data) return null;

  const executionProfile = data.executionProfile;
  const resolved = executionProfile?.resolved ?? true;
  const missing = executionProfile?.missing ?? [];
  const missingCredential = missing.includes("credential");
  const missingRoutingRule = missing.includes("route");

  const primaryCta = missingCredential
    ? {
        label: "Add credential",
        onClick: () => navigate("/settings/models"),
      }
    : missingRoutingRule
      ? {
          label: "Configure routing",
          onClick: () => navigate(`/settings/agents/${agentId}`),
        }
      : {
          label: "Open agent settings",
          onClick: () => navigate(`/settings/agents/${agentId}`),
        };

  const renderRawToggle = (
    <button
      type="button"
      onClick={() => setShowRaw((value) => !value)}
      className="text-xs font-medium underline decoration-dotted underline-offset-2 hover:opacity-80"
    >
      {showRaw ? "Hide full diagnostic" : "View full diagnostic"}
    </button>
  );

  const renderRawBlock = showRaw ? (
    <pre className="mt-3 max-h-72 overflow-auto rounded-md border border-slate-700/60 bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-200">
      {JSON.stringify(data, null, 2)}
    </pre>
  ) : null;

  if (!resolved) {
    return (
      <StatusBanner
        tone="error"
        density="compact"
        contentClassName="block"
        className="mx-3 mt-2 mb-1 sm:mx-4"
        data-banner-reason={reason}
        title="This agent can't run — its execution profile is incomplete."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={primaryCta.onClick}>
              {primaryCta.label}
            </Button>
            {onDismiss && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={onDismiss}
              >
                Dismiss
              </Button>
            )}
          </div>
        }
      >
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {missing.length === 0 ? (
            <li>The diagnostic endpoint did not list any missing pieces.</li>
          ) : (
            missing.map((key) => <li key={key}>{describeMissing(key)}</li>)
          )}
        </ul>
        {typeof closeCode === "number" && (
          <p className="mt-2 text-xs opacity-80">
            Gateway close code: {closeCode}.
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          {renderRawToggle}
          <button
            type="button"
            onClick={() => void handleRecheck(false)}
            disabled={isRechecking}
            className="text-xs font-medium underline decoration-dotted underline-offset-2 hover:opacity-80"
          >
            {isRechecking ? "Re-running diagnostic..." : "Re-run diagnostic"}
          </button>
        </div>
        {recheckError && (
          <p className="mt-2 text-xs text-red-200">{recheckError}</p>
        )}
        {renderRawBlock}
      </StatusBanner>
    );
  }

  // Profile is healthy — the close is likely transient (network blip,
  // gateway restart, server-side scope rotation). Surface that explicitly
  // so the user does not chase a config issue that doesn't exist.
  return (
    <StatusBanner
      tone="warning"
      density="compact"
      contentClassName="block"
      className="mx-3 mt-2 mb-1 sm:mx-4"
      data-banner-reason={reason}
      title="Connection dropped unexpectedly."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={isRechecking}
            onClick={() => void handleRecheck(true)}
          >
            Re-check
          </Button>
          {onDismiss && (
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      }
    >
      <p className="mt-1 text-sm">
        Profile is healthy — this is likely a transient network or gateway
        issue.
        {typeof closeCode === "number" && (
          <span className="ml-1 opacity-80">
            (gateway close code {closeCode})
          </span>
        )}
      </p>
      <div className="mt-3">{renderRawToggle}</div>
      {recheckError && (
        <p className="mt-2 text-xs text-red-200">{recheckError}</p>
      )}
      {renderRawBlock}
    </StatusBanner>
  );
}
