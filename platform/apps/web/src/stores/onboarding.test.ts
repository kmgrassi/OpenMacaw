import { describe, expect, it } from "vitest";

import {
  configStepForPath,
  normalizePersistedOnboardingCard,
  sanitizePersistedOnboardingEnvelope,
  summarizeOnboardingBlockers,
  useOnboardingStore,
} from "./onboarding";

describe("onboarding state migration", () => {
  it("falls back to choose-path for unknown persisted cards", () => {
    expect(normalizePersistedOnboardingCard("something-else")).toBe(
      "choose-path",
    );
  });

  it("drops persisted cloudApiKey values and resets invalid currentCard values", () => {
    expect(
      sanitizePersistedOnboardingEnvelope({
        version: 1,
        state: {
          currentCard: "local-helper",
          path: "local",
          cloudApiKey: "sk-test",
        },
      }),
    ).toEqual({
      version: 1,
      state: {
        currentCard: "choose-path",
        path: "local",
      },
    });
  });

  it("keeps only persisted fields that match the onboarding store types", () => {
    expect(
      sanitizePersistedOnboardingEnvelope({
        version: 1,
        state: {
          currentCard: "launch",
          path: "elsewhere",
          provider: "openai",
          selectedAgentIds: ["planning-agent", 7],
          localEndpoint: "http://127.0.0.1:11434/v1",
          localModel: 12,
          localRepositoryPath: "/tmp/openmacaw",
        },
      }),
    ).toEqual({
      version: 1,
      state: {
        currentCard: "launch",
        provider: "openai",
        localEndpoint: "http://127.0.0.1:11434/v1",
        localRepositoryPath: "/tmp/openmacaw",
      },
    });
  });
});

describe("configStepForPath", () => {
  it("maps the cloud path to the cloud-key step", () => {
    expect(configStepForPath("cloud")).toBe("cloud-key");
  });

  it("maps the local path to the relay step", () => {
    expect(configStepForPath("local")).toBe("local-runtime-relay");
  });

  it("falls back to choose-path when no path is selected", () => {
    expect(configStepForPath(null)).toBe("choose-path");
  });
});

describe("summarizeOnboardingBlockers", () => {
  it("humanizes server blocker reasons", () => {
    expect(
      summarizeOnboardingBlockers([
        "planning_missing_model",
        "coding_missing_credential",
      ]),
    ).toBe(
      "Your agents still need configuration before you can continue: planning missing model, coding missing credential.",
    );
  });

  it("returns a generic message when there are no specific reasons", () => {
    expect(summarizeOnboardingBlockers([])).toBe(
      "Your agents still need configuration before you can continue.",
    );
  });
});

describe("resumeIncompleteStep", () => {
  it("returns cloud setup to the key step without clearing selected progress", () => {
    const store = useOnboardingStore.getState();
    store.reset();
    store.setPath("cloud");
    store.setProvider("anthropic");
    store.setSelectedAgentIds(["planning-agent"]);
    store.goToLaunch();

    useOnboardingStore.getState().resumeIncompleteStep();

    expect(useOnboardingStore.getState()).toMatchObject({
      currentCard: "cloud-key",
      path: "cloud",
      provider: "anthropic",
      selectedAgentIds: ["planning-agent"],
    });
  });

  it("returns local setup to the relay step without clearing selected progress", () => {
    const store = useOnboardingStore.getState();
    store.reset();
    store.setPath("local");
    store.setLocalEndpoint("http://127.0.0.1:11434/v1");
    store.setLocalModel("dev-coder");
    store.setLocalRepositoryPath("/tmp/openmacaw");
    store.goToLaunch();

    useOnboardingStore.getState().resumeIncompleteStep();

    expect(useOnboardingStore.getState()).toMatchObject({
      currentCard: "local-runtime-relay",
      path: "local",
      localEndpoint: "http://127.0.0.1:11434/v1",
      localModel: "dev-coder",
      localRepositoryPath: "/tmp/openmacaw",
    });
  });
});
