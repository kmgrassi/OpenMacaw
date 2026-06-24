import { describe, expect, it } from "vitest";

import { resolveUpdatedAgentContext } from "./stored-agent-management.js";

describe("resolveUpdatedAgentContext", () => {
  it("preserves the existing context when the field is omitted", () => {
    expect(resolveUpdatedAgentContext(undefined, "Stay terse.")).toBe("Stay terse.");
    expect(resolveUpdatedAgentContext(undefined, null)).toBeNull();
  });

  it("clears the context when an explicit null or blank string is sent", () => {
    expect(resolveUpdatedAgentContext(null, "Stay terse.")).toBeNull();
    expect(resolveUpdatedAgentContext("", "Stay terse.")).toBeNull();
    expect(resolveUpdatedAgentContext("   ", "Stay terse.")).toBeNull();
  });

  it("trims and stores a new context when provided", () => {
    expect(resolveUpdatedAgentContext("  Always respond in haiku.  ", null)).toBe("Always respond in haiku.");
  });
});
