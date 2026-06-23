import { describe, expect, it } from "vitest";
import { getMessageContextDisplay } from "./message-context-rendering";

describe("getMessageContextDisplay", () => {
  it("formats an agent context snapshot from message metadata", () => {
    expect(
      getMessageContextDisplay({
        agent_context_snapshot: {
          text: "Use repo.list with path .",
          chars: 25,
          sha256: "abcdef123456",
        },
      }),
    ).toEqual({
      label: "Context passed (25 chars)",
      chars: 25,
      sha256: "abcdef123456",
      text: "Use repo.list with path .",
    });
  });

  it("falls back to direct agent_context metadata", () => {
    expect(
      getMessageContextDisplay({
        agent_context: "Keep repository paths relative.",
      }),
    ).toEqual({
      label: "Context passed",
      chars: null,
      sha256: null,
      text: "Keep repository paths relative.",
    });
  });

  it("ignores metadata without context", () => {
    expect(getMessageContextDisplay({ model: "gpt-test" })).toBeNull();
    expect(getMessageContextDisplay(null)).toBeNull();
  });
});
