import { describe, expect, it } from "vitest";

import {
  configStepForPath,
  normalizePersistedOnboardingCard,
  sanitizePersistedOnboardingEnvelope,
  summarizeOnboardingBlockers,
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
