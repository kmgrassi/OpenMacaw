import { CREDENTIAL_PROVIDER_REGISTRY } from "../../../../../contracts/credentials";
import { useApplyDefaultAgentCredentialsMutation } from "../../hooks/useServerStateQueries";
import { cn } from "../../lib/cn";
import { useAuthStore } from "../../stores/auth";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  KEY_NAME_BY_PROVIDER,
  ONBOARDING_CLOUD_PROVIDERS,
  useOnboardingStore,
  type OnboardingCloudProvider,
} from "../../stores/onboarding";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useDefaultAgentRows } from "./useDefaultAgentRows";

type Props = {
  onBack: () => void;
  onContinue: () => void;
};

const PROVIDER_OPTIONS = (
  Object.values(CREDENTIAL_PROVIDER_REGISTRY) as Array<{
    provider: string;
    label: string;
  }>
)
  .filter(({ provider }) =>
    ONBOARDING_CLOUD_PROVIDERS.includes(provider as OnboardingCloudProvider),
  )
  .sort((left, right) => {
    if (left.provider === "openai") return -1;
    if (right.provider === "openai") return 1;
    if (left.provider === "anthropic") return -1;
    if (right.provider === "anthropic") return 1;
    return left.label.localeCompare(right.label);
  })
  .map(({ provider, label }) => ({
    value: provider as OnboardingCloudProvider,
    label,
  }));

export function CloudKeyCard({ onBack, onContinue }: Props) {
  const auth = useAuthStore();
  const applyCredentials = useApplyDefaultAgentCredentialsMutation();
  const {
    provider,
    cloudApiKey,
    saving,
    error,
    setCloudApiKey,
    setError,
    setProvider,
    setSaving,
    setSelectedAgentIds,
  } = useOnboardingStore();
  const agents = useDefaultAgentRows();
  const missingAgents = agents.filter((agent) => !agent.agentId);
  const agentIds = agents
    .map((agent) => agent.agentId)
    .filter((agentId): agentId is string => Boolean(agentId));
  const canSubmit =
    Boolean(auth.workspaceId) &&
    missingAgents.length === 0 &&
    cloudApiKey.trim().length > 0 &&
    !saving;

  async function handleSubmit() {
    if (!auth.workspaceId || missingAgents.length > 0) {
      setError(
        "Default agents are still being provisioned. Try again shortly.",
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const authState = await applyCredentials.mutateAsync({
        workspaceId: auth.workspaceId,
        provider,
        model: DEFAULT_MODEL_BY_PROVIDER[provider],
        keyName: KEY_NAME_BY_PROVIDER[provider],
        secret: cloudApiKey.trim(),
        agentIds,
      });
      auth.applyAuthState(authState);
      setSelectedAgentIds(agentIds);
      onContinue();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-slate-800 bg-slate-900/70 p-6">
      <div className="text-lg font-semibold text-white">Add an API key</div>
      <p className="mt-2 text-sm text-slate-400">
        This configures your standardized agents with the same provider for
        first run.
      </p>

      <div className="mt-6 grid gap-5">
        <Select
          label="Provider"
          value={provider}
          onChange={(event) =>
            setProvider(event.target.value as OnboardingCloudProvider)
          }
          options={PROVIDER_OPTIONS}
        />
        <Input
          label="API Key"
          type="password"
          value={cloudApiKey}
          onChange={(event) => setCloudApiKey(event.target.value)}
          placeholder={KEY_NAME_BY_PROVIDER[provider]}
          autoComplete="off"
        />

        <div className="rounded-lg border border-slate-800 bg-slate-950/55">
          {agents.map((agent, index) => (
            <div
              key={agent.key}
              className={cn(
                "flex gap-3 p-4",
                index > 0 && "border-t border-slate-800",
              )}
            >
              <Badge variant={agent.agentId ? "success" : "warning"}>
                {agent.agentId ? "Ready" : "Pending"}
              </Badge>
              <div>
                <div className="text-sm font-medium text-white">
                  {agent.role}
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  {agent.description}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          loading={saving}
        >
          Save key and continue
        </Button>
      </div>
    </Card>
  );
}
