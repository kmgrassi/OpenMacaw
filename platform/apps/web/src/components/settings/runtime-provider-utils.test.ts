import { describe, expect, it } from "vitest";

import {
  managerRuntimeProviderLabel,
  runtimeProviderLabel,
} from "./runtime-provider-utils";

describe("runtimeProviderLabel", () => {
  it("uses canonical registry labels for known runtime providers", () => {
    expect(runtimeProviderLabel("openai")).toBe("OpenAI");
    expect(runtimeProviderLabel("openai_compatible")).toBe(
      "OpenAI-compatible",
    );
    expect(runtimeProviderLabel("local")).toBe("Local runtime");
  });

  it("falls back to a readable title-cased label for unknown providers", () => {
    expect(runtimeProviderLabel("custom_runner")).toBe("Custom Runner");
  });
});

describe("managerRuntimeProviderLabel", () => {
  it("keeps the manager-local wording for direct local endpoints", () => {
    expect(managerRuntimeProviderLabel("openai_compatible")).toBe(
      "OpenAI-compatible local",
    );
  });
});
