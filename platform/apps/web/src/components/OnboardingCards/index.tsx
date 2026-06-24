import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { useAuthStore } from "../../stores/auth";
import {
  useOnboardingStore,
  type OnboardingCard,
} from "../../stores/onboarding";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { ChoosePathCard } from "./ChoosePathCard";
import { CloudKeyCard } from "./CloudKeyCard";
import { LaunchAgentCard } from "./LaunchAgentCard";
import { LocalRuntimeRelayCard } from "./LocalRuntimeRelayCard";

const CARD_META: Record<
  OnboardingCard,
  { label: string; step: number; title: string }
> = {
  "choose-path": {
    label: "Choose path",
    step: 1,
    title: "How do you want to run your agent?",
  },
  "cloud-key": { label: "Cloud key", step: 2, title: "Use a cloud model" },
  "local-runtime-relay": {
    label: "Local runtime relay",
    step: 2,
    title: "Use a local model",
  },
  launch: { label: "Launch", step: 3, title: "Launch your first agent" },
};

export function OnboardingCards() {
  const navigate = useNavigate();
  const {
    resolvedAgentId,
    defaultAgents,
    defaultAgentOnboarding,
    managerAgent,
  } = useAuthStore();
  const {
    currentCard,
    setPath,
    advanceCard,
    goBack,
    resumeIncompleteStep,
    setSelectedAgentIds,
  } = useOnboardingStore();

  // If we land on the launch card while onboarding is still required (e.g. a
  // reload after the config step's server state was invalidated), return to the
  // path's config step rather than wiping the user's progress back to step 1.
  useEffect(() => {
    if (currentCard === "launch" && defaultAgentOnboarding.required) {
      resumeIncompleteStep();
    }
  }, [currentCard, defaultAgentOnboarding.required, resumeIncompleteStep]);

  if (currentCard === "launch" && defaultAgentOnboarding.required) {
    return null;
  }

  if (
    currentCard !== "launch" &&
    !defaultAgentOnboarding.required &&
    resolvedAgentId
  ) {
    return <Navigate to={`/dashboard/${resolvedAgentId}`} replace />;
  }

  const meta = CARD_META[currentCard];
  const defaultAgentIds = [
    defaultAgents.planning.agentId,
    defaultAgents.coding.agentId,
    managerAgent.agentId,
  ].filter((agentId): agentId is string => Boolean(agentId));

  function choosePath(path: "cloud" | "local") {
    setSelectedAgentIds(defaultAgentIds);
    setPath(path);
  }

  function openDashboard(agentId = resolvedAgentId) {
    if (agentId) {
      navigate(`/dashboard/${agentId}`, { replace: true });
    }
  }

  return (
    <Card className="border-slate-800 bg-slate-950/70 p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Badge>Step {meta.step} of 3</Badge>
          <h2 className="mt-3 text-2xl font-semibold text-white">
            {meta.title}
          </h2>
        </div>
        <div className="text-sm text-slate-500">{meta.label}</div>
      </div>

      {currentCard === "choose-path" && (
        <ChoosePathCard
          onChooseCloud={() => choosePath("cloud")}
          onChooseLocal={() => choosePath("local")}
        />
      )}

      {currentCard === "cloud-key" && (
        <CloudKeyCard onBack={goBack} onContinue={advanceCard} />
      )}

      {currentCard === "local-runtime-relay" && (
        <LocalRuntimeRelayCard
          onBack={goBack}
          onContinue={advanceCard}
          onSkip={() =>
            openDashboard(defaultAgents.planning.agentId ?? resolvedAgentId)
          }
        />
      )}

      {currentCard === "launch" && (
        <LaunchAgentCard
          canOpenDashboard={Boolean(resolvedAgentId)}
          onBack={goBack}
          onOpenDashboard={openDashboard}
        />
      )}
    </Card>
  );
}
