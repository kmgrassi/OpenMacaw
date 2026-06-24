import { describe, expect, it } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getLocalChatToolResolutionForAgent, getLocalChatToolsForAgent } from "./local-chat-agent-tools.js";

const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";

function tool(overrides: Record<string, unknown>) {
  return {
    id: "tool-read",
    workspace_id: null,
    slug: "shell.exec",
    name: "Read File",
    description: "Read a file",
    function_name: "shell_exec",
    parameters: { type: "object" },
    examples: [],
    type: null,
    execution_kind: "filesystem_read",
    runner_kind: "local_model_coding",
    enabled: true,
    ...overrides,
  };
}

function grant(toolId: string, mode: "include" | "exclude", source: "template" | "manual" = "manual") {
  return {
    id: `grant-${toolId}`,
    agent_id: agentId,
    tool_id: toolId,
    workspace_id: workspaceId,
    mode,
    source,
    source_tool_template_id: null,
    reason: null,
    created_by_user_id: userId,
  };
}

describe("local chat agent tools", () => {
  it("uses shared grant resolution and filters local coding tools for direct local chat", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      tool: [
        tool({
          id: "tool-read",
          slug: "plan.create",
          function_name: "plan_create",
          runner_kind: "local_relay",
        }),
        tool({ id: "tool-search", slug: "scheduled_task.list", function_name: "scheduled_task_list" }),
        tool({
          id: "tool-shell",
          slug: "shell.exec",
          function_name: "shell_exec",
          execution_kind: "shell",
          runner_kind: "local_model_coding",
        }),
      ],
      agent_tool_grant: [
        grant("tool-read", "include", "template"),
        grant("tool-search", "exclude"),
        grant("tool-shell", "include"),
      ],
    };

    const resolution = await getLocalChatToolResolutionForAgent({
      agentId,
      workspaceId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(resolution.tools.map((resolvedTool) => [resolvedTool.slug, resolvedTool.functionName])).toEqual([
      ["plan.create", "plan_create"],
      ["memory.create", "memory_create"],
      ["memory.search", "memory_search"],
    ]);
    expect(resolution.rejectedLocalCodingTools.map((resolvedTool) => resolvedTool.slug)).toEqual(["shell.exec"]);
  });

  it("keeps getLocalChatToolsForAgent scoped to direct-chat-safe tools", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      tool: [
        tool({
          id: "tool-read",
          slug: "plan.create",
          function_name: "plan_create",
          runner_kind: "local_relay",
        }),
        tool({
          id: "tool-apply-patch",
          slug: "apply_patch",
          function_name: "apply_patch",
          execution_kind: "filesystem",
          runner_kind: "local_model_coding",
        }),
      ],
      agent_tool_grant: [grant("tool-read", "include"), grant("tool-apply-patch", "include")],
    };

    const tools = await getLocalChatToolsForAgent({
      agentId,
      workspaceId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(tools.map((resolvedTool) => resolvedTool.slug)).toEqual(["plan.create", "memory.create", "memory.search"]);
  });

  it("ignores tools without concrete include grants", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      tool: [
        tool({
          id: "tool-plan",
          slug: "plan.create",
          name: "Create Plan",
          function_name: "plan_create",
          execution_kind: "database",
          runner_kind: "llm_tool_runner",
        }),
      ],
      agent_tool_grant: [],
    };

    const tools = await getLocalChatToolsForAgent({
      agentId,
      workspaceId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(tools.map((resolvedTool) => [resolvedTool.slug, resolvedTool.functionName])).toEqual([
      ["memory.create", "memory_create"],
      ["memory.search", "memory_search"],
    ]);
  });

  it("adds memory tools as system tools without a learning gate", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      agent: [{ id: agentId, workspace_id: workspaceId }],
      workspaces: [{ id: workspaceId, settings: { learning: { enabled: false } } }],
      tool: [],
      agent_tool_grant: [],
    };

    const tools = await getLocalChatToolsForAgent({
      agentId,
      workspaceId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(tools.map((resolvedTool) => [resolvedTool.slug, resolvedTool.functionName])).toEqual([
      ["memory.create", "memory_create"],
      ["memory.search", "memory_search"],
    ]);
  });
});
