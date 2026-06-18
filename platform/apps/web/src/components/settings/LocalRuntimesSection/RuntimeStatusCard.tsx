import type { LocalRuntime } from "../../../api/local-runtime";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { statusToneClass, type StatusTone } from "../../ui/status-tones";
import { formatCapability, formatLastSeen } from "./utils";

function runtimeStatus(runtime: LocalRuntime) {
  if (runtime.status === "online") {
    return {
      label: "Online" as const,
      variant: "success" as const,
      dotClassName: "bg-green-400",
    };
  }
  if (runtime.status === "degraded") {
    return {
      label: "Degraded" as const,
      variant: "warning" as const,
      dotClassName: "bg-yellow-400",
    };
  }
  return {
    label: "Offline" as const,
    variant: "error" as const,
    dotClassName: "bg-red-400",
  };
}

function diagnosticTone(severity: "info" | "warning" | "error"): StatusTone {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

export function RuntimeStatusCard({
  runtime,
  heartbeatIntervalMs,
}: {
  runtime: LocalRuntime;
  heartbeatIntervalMs: number;
}) {
  const status = runtimeStatus(runtime);
  const advertisedKinds = runtime.localExecution.advertisedRunnerKinds.length
    ? runtime.localExecution.advertisedRunnerKinds
    : runtime.runners.map((runner) => runner.kind);
  const advertisedModels = runtime.localExecution.advertisedModels.length
    ? runtime.localExecution.advertisedModels
    : runtime.runners
        .map((runner) => runner.model)
        .filter((model) => model.length > 0);
  const primaryDiagnostic = runtime.localExecution.diagnostics?.[0] ?? null;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${status.dotClassName}`}
              title={`Last heartbeat: ${formatLastSeen(runtime.localExecution.lastSeenAt)}`}
            />
            <h3 className="text-sm font-semibold text-slate-200">
              {runtime.machineDisplayName}
            </h3>
            <Badge variant={status.variant}>{status.label}</Badge>
            {runtime.runners.map((runner) => (
              <Badge key={runner.id}>{runner.provider}</Badge>
            ))}
          </div>
          <div className="mt-2 space-y-1">
            {runtime.runners.map((runner) => (
              <div
                key={runner.id}
                className="break-all font-mono text-xs text-slate-500"
              >
                <span className="mr-2 font-semibold text-slate-400">
                  {runner.kind}
                </span>
                {runner.endpoint}
                {runner.model ? ` — ${runner.model}` : ""}
                {runner.kind === "openai_compatible" && (
                  <span className="ml-2 text-slate-500">
                    [{formatCapability(runner.toolCallCapability)}]
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500">
          Heartbeat timeout: {Math.round((heartbeatIntervalMs * 2) / 1000)}s
        </div>
      </div>

      {primaryDiagnostic && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${statusToneClass(
            diagnosticTone(primaryDiagnostic.severity),
            "panel",
          )}`}
        >
          <div className="font-medium">{primaryDiagnostic.title}</div>
          <div className="mt-1 leading-5 opacity-90">
            {primaryDiagnostic.message}
          </div>
        </div>
      )}

      {(runtime.lastError || runtime.localExecution.lastError) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {runtime.lastError ?? runtime.localExecution.lastError}
        </div>
      )}

      <div className="grid gap-3 text-xs md:grid-cols-2">
        <div className="rounded-md border border-white/5 bg-surface px-3 py-2">
          <div className="text-slate-500">Helper version</div>
          <div className="mt-0.5 text-slate-300">
            {runtime.localExecution.helperVersion ?? "Not reported"}
          </div>
        </div>
        <div className="rounded-md border border-white/5 bg-surface px-3 py-2">
          <div className="text-slate-500">Last heartbeat</div>
          <div className="mt-0.5 text-slate-300">
            {formatLastSeen(runtime.localExecution.lastSeenAt)}
          </div>
        </div>
        <div className="rounded-md border border-white/5 bg-surface px-3 py-2">
          <div className="text-slate-500">Advertised runner kinds</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {advertisedKinds.map((kind) => (
              <Badge key={kind} variant="success">
                {kind}
              </Badge>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-white/5 bg-surface px-3 py-2">
          <div className="text-slate-500">Advertised models</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {advertisedModels.length === 0 ? (
              <span className="text-slate-500">None advertised</span>
            ) : (
              advertisedModels.map((modelName) => (
                <Badge key={modelName}>{modelName}</Badge>
              ))
            )}
          </div>
        </div>
        <div className="rounded-md border border-white/5 bg-surface px-3 py-2 md:col-span-2">
          <div className="text-slate-500">Runtime managed tools</div>
          <div className="mt-0.5 text-slate-300">
            {runtime.localExecution.runtimeManagedTools === null
              ? "Not reported"
              : runtime.localExecution.runtimeManagedTools
                ? "Enabled"
                : "Disabled"}
          </div>
        </div>
      </div>
    </Card>
  );
}
