import { getLocalModelCodingSmoke } from "../../api/local-model-coding-smoke";
import { useAsyncTask } from "../../hooks/useAsyncTask";
import type { LocalModelCodingSmokeResponse } from "../../../../../contracts/local-model-coding-smoke";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../ui/KeyValueGrid";
import { SurfaceList, SurfaceListItem } from "../ui/SurfaceList";

function statusVariant(
  status: string,
): "default" | "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "warning";
  return "default";
}

export function LocalModelCodingSmokePanel() {
  const smokeTask = useAsyncTask<LocalModelCodingSmokeResponse>(
    getLocalModelCodingSmoke,
  );
  const smoke = smokeTask.data;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-300">
            Local Model Coding Smoke
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Fixture path for local_model_coding dispatch, shell and patch tool
            calls, workspace mutation, and UI event evidence.
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-200">
                {smoke.profile.model}
              </div>
              <Badge>{smoke.profile.runnerKind}</Badge>
            </div>
            <KeyValueGrid className="gap-1 text-xs text-slate-400">
              <KeyValuePair
                valueClassName="font-mono text-slate-300"
                label="Provider"
              >
                {smoke.profile.provider}
              </KeyValuePair>
              <KeyValuePair
                valueClassName="font-mono text-slate-300"
                label="Approval"
              >
                {smoke.profile.workspacePolicy.approvalPolicy}
              </KeyValuePair>
              <KeyValuePair
                valueClassName="font-mono text-slate-300"
                label="Sandbox"
              >
                {smoke.profile.workspacePolicy.sandbox}
              </KeyValuePair>
            </KeyValueGrid>
          </SurfaceListItem>

          <SurfaceList>
            {smoke.toolCalls.map((call) => (
              <SurfaceListItem key={call.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-200">
                    {call.toolSlug}
                  </span>
                  <Badge variant={statusVariant(call.status)}>
                    {call.status}
                  </Badge>
                  {call.commandActions.map((action) => (
                    <Badge key={action} variant="default">
                      {action}
                    </Badge>
                  ))}
                </div>
                <pre className="mt-2 overflow-auto rounded bg-slate-950/80 p-2 text-xs text-slate-300">
                  {JSON.stringify(call.result, null, 2)}
                </pre>
              </SurfaceListItem>
            ))}
          </SurfaceList>

          <SurfaceListItem>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-200">
                {smoke.workspaceMutation.changedFile}
              </span>
              <Badge variant={smoke.liveProviderCalls ? "warning" : "success"}>
                {smoke.liveProviderCalls ? "live" : "fixture"}
              </Badge>
            </div>
            <pre className="overflow-auto rounded bg-slate-950/80 p-2 text-xs text-slate-300">
              {smoke.workspaceMutation.diff}
            </pre>
          </SurfaceListItem>

          <SurfaceListItem>
            <div className="mb-2 text-xs font-medium text-slate-400">
              Events
            </div>
            <div className="space-y-1 text-xs text-slate-300">
              {smoke.events.map((event) => (
                <div key={event.phase} className="flex gap-2">
                  <span className="font-mono text-slate-500">
                    {event.source}
                  </span>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          </SurfaceListItem>
        </div>
      )}
    </Card>
  );
}
