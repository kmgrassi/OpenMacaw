import type { WorkspaceAgentDiagnosticResponse } from "../../../../../contracts/agent-health";
import { useWorkspaceAgentDiagnosticsQuery } from "../../api/queries/runtime-diagnostics";
import { Badge } from "../ui/Badge";
import { LoadingState } from "../ui/LoadingState";

type WorkspaceAgentDiagnostic = Extract<
  WorkspaceAgentDiagnosticResponse,
  { ok: true }
>["agents"][number];

type WorkspaceAgentDiagnosticsPanelProps = {
  workspaceId: string | null | undefined;
};

const ERROR_EXPLANATIONS: Record<string, string> = {
  "runner_spawn_failed.bash_port_dead.codex":
    "Coding Agent can't start because the codex CLI is missing in the container. Contact ops.",
};

function explainError(agent: WorkspaceAgentDiagnostic): string {
  if (!agent.errorCode) return "Runtime reported an agent startup failure.";
  return (
    ERROR_EXPLANATIONS[agent.errorCode] ??
    "Runtime reported an unmapped agent startup failure."
  );
}

function formatErrorDetails(details: unknown): string {
  if (typeof details === "string") return details;
  if (details == null) return "";
  try {
    return JSON.stringify(details);
  } catch {
    return "Additional diagnostic details are unavailable.";
  }
}

function statusVariant(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "success";
  if (status === "error") return "error";
  return "warning";
}

function statusIcon(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "✓";
  if (status === "error") return "×";
  return "…";
}

function statusLabel(status: WorkspaceAgentDiagnostic["status"]) {
  if (status === "ok") return "Healthy";
  if (status === "error") return "Needs attention";
  return "Pending";
}

export function WorkspaceAgentDiagnosticsPanel({
  workspaceId,
}: WorkspaceAgentDiagnosticsPanelProps) {
  const diagnosticsQuery = useWorkspaceAgentDiagnosticsQuery({ workspaceId });

  if (!workspaceId) return null;

  const diagnostics = diagnosticsQuery.data;

  if (diagnosticsQuery.isLoading && !diagnostics) {
    return (
      <section className="rounded-md border border-slate-800 bg-slate-900/45 px-4 py-3 text-sm">
        <LoadingState label="Checking workspace agents..." />
      </section>
    );
  }

  if (diagnostics?.ok === false) {
    return (
      <section className="rounded-md border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-amber-100">
              Workspace agent diagnostics
            </h2>
            <p className="mt-1 text-amber-200/85">{diagnostics.details}</p>
          </div>
          <Badge variant="warning">{diagnostics.reason}</Badge>
        </div>
      </section>
    );
  }

  if (diagnosticsQuery.error && !diagnostics) {
    return (
      <section className="rounded-md border border-red-900/50 bg-red-950/20 px-4 py-3 text-sm">
        <h2 className="text-sm font-semibold text-red-200">
          Workspace agent diagnostics
        </h2>
        <p className="mt-1 text-red-300">
          {(diagnosticsQuery.error as Error).message}
        </p>
      </section>
    );
  }

  if (!diagnostics?.ok) return null;

  return (
    <section className="rounded-md border border-slate-800 bg-slate-900/45 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Workspace agent diagnostics
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Per-agent runtime status, error codes, and raw diagnostic details.
          </p>
        </div>
        <Badge>
          {diagnostics.agents.length} agent
          {diagnostics.agents.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="mt-3 divide-y divide-slate-800/70 overflow-hidden rounded-md border border-slate-800/70">
        {diagnostics.agents.length === 0 ? (
          <div className="bg-slate-950/25 px-3 py-3 text-sm text-slate-400">
            No agents reported for this workspace.
          </div>
        ) : (
          diagnostics.agents.map((agent) => (
            <div
              key={agent.agentId}
              className="flex flex-col gap-2 bg-slate-950/25 px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={
                      agent.status === "ok"
                        ? "text-emerald-400"
                        : agent.status === "error"
                          ? "text-red-400"
                          : "text-amber-400"
                    }
                  >
                    {statusIcon(agent.status)}
                  </span>
                  <span className="truncate text-sm font-medium text-slate-100">
                    {agent.agentId}
                  </span>
                  <Badge>{agent.runnerKind}</Badge>
                </div>
                {agent.status === "error" && (
                  <p className="mt-1 text-sm text-red-300">
                    {agent.errorCode ? `${agent.errorCode}: ` : ""}
                    {explainError(agent)}
                  </p>
                )}
                {agent.errorDetails !== undefined && (
                  <p className="mt-1 break-words font-mono text-xs text-slate-400">
                    {formatErrorDetails(agent.errorDetails)}
                  </p>
                )}
              </div>
              <Badge variant={statusVariant(agent.status)}>
                {statusLabel(agent.status)}
              </Badge>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
