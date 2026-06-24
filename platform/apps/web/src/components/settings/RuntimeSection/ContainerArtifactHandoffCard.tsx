import { getContainerArtifactHandoffSmoke } from "../../../api/container-artifact-handoff-smoke";
import { useAsyncTask } from "../../../hooks/useAsyncTask";
import type { AwsResourceAccessSmokeResponse } from "../../../../../../contracts/aws-resource-access-smoke";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../../ui/KeyValueGrid";
import { SurfaceListItem } from "../../ui/SurfaceList";

function stepVariant(
  status: string,
): "default" | "success" | "warning" | "error" {
  if (status === "passed") return "success";
  if (status === "failed") return "error";
  if (status === "not_run") return "warning";
  return "default";
}

function commandVariant(
  status: string,
): "default" | "success" | "warning" | "error" {
  return status === "completed" ? "success" : "error";
}

export function ContainerArtifactHandoffCard() {
  const smokeTask = useAsyncTask<AwsResourceAccessSmokeResponse>(
    getContainerArtifactHandoffSmoke,
  );
  const smoke = smokeTask.data;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-300">
            Container Artifact Handoff
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Fixture for container run artifacts, command summaries, changed
            files, and review handoff metadata.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={smokeTask.loading}
          onClick={() => void smokeTask.run()}
        >
          Load fixture
        </Button>
      </div>

      {smokeTask.error && (
        <p className="mt-3 text-xs text-red-400">{smokeTask.error}</p>
      )}

      {smoke && (
        <div className="mt-4 space-y-3">
          <SurfaceListItem>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-200">
                {smoke.runId}
              </span>
              <Badge variant={smoke.liveAwsCalls ? "warning" : "success"}>
                {smoke.liveAwsCalls ? "live" : "fixture"}
              </Badge>
            </div>
            <KeyValueGrid className="gap-1 text-xs text-slate-400">
              <KeyValuePair
                valueClassName="break-all font-mono text-slate-300"
                label="Artifact prefix"
              >
                {smoke.artifactPrefix}
              </KeyValuePair>
              <KeyValuePair
                valueClassName="font-mono text-slate-300"
                label="Review mode"
              >
                {smoke.reviewHandoff.mode}
              </KeyValuePair>
              <KeyValuePair
                valueClassName="break-all font-mono text-slate-300"
                label="Patch"
              >
                {smoke.reviewHandoff.patchArtifactUri}
              </KeyValuePair>
              <KeyValuePair
                valueClassName="font-mono text-slate-300"
                label="Branch"
              >
                {smoke.reviewHandoff.branchName ?? "N/A"}
              </KeyValuePair>
            </KeyValueGrid>
          </SurfaceListItem>

          <div className="grid gap-3 lg:grid-cols-2">
            <SurfaceListItem>
              <div className="mb-2 text-xs font-medium text-slate-400">
                Commands Run
              </div>
              <div className="space-y-2">
                {smoke.commandSummary.map((command) => (
                  <div
                    key={command.command}
                    className="rounded border border-slate-800 bg-slate-950/40 p-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-200">
                        {command.command}
                      </span>
                      <Badge variant={commandVariant(command.status)}>
                        {command.status}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {command.durationMs} ms
                      </span>
                    </div>
                    {command.artifactUri && (
                      <div className="mt-1 break-all font-mono text-xs text-slate-500">
                        {command.artifactUri}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SurfaceListItem>

            <SurfaceListItem>
              <div className="mb-2 text-xs font-medium text-slate-400">
                Files Changed
              </div>
              <div className="space-y-2">
                {smoke.filesChanged.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center justify-between gap-3 rounded border border-slate-800 bg-slate-950/40 p-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-slate-200">
                        {file.path}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        +{file.additions} -{file.deletions}
                      </div>
                    </div>
                    <Badge>{file.status}</Badge>
                  </div>
                ))}
              </div>
            </SurfaceListItem>
          </div>

          <SurfaceListItem>
            <div className="mb-2 text-xs font-medium text-slate-400">
              Artifacts
            </div>
            <div className="grid gap-2 lg:grid-cols-3">
              {smoke.artifacts.map((artifact) => (
                <div
                  key={artifact.uri}
                  className="rounded border border-slate-800 bg-slate-950/40 p-2"
                >
                  <Badge>{artifact.kind}</Badge>
                  <div className="mt-2 break-all font-mono text-xs text-slate-300">
                    {artifact.uri}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {artifact.contentType ?? "application/octet-stream"}
                    {artifact.sizeBytes !== undefined
                      ? `, ${artifact.sizeBytes} bytes`
                      : ""}
                  </div>
                </div>
              ))}
            </div>
          </SurfaceListItem>

          <SurfaceListItem>
            <div className="mb-2 text-xs font-medium text-slate-400">
              Smoke Steps
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {smoke.smokeSteps.map((step) => (
                <div
                  key={step.name}
                  className="rounded border border-slate-800 bg-slate-950/40 p-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-slate-300">
                      {step.name}
                    </span>
                    <Badge variant={stepVariant(step.status)}>
                      {step.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{step.evidence}</p>
                </div>
              ))}
            </div>
          </SurfaceListItem>

          {smoke.failures.length > 0 && (
            <SurfaceListItem>
              <div className="mb-2 text-xs font-medium text-slate-400">
                Failure Diagnostics
              </div>
              <div className="space-y-2">
                {smoke.failures.map((failure) => (
                  <div
                    key={`${failure.phase}:${failure.code}`}
                    className="rounded border border-red-900/60 bg-red-950/20 p-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="error">{failure.phase}</Badge>
                      <span className="font-mono text-xs text-red-200">
                        {failure.code}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-red-100">
                      {failure.message}
                    </p>
                    {failure.artifactUri && (
                      <div className="mt-1 break-all font-mono text-xs text-red-200/70">
                        {failure.artifactUri}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SurfaceListItem>
          )}
        </div>
      )}
    </Card>
  );
}
