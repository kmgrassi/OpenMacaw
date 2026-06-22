import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth";
import { useOnboardingStore } from "../stores/onboarding";
import { Button } from "./ui/Button";
import { Dialog, DialogClose } from "./ui/Dialog";

const DISMISSED_KEY_PREFIX = "onboarding-dismissed";

export function OnboardingModal() {
  const { defaultAgentOnboarding, userId, workspaceId } = useAuthStore();
  const resumeIncompleteStep = useOnboardingStore(
    (state) => state.resumeIncompleteStep,
  );
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const dismissedKey = useMemo(() => {
    if (!userId) return null;
    return `${DISMISSED_KEY_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId ?? "no-workspace")}`;
  }, [userId, workspaceId]);

  useEffect(() => {
    if (
      defaultAgentOnboarding.required &&
      dismissedKey &&
      !localStorage.getItem(dismissedKey)
    ) {
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [defaultAgentOnboarding.required, dismissedKey]);

  const dismiss = useCallback(() => {
    if (dismissedKey) {
      localStorage.setItem(dismissedKey, "true");
    }
    setVisible(false);
  }, [dismissedKey]);

  const goToOnboarding = useCallback(() => {
    dismiss();
    resumeIncompleteStep();
    navigate("/onboarding");
  }, [dismiss, navigate, resumeIncompleteStep]);

  if (!visible) return null;

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      title="Some agents need setup"
      description={
        "One or more agents are missing credentials or configuration. " +
        "You can continue using the app, but these agents won't work until " +
        "they're configured."
      }
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Dismiss
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={goToOnboarding}
            className="px-4 hover:bg-blue-500"
          >
            Finish setup
          </Button>
        </>
      }
    >
      {defaultAgentOnboarding.reasons.length > 0 && (
        <ul className="space-y-1.5">
          {defaultAgentOnboarding.reasons.map((reason) => (
            <li
              key={reason}
              className="flex items-start gap-2 text-sm text-slate-300"
            >
              <span className="mt-1 block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              {reason}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
