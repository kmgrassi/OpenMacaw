import { describe, expect, it } from "vitest";

import { extractToolCalls, hasToolCalls } from "./tool-call-parser.js";

describe("tool call parser", () => {
  it("extracts native OpenAI-compatible tool calls", () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "shell_exec",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    };

    expect(extractToolCalls(response)).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "shell_exec",
          arguments: '{"path":"README.md"}',
        },
      },
    ]);
    expect(hasToolCalls(response)).toBe(true);
  });

  it("extracts prompt-based fallback tool calls from fenced JSON", () => {
    const response = {
      choices: [
        {
          message: {
            content: '```json\n{"tool_call":{"name":"shell_exec","arguments":{"path":"README.md"}}}\n```',
          },
        },
      ],
    };

    const calls = extractToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        type: "function",
        promptBasedFallback: true,
        function: {
          name: "shell_exec",
          arguments: '{"path":"README.md"}',
        },
      }),
    );
  });

  it("extracts prompt-based fallback tool calls from function tags", () => {
    const calls = extractToolCalls({
      choices: [
        {
          message: {
            content:
              "Let me retrieve that.\n\n<function=plans_read>\n<parameter=workspace_id>\nworkspace-1\n</parameter>\n</function>\n</tool_call>",
          },
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        type: "function",
        promptBasedFallback: true,
        function: {
          name: "plans_read",
          arguments: '{"workspace_id":"workspace-1"}',
        },
      }),
    );
  });

  it("returns no calls for normal assistant text", () => {
    expect(
      extractToolCalls({
        choices: [
          {
            message: {
              content: "Here is the final answer.",
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});
