import { getModelAgnosticSmoke } from "../../api/model-agnostic-smoke";
import { useAsyncTask } from "../../hooks/useAsyncTask";
import type { ModelAgnosticSmokeResponse } from "../../../../../contracts/model-agnostic-smoke";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

function ProfileBlock({
  title,
  profile,
}: {
  title: string;
  profile: ModelAgnosticSmokeResponse["profiles"]["planning"];
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-slate-200">{title}</div>
        <Badge>{profile.runnerKind}</Badge>
      </div>
      <dl className="grid gap-1 text-xs text-slate-400">
        <div className="flex justify-between gap-3">
          <dt>Provider</dt>
          <dd className="font-mono text-slate-300">{profile.provider}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Model</dt>
          <dd className="font-mono text-slate-300">{profile.model}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Adapter</dt>
          <dd className="font-mono text-slate-300">
            {profile.providerAdapter}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Credential</dt>
          <dd className="font-mono text-slate-300">
            {profile.credentialRef.value}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function ModelAgnosticSmokePanel() {
  const smokeTask = useAsyncTask<ModelAgnosticSmokeResponse>(
    getModelAgnosticSmoke,
  );
  const smoke = smokeTask.data;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-slate-300">
            Model-Agnostic Smoke
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Fixture path for planner-to-coder handoff with separate provider
            profiles.
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
            <ProfileBlock
              title="Planning Agent"
              profile={smoke.profiles.planning}
            />
            <ProfileBlock
              title="Coding Agent"
              profile={smoke.profiles.coding}
            />
          </div>

          <div className="rounded-md border border-border bg-surface px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-200">
                {smoke.planDraft.title}
              </span>
              <Badge variant={smoke.liveProviderCalls ? "warning" : "success"}>
                {smoke.liveProviderCalls ? "live" : "fixture"}
              </Badge>
            </div>
            <div className="mt-2 text-xs text-slate-400">
              Handoff:{" "}
              <span className="font-mono text-slate-300">
                {smoke.handoff.planId}
              </span>{" "}
              /{" "}
              <span className="font-mono text-slate-300">
                {smoke.handoff.taskIds.join(", ")}
              </span>
            </div>
          </div>

          <div className="rounded-md border border-border bg-surface px-3 py-3">
            <div className="mb-2 text-xs font-medium text-slate-400">
              Sanitized Logs
            </div>
            <div className="space-y-1 font-mono text-xs text-slate-300">
              {smoke.logs.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
