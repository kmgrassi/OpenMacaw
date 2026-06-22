import { create } from "zustand";
import { persist } from "zustand/middleware";

export type OnboardingCard =
  | "choose-path"
  | "cloud-key"
  | "local-runtime-relay"
  | "launch";
export type OnboardingPath = "cloud" | "local" | null;
export type OnboardingCloudProvider = "openai" | "anthropic";

export const ONBOARDING_CLOUD_PROVIDERS: OnboardingCloudProvider[] = [
  "openai",
  "anthropic",
];

export const DEFAULT_MODEL_BY_PROVIDER: Record<
  OnboardingCloudProvider,
  string
> = {
  openai: "openai/gpt-5.2",
  anthropic: "anthropic/claude-sonnet-4-6",
};

export const KEY_NAME_BY_PROVIDER: Record<OnboardingCloudProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const PERSISTED_STORAGE_KEY = "harper-onboarding-flow";
const STORAGE_KEYS_TO_SANITIZE = [
  PERSISTED_STORAGE_KEY,
  "parallel-agent-onboarding",
];

type OnboardingState = {
  currentCard: OnboardingCard;
  path: OnboardingPath;
  selectedAgentIds: string[];
  provider: OnboardingCloudProvider;
  cloudApiKey: string;
  localEndpoint: string;
  localModel: string;
  localRepositoryPath: string;
  saving: boolean;
  error: string | null;

  setPath: (path: Exclude<OnboardingPath, null>) => void;
  setCurrentCard: (card: OnboardingCard) => void;
  setSelectedAgentIds: (agentIds: string[]) => void;
  advanceCard: () => void;
  goBack: () => void;
  goToLaunch: () => void;
  setProvider: (provider: OnboardingCloudProvider) => void;
  setCloudApiKey: (cloudApiKey: string) => void;
  setLocalEndpoint: (localEndpoint: string) => void;
  setLocalModel: (localModel: string) => void;
  setLocalRepositoryPath: (localRepositoryPath: string) => void;
  setSaving: (saving: boolean) => void;
  setError: (error: string | null) => void;
  resumeIncompleteStep: () => void;
  reset: () => void;
};

const CLOUD_CARD_ORDER: OnboardingCard[] = [
  "choose-path",
  "cloud-key",
  "launch",
];

export function normalizePersistedOnboardingCard(
  value: unknown,
): OnboardingCard {
  if (
    value === "choose-path" ||
    value === "cloud-key" ||
    value === "local-runtime-relay" ||
    value === "launch"
  ) {
    return value;
  }
  return "choose-path";
}

export function sanitizePersistedOnboardingEnvelope(parsed: {
  state?: Record<string, unknown>;
  version?: number;
}): {
  state?: Record<string, unknown>;
  version?: number;
} {
  if (!parsed.state) return parsed;

  const { cloudApiKey: _cloudApiKey, ...state } = parsed.state;
  return {
    ...parsed,
    state: {
      ...state,
      currentCard: normalizePersistedOnboardingCard(state.currentCard),
    },
  };
}

/**
 * The first configuration step for a chosen path — i.e. the card a user must
 * complete before the launch card becomes valid. Used to resume the flow when
 * a user reaches launch but onboarding is still incomplete.
 */
export function configStepForPath(path: OnboardingPath): OnboardingCard {
  if (path === "cloud") return "cloud-key";
  if (path === "local") return "local-runtime-relay";
  return "choose-path";
}

/**
 * Build a human-readable message from the server's onboarding blocker reasons
 * (`${role}_missing_${item}`), e.g. "planning missing model, coding missing
 * credential". Surfaced when a save succeeds at the HTTP layer but the agents
 * are still not fully configured.
 */
export function summarizeOnboardingBlockers(reasons: string[]): string {
  if (reasons.length === 0) {
    return "Your agents still need configuration before you can continue.";
  }
  const detail = reasons.map((reason) => reason.replace(/_/g, " ")).join(", ");
  return `Your agents still need configuration before you can continue: ${detail}.`;
}

function cardOrderForPath(path: OnboardingPath): OnboardingCard[] {
  if (path === "local") {
    return ["choose-path", "local-runtime-relay", "launch"];
  }
  return CLOUD_CARD_ORDER;
}

function nextCard(currentCard: OnboardingCard, path: OnboardingPath) {
  const order = cardOrderForPath(path);
  const index = order.indexOf(currentCard);
  return order[Math.min(index + 1, order.length - 1)] ?? currentCard;
}

function previousCard(currentCard: OnboardingCard, path: OnboardingPath) {
  const order = cardOrderForPath(path);
  const index = order.indexOf(currentCard);
  return order[Math.max(index - 1, 0)] ?? currentCard;
}

const INITIAL_STATE = {
  currentCard: "choose-path" as const,
  path: null,
  selectedAgentIds: [] as string[],
  provider: "openai" as OnboardingCloudProvider,
  cloudApiKey: "",
  localEndpoint: "http://localhost:11434/v1",
  localModel: "qwen2.5-coder",
  localRepositoryPath: "",
  saving: false,
  error: null,
};

function sanitizePersistedOnboardingState() {
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function" ||
    typeof globalThis.localStorage.setItem !== "function" ||
    typeof globalThis.localStorage.removeItem !== "function"
  ) {
    return;
  }

  for (const storageKey of STORAGE_KEYS_TO_SANITIZE) {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as {
        state?: Record<string, unknown>;
        version?: number;
      };
      const sanitized = sanitizePersistedOnboardingEnvelope(parsed);
      globalThis.localStorage.setItem(storageKey, JSON.stringify(sanitized));
    } catch {
      globalThis.localStorage.removeItem(storageKey);
    }
  }
}

sanitizePersistedOnboardingState();

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,

      setPath: (path) =>
        set({
          path,
          currentCard: path === "local" ? "local-runtime-relay" : "cloud-key",
          error: null,
        }),
      setCurrentCard: (currentCard) => set({ currentCard, error: null }),
      setSelectedAgentIds: (selectedAgentIds) => set({ selectedAgentIds }),
      advanceCard: () =>
        set((state) => ({
          currentCard: nextCard(state.currentCard, state.path),
          error: null,
        })),
      goBack: () =>
        set((state) => ({
          currentCard: previousCard(state.currentCard, state.path),
          error: null,
        })),
      goToLaunch: () => set({ currentCard: "launch", error: null }),
      setProvider: (provider) => set({ provider, error: null }),
      setCloudApiKey: (cloudApiKey) => set({ cloudApiKey, error: null }),
      setLocalEndpoint: (localEndpoint) => set({ localEndpoint, error: null }),
      setLocalModel: (localModel) => set({ localModel, error: null }),
      setLocalRepositoryPath: (localRepositoryPath) =>
        set({ localRepositoryPath, error: null }),
      setSaving: (saving) => set({ saving }),
      setError: (error) => set({ error }),
      resumeIncompleteStep: () =>
        set((state) => ({
          currentCard: configStepForPath(state.path),
          error: null,
        })),
      reset: () => set(INITIAL_STATE),
    }),
    {
      name: PERSISTED_STORAGE_KEY,
      partialize: (state) => ({
        currentCard: state.currentCard,
        path: state.path,
        selectedAgentIds: state.selectedAgentIds,
        provider: state.provider,
        localEndpoint: state.localEndpoint,
        localModel: state.localModel,
        localRepositoryPath: state.localRepositoryPath,
      }),
    },
  ),
);
