import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { DefaultAgentsOnboardingState } from "../../../../../contracts/setup";
import { useAuthStore } from "../../stores/auth";
import { useOnboardingStore } from "../../stores/onboarding";
import { Button } from "../ui/Button";
import { StatusBanner } from "../ui/StatusBanner";

const DISMISSED_KEY_PREFIX = "onboarding-nudge-dismissed";

type Props = {
  onboarding: DefaultAgentsOnboardingState;
};

export function OnboardingNudgeBanner({ onboarding }: Props) {
  const navigate = useNavigate();
  const userId = useAuthStore((state) => state.userId);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const resumeIncompleteStep = useOnboardingStore(
    (state) => state.resumeIncompleteStep,
  );
  const [dismissed, setDismissed] = useState(false);

  const dismissedKey = useMemo(() => {
    if (!userId) return null;
    return `${DISMISSED_KEY_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId ?? "no-workspace")}`;
  }, [userId, workspaceId]);

  useEffect(() => {
    setDismissed(Boolean(dismissedKey && localStorage.getItem(dismissedKey)));
  }, [dismissedKey]);

  const dismiss = useCallback(() => {
    if (dismissedKey) {
      localStorage.setItem(dismissedKey, "true");
    }
    setDismissed(true);
  }, [dismissedKey]);

  const resumeSetup = useCallback(() => {
    resumeIncompleteStep();
    navigate("/onboarding");
  }, [navigate, resumeIncompleteStep]);

  if (!onboarding.required || dismissed) {
    return null;
  }

  return (
    <StatusBanner
      tone="warning"
      title="Finish setting up your agents"
      actions={
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="border-amber-400/30 bg-amber-400/10 text-amber-50 hover:bg-amber-400/20"
            onClick={resumeSetup}
          >
            Resume setup
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-amber-100/70 hover:bg-amber-400/10 hover:text-amber-50"
            onClick={dismiss}
          >
            Dismiss
          </Button>
        </>
      }
    >
      <p className="mt-1 max-w-3xl text-amber-100/75">
        Add an API key or connect a local model to start using your planning
        agent. You can keep browsing, but incomplete agents may not run until
        setup is finished.
      </p>
      {onboarding.reasons.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {onboarding.reasons.map((reason) => (
            <li
              key={reason}
              className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-100/80"
            >
              {reason}
            </li>
          ))}
        </ul>
      )}
    </StatusBanner>
  );
}
