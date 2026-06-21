import { prepareRuntime } from "../../api/broker-runtime";
import { useAuthStore } from "../../stores/auth";
import { useOnboardingStore } from "../../stores/onboarding";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { useDefaultAgentRows } from "./useDefaultAgentRows";

type Props = {
  canOpenDashboard: boolean;
  onBack: () => void;
  onOpenDashboard: (agentId?: string | null) => void;
};

export function LaunchAgentCard({
  canOpenDashboard,
  onBack,
  onOpenDashboard,
}: Props) {
  const { resolvedAgentId, setResolvedContext, workspaceId } = useAuthStore();
  const planningAgentId = useAuthStore(
    (state) => state.defaultAgents.planning.agentId,
  );
  const { error, saving, setError, setSaving } = useOnboardingStore();
  const targetAgentId = planningAgentId ?? resolvedAgentId;
  const agents = useDefaultAgentRows();

  async function launchAndOpenDashboard() {
    if (!targetAgentId || !workspaceId) return;

    setSaving(true);
    setError(null);
    try {
      const result = await prepareRuntime(targetAgentId);
      if (!result.readyToConnect) {
        const message =
          result.prepareError?.message ||
          result.reasons.join(", ") ||
          "Could not start the runtime.";
        throw new Error(message);
      }
      setResolvedContext({ agentId: targetAgentId, workspaceId });
      onOpenDashboard(targetAgentId);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-slate-800 bg-slate-900/70 p-6">
      <div className="text-lg font-semibold text-white">
        Land in your dashboard
      </div>
      <p className="mt-2 text-sm text-slate-400">
        The planning agent opens first. Coding and manager agents stay
        configured in the background.
      </p>

      <div className="mt-4 grid gap-2 text-sm text-slate-300">
        {agents.length > 0 ? (
          agents.map((agent) => (
            <div
              key={agent.key}
              className="flex gap-3 rounded-md bg-slate-950/60 px-3 py-2"
            >
              <Badge variant={agent.agentId ? "success" : "warning"}>
                {agent.agentId ? "Ready" : "Pending"}
              </Badge>
              <div>
                <div className="font-medium text-white">{agent.role}</div>
                <div className="mt-1 text-slate-400">
                  {agent.description}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="text-slate-400">Default agents configured.</div>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => void launchAndOpenDashboard()}
          disabled={!canOpenDashboard || !targetAgentId || !workspaceId}
          loading={saving}
        >
          {error ? "Retry" : "Go to dashboard"}
        </Button>
      </div>
    </Card>
  );
}
