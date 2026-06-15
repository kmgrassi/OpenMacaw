import { describe, expect, it } from "vitest";

import { executeToolCall, injectToolExecutionContext, normalizeToolExecutionContext } from "./tool-execution-client.js";
import type { ToolDefinition } from "./tool-spec-translator.js";

function toolWithParameters(parameters: Record<string, unknown>): ToolDefinition {
  return {
    id: "tool-id",
    slug: "get_plans",
    name: "Get plans",
    functionName: "get_plans",
    description: "List workspace plans.",
    parameters,
    executionKind: "api",
    runnerKind: "local_relay",
    enabled: true,
  };
}

function databaseTool(slug: string, parameters: Record<string, unknown>): ToolDefinition {
  return {
    ...toolWithParameters(parameters),
    slug,
    functionName: slug,
    executionKind: "database",
    runnerKind: "planner",
  };
}

function legacyHttpTool(): ToolDefinition {
  return {
    ...toolWithParameters({
      type: "object",
      properties: {
        input: { type: "string" },
      },
    }),
    slug: "legacy.http",
    functionName: "legacy_http",
    executionKind: "api",
    runnerKind: "local_relay",
  };
}

describe("injectToolExecutionContext", () => {
  it("normalizes the formal tool execution context", () => {
    expect(
      normalizeToolExecutionContext({
        agentId: " agent-1 ",
        workspaceId: "workspace-1",
        userId: "",
        sessionId: null,
        requestId: "request-1",
        traceId: "trace-1",
        workspaceRoot: " /tmp/workspace ",
        metadata: { source: "test" },
      }),
    ).toEqual({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      requestId: "request-1",
      traceId: "trace-1",
      workspaceRoot: "/tmp/workspace",
      metadata: { source: "test" },
    });
  });

  it("injects declared runtime context ids into tool arguments", () => {
    const tool = toolWithParameters({
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        user_id: { type: "string" },
        limit: { type: "number" },
      },
    });

    expect(
      injectToolExecutionContext({ limit: 10 }, tool, {
        agentId: "agent-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        sessionId: "session-1",
      }),
    ).toEqual({
      limit: 10,
      workspaceId: "workspace-1",
      user_id: "user-1",
    });
  });

  it("does not overwrite model-provided context arguments", () => {
    const tool = toolWithParameters({
      type: "object",
      properties: {
        workspace_id: { type: "string" },
      },
    });

    expect(
      injectToolExecutionContext({ workspace_id: "explicit-workspace" }, tool, { workspaceId: "runtime-workspace" }),
    ).toEqual({ workspace_id: "explicit-workspace" });
  });

  it("returns a tool error when database tool workspace_id does not match runtime context", async () => {
    const result = await executeToolCall(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "plans.read",
          arguments: '{"workspace_id":"other-workspace"}',
        },
      },
      databaseTool("plans.read", {
        type: "object",
        properties: {
          workspace_id: { type: "string" },
        },
      }),
      { context: { workspaceId: "runtime-workspace" } },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(JSON.parse(result.output)).toMatchObject({
      error: {
        code: "workspace_mismatch",
      },
    });
  });

  it("returns database tool argument errors as tool output", async () => {
    const result = await executeToolCall(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "plan.read",
          arguments: '{"workspace_id":"runtime-workspace"}',
        },
      },
      databaseTool("plan.read", {
        type: "object",
        properties: {
          workspace_id: { type: "string" },
          plan_id: { type: "string" },
        },
      }),
      { context: { workspaceId: "runtime-workspace" } },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(JSON.parse(result.output)).toMatchObject({
      error: {
        code: "invalid_tool_arguments",
      },
    });
  });

  it("does not use the legacy local-chat HTTP helper unless explicitly opted in", async () => {
    const result = await executeToolCall(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "legacy_http",
          arguments: '{"input":"hello"}',
        },
      },
      legacyHttpTool(),
      {
        fetchFn: async () => {
          throw new Error("unexpected fetch");
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 501,
    });
    expect(JSON.parse(result.output)).toMatchObject({
      error: {
        code: "unsupported_tool_execution_transport",
      },
    });
  });

  it("uses the legacy local-chat HTTP helper when the caller opts in", async () => {
    const requestedUrls: string[] = [];
    const result = await executeToolCall(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "legacy_http",
          arguments: '{"input":"hello"}',
        },
      },
      legacyHttpTool(),
      {
        allowLegacyLocalChatHttpToolHelper: true,
        legacyLocalChatToolHelperBaseUrl: "http://legacy-helper.internal/",
        fetchFn: async (input) => {
          requestedUrls.push(String(input));
          return new Response("ok", { status: 200 });
        },
      },
    );

    expect(requestedUrls).toEqual(["http://legacy-helper.internal/tools/execute"]);
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      output: "ok",
    });
  });
});
