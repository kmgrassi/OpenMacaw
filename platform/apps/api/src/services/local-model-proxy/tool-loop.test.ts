import { afterEach, describe, expect, it, vi } from "vitest";

import { chatWithTools } from "./tool-loop.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("local model proxy tool loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("falls back to prompt tools when Ollama rejects native tools with an XML parser error", async () => {
    let modelCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tools/execute")) {
        return new Response("tool ok", { status: 200 });
      }

      modelCalls += 1;
      const request = JSON.parse(String(init?.body)) as {
        tools?: unknown[];
        messages?: Array<{ role?: string; content?: string }>;
      };

      if (modelCalls === 1) {
        expect(request.tools).toHaveLength(1);
        return jsonResponse(
          {
            error: {
              message: "XML syntax error on line 25: element \\u003cparameter\\u003e closed by \\u003c/function\\u003e",
              type: "api_error",
            },
          },
          500,
        );
      }

      if (modelCalls === 2) {
        expect(request.tools).toBeUndefined();
        expect(request.messages?.[0]?.role).toBe("system");
        expect(request.messages?.[0]?.content).toContain("tool_call");
        return jsonResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"tool_call":{"name":"mark_done","arguments":{"reason":"no unresolved work"}}}',
              },
              finish_reason: "stop",
            },
          ],
        });
      }

      expect(request.messages?.at(-1)?.role).toBe("tool");
      return jsonResponse({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const completion = await chatWithTools({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      chatUrl: "http://127.0.0.1:11434/v1/chat/completions",
      routingRuleId: null,
      messages: [{ role: "user", content: "decide" }],
      tools: [
        {
          id: "tool-mark-done",
          slug: "mark_done",
          name: "Mark Done",
          functionName: "mark_done",
          description: "Mark the item done.",
          parameters: { type: "object", properties: { reason: { type: "string" } } },
          executionKind: "http",
          runnerKind: null,
          enabled: true,
        },
      ],
      maxIterations: 3,
    });

    expect(modelCalls).toBe(3);
    expect(completion.choices?.[0]?.message?.content).toBe("done");
  });
});
