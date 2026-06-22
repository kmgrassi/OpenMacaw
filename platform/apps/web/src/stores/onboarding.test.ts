import { describe, expect, it } from "vitest";

import {
  normalizePersistedOnboardingCard,
  sanitizePersistedOnboardingEnvelope,
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
