import { describe, expect, it } from "vitest";

import { formatProviderLabel } from "./provider-labels";

describe("formatProviderLabel", () => {
  it("uses the canonical provider metadata when available", () => {
    expect(formatProviderLabel("openai")).toBe("OpenAI");
    expect(formatProviderLabel("openai_codex")).toBe("ChatGPT (OAuth)");
    expect(formatProviderLabel("github")).toBe("GitHub personal access token");
  });

  it("supports the manager-specific local relay wording", () => {
    expect(
      formatProviderLabel("openai_compatible", {
        localOpenAICompatible: true,
      }),
    ).toBe("OpenAI-compatible local");
  });

  it("title-cases unknown provider ids after normalization", () => {
    expect(formatProviderLabel("custom_runtime-provider")).toBe(
      "Custom Runtime Provider",
    );
  });

  it("uses the configured fallback for blank values", () => {
    expect(formatProviderLabel("   ", { fallback: "Unknown" })).toBe("Unknown");
    expect(formatProviderLabel(undefined)).toBe("Unknown provider");
  });
});
