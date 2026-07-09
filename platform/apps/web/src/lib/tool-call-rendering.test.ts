import { describe, expect, it } from "vitest";
import {
  formatMetadataToolCall,
  formatPersistedToolCall,
  formatPersistedToolCalls,
} from "./tool-call-rendering";

describe("tool-call-rendering", () => {
  it("formats metadata tool calls from typed object payloads", () => {
    expect(
      formatMetadataToolCall({ tool_name: "work_items.list", status: "ok" }, 0),
    ).toEqual({
      label: "work_items.list",
      status: "ok",
    });
  });

  it("formats persisted tool calls from structured input and output payloads", () => {
    expect(
      formatPersistedToolCall(
        {
          id: "tool-call-1",
          input: JSON.stringify({
            tool_name: "work_items.list",
            input: { arguments: { state: "due" } },
          }),
          output: JSON.stringify({
            status: "failed",
            error_code: "timeout",
            output: { error: "Timed out" },
          }),
        },
        0,
      ),
    ).toEqual({
      label: "work_items.list",
      status: "failed timeout",
      inputSummary: '{"state":"due"}',
      outputSummary: "Timed out",
    });
  });

  it("infers git.run arguments from nested JSON execution output", () => {
    expect(
      formatPersistedToolCalls([
        {
          id: "tool-call-1",
          input: JSON.stringify({
            tool_name: "git.run",
            input: { arguments: {} },
          }),
          output: JSON.stringify({
            status: "ok",
            output: JSON.stringify({
              argv: ["gh", "pr", "list"],
              cwd: "/Users/kevingrassi/Desktop/repos/openmacaw",
              ok: true,
            }),
          }),
        },
      ]),
    ).toEqual([
      {
        label: "git.run",
        status: "ok",
        inputSummary:
          '{"command":"gh pr list","cwd":"/Users/kevingrassi/Desktop/repos/openmacaw"}',
        outputSummary:
          '{"argv":["gh","pr","list"],"cwd":"/Users/kevingrassi/Desktop/repos/openmacaw","ok":true}',
      },
    ]);
  });

  it("falls back to raw text when persisted payloads are not JSON objects", () => {
    expect(
      formatPersistedToolCall(
        {
          id: "tool-call-1",
          input: "not-json-input",
          output: "not-json-output",
        },
        0,
      ),
    ).toEqual({
      label: "Tool call 1",
      inputSummary: "not-json-input",
      outputSummary: "not-json-output",
    });
  });
});
