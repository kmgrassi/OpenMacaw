import { useMemo, useState } from "react";
import type { AgentDiagnosticResponse } from "../api/agent-diagnostic";
import {
  useAgentDiagnosticQuery,
  useAgentHealthQuery,
} from "../api/queries/runtime-diagnostics";
import type { AgentHealthResponse } from "../../../../contracts/agent-health";
import { useGatewayContext } from "../context/GatewayContext";
import { getCapturedBrowserConsoleErrors } from "../lib/browser-console-errors";
import {
  buildDiagnosticsExport,
  formatDiagnosticsExport,
  type DiagnosticsAuthSummary,
} from "../lib/diagnostics-export";
import { useAuthStore } from "../stores/auth";
import { copyTextToClipboard } from "../lib/clipboard";
import { Button } from "./ui/Button";

type Props = {
  agentHealth?: AgentHealthResponse | null;
  agentDiagnostic?: AgentDiagnosticResponse | null;
  label?: string;
};

export function DiagnosticsExportButton({
  agentHealth,
  agentDiagnostic,
  label = "Copy diagnostics JSON",
}: Props) {
  const gateway = useGatewayContext();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore((state) => state.userId);
  const authWorkspaceId = useAuthStore((state) => state.workspaceId);
  const authResolvedAgentId = useAuthStore((state) => state.resolvedAgentId);
  const authOnboarding = useAuthStore((state) => state.defaultAgentOnboarding);
  const authDefaultAgents = useAuthStore((state) => state.defaultAgents);
  const authManagerAgent = useAuthStore((state) => state.managerAgent);
  const authProviderWarnings = useAuthStore((state) => state.providerWarnings);
  const authAgents = useAuthStore((state) => state.existingAgents);
  const authWorkspaces = useAuthStore((state) => state.workspaces);
  const authSummary = useMemo<DiagnosticsAuthSummary>(
    () => ({
      status: authStatus,
      hasUser: Boolean(authUserId),
      workspaceId: authWorkspaceId,
      resolvedAgentId: authResolvedAgentId,
      onboarding: authOnboarding,
      defaultAgents: authDefaultAgents,
      managerAgent: authManagerAgent,
      providerWarnings: authProviderWarnings,
      agents: authAgents,
      workspaces: authWorkspaces,
    }),
    [
      authAgents,
      authDefaultAgents,
      authManagerAgent,
      authOnboarding,
      authProviderWarnings,
      authResolvedAgentId,
      authStatus,
      authUserId,
      authWorkspaceId,
      authWorkspaces,
    ],
  );

  const selectedWorkspaceId =
    gateway.scope?.workspaceId ??
    agentHealth?.workspaceId ??
    agentDiagnostic?.workspaceId ??
    authSummary.workspaceId;
  const selectedAgentId =
    gateway.scope?.agentId ??
    agentHealth?.agentId ??
    agentDiagnostic?.agentId ??
    authSummary.resolvedAgentId;
  const agentHealthQuery = useAgentHealthQuery({
    agentId: selectedAgentId,
    enabled: agentHealth === undefined,
  });
  const agentDiagnosticQuery = useAgentDiagnosticQuery({
    agentId: selectedAgentId,
    workspaceId: selectedWorkspaceId,
    enabled: agentDiagnostic === undefined,
  });
  const resolvedAgentHealth = agentHealth ?? agentHealthQuery.data ?? null;
  const resolvedAgentDiagnostic =
    agentDiagnostic ?? agentDiagnosticQuery.data ?? null;

  async function handleCopy() {
    setCopyError(null);
    try {
      const payload = buildDiagnosticsExport({
        capturedAt: new Date().toISOString(),
        currentUrl: window.location.href,
        selectedWorkspaceId,
        selectedAgentId,
        authState: authSummary,
        gateway: {
          connected: gateway.connected,
          status: gateway.status,
          gatewayReady: gateway.gatewayReady,
          scope: gateway.scope,
          target: gateway.target,
          hello: gateway.hello,
          diagnostics: gateway.diagnostics,
        },
        agentHealth: resolvedAgentHealth,
        agentDiagnostic: resolvedAgentDiagnostic,
        browserConsoleErrors: getCapturedBrowserConsoleErrors(),
      });
      await copyTextToClipboard(formatDiagnosticsExport(payload));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setCopyError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => void handleCopy()}>
        {copied ? "Copied JSON" : label}
      </Button>
      {copyError && <span className="text-xs text-red-400">{copyError}</span>}
    </div>
  );
}
