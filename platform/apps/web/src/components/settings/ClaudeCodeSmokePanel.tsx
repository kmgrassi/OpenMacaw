import { getClaudeCodeSmoke } from "../../api/claude-code-smoke";
import { useAsyncTask } from "../../hooks/useAsyncTask";
import type { ClaudeCodeSmokeResponse } from "../../../../../contracts/claude-code-smoke";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { KeyValueGrid, KeyValuePair } from "../ui/KeyValueGrid";
import { SurfaceListItem } from "../ui/SurfaceList";

function RuntimeProfile({ smoke }: { smoke: ClaudeCodeSmokeResponse }) {
  const profile = smoke.dispatch.runtimeProfile;

  return (
    <SurfaceListItem>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-slate-200">
          Runtime dispatch
        </div>
        <Badge variant="success">{profile.runner_kind}</Badge>
      </div>
      <KeyValueGrid className="gap-1 text-xs text-slate-400">
        <KeyValuePair
          valueClassName="font-mono text-slate-300"
          label="Provider"
        >
          {profile.provider}
        </KeyValuePair>
        <KeyValuePair valueClassName="font-mono text-slate-300" label="Model">
          {profile.model}
        </KeyValuePair>
        <KeyValuePair
          valueClassName="font-mono text-slate-300"
          label="Credential"
        >
          {profile.credential_ref}
        </KeyValuePair>
        <KeyValuePair
          valueClassName="font-mono text-slate-300"
          label="Tool profile"
        >
          {profile.tool_profile}
        </KeyValuePair>
      </KeyValueGrid>
    </SurfaceListItem>
  );
}

export function ClaudeCodeSmokePanel() {
  const smokeTask = useAsyncTask<ClaudeCodeSmokeResponse>(getClaudeCodeSmoke);
  const smoke = smokeTask.data;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-300">
            Claude Code Dispatch Smoke
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Fixture path for planner-created work items routed to a Claude Code
            coding backend.
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
          <div className="grid gap-3 md:grid-cols-2">
            <SurfaceListItem>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-slate-200">
                  {smoke.workItem.title}
                </div>
                <Badge variant="success">{smoke.workItem.status}</Badge>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                <div>
                  Plan:{" "}
                  <span className="font-mono text-slate-300">
                    {smoke.plan.id}
                  </span>
                </div>
                <div>
                  Work item:{" "}
                  <span className="font-mono text-slate-300">
                    {smoke.workItem.id}
                  </span>
                </div>
                <div>
                  Agent:{" "}
                  <span className="font-mono text-slate-300">
                    {smoke.workItem.assignedAgentProfile}
                  </span>
                </div>
              </div>
            </SurfaceListItem>
            <RuntimeProfile smoke={smoke} />
          </div>

          <SurfaceListItem>
            <div className="mb-2 text-xs font-medium text-slate-400">
              Normalized Events
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {smoke.normalizedEvents.map((event) => (
                <SurfaceListItem
                  key={event.kind}
                  density="compact"
                  className="flex items-center justify-between gap-3 rounded text-xs"
                >
                  <span className="text-slate-300">{event.label}</span>
                  <Badge>{event.kind}</Badge>
                </SurfaceListItem>
              ))}
            </div>
          </SurfaceListItem>

          <SurfaceListItem>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-slate-400">
                Workspace Evidence
              </span>
              <Badge variant={smoke.liveProviderCalls ? "warning" : "success"}>
                {smoke.liveProviderCalls ? "live" : "fixture"}
              </Badge>
            </div>
            <p className="mb-2 text-xs text-slate-300">
              {smoke.workspaceEvidence.diffSummary}
            </p>
            <div className="space-y-1 font-mono text-xs text-slate-300">
              {smoke.workspaceEvidence.logLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </SurfaceListItem>
        </div>
      )}
    </Card>
  );
}
