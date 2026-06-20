import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { executeDatabaseTool } from "./database-tool-executor.js";
import type { ToolDefinition } from "./tool-spec-translator.js";

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: async (_context: string, query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw error;
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
  },
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const targetAgentId = "55555555-5555-4555-8555-555555555555";
const foreignAgentId = "44444444-4444-4444-8444-444444444444";

function scheduledTaskTool(slug: string): ToolDefinition {
  return {
    id: `tool-${slug}`,
    slug,
    name: slug,
    functionName: slug,
    description: "",
    parameters: {},
    executionKind: "database",
    runnerKind: "planner",
    enabled: true,
  };
}

describe("executeDatabaseTool scheduled_task tools", () => {
  let tables: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    tables = {
      agent: [
        { id: agentId, workspace_id: workspaceId },
        { id: targetAgentId, workspace_id: workspaceId },
        { id: foreignAgentId, workspace_id: "foreign-workspace" },
      ],
      tool: [
        {
          id: "tool-repo-read",
          workspace_id: null,
          slug: "repo.read_file",
          name: "Read File",
          description: "Read a file.",
          examples: [{ input: { path: "README.md" } }],
          parameters: {},
          function_name: "repo.read_file",
          execution_kind: "filesystem_read",
          runner_kind: "codex",
          enabled: true,
        },
        {
          id: "foreign-tool",
          workspace_id: "foreign-workspace",
          slug: "foreign.tool",
          name: "Foreign Tool",
          description: "Foreign.",
          examples: [],
          parameters: {},
          function_name: "foreign.tool",
          execution_kind: "database",
          runner_kind: "planner",
          enabled: true,
        },
      ],
      agent_tool_grant: [
        {
          id: "grant-repo-read",
          agent_id: agentId,
          workspace_id: workspaceId,
          tool_id: "tool-repo-read",
          mode: "include",
        },
      ],
      scheduled_task: [
        {
          id: "scheduled-task-1",
          agent_id: agentId,
          instructions: "Review open work.",
          cron_schedule: null,
          next_interval: { kind: "every", interval: 1, unit: "day" },
          start_time: null,
          is_active: true,
          is_completed: false,
          is_follow_up: false,
          cancelled_reason: null,
        },
        {
          id: "foreign-scheduled-task",
          agent_id: foreignAgentId,
          instructions: "Foreign work.",
          is_active: true,
        },
      ],
      skill: [],
      routing_rule: [
        {
          id: "routing-rule-1",
          workspace_id: workspaceId,
          name: `agent:${agentId}:execution-profile`,
          priority: 100,
          runner_kind: "llm_tool_runner",
          provider: "openai",
          model: "gpt-4.1",
          credential_id: null,
          credential_alias: "openai-default",
          enabled: true,
          model_tier_floor: "any",
          updated_at: "2026-04-25T00:00:00.000Z",
        },
      ],
      routing_rule_match: [
        {
          id: "routing-rule-match-1",
          workspace_id: workspaceId,
          rule_id: "routing-rule-1",
          kind: "agent",
          key: "id",
          value: agentId,
        },
      ],
      routing_rule_fallback: [
        {
          id: "fallback-1",
          workspace_id: workspaceId,
          routing_rule_id: "routing-rule-1",
          position: 0,
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          credential_id: null,
          credential_alias: "anthropic-default",
        },
      ],
      routing_rule_change: [],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
  });

  it("creates a scheduled task for the runtime agent in the current workspace", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("scheduled_task.create"),
      {
        instructions: "Check blocked PRs.",
        schedule: { kind: "every", interval: 1, unit: "hour" },
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.output)).toMatchObject({
      scheduledTask: {
        agent_id: agentId,
        instructions: "Check blocked PRs.",
        next_interval: { kind: "every", interval: 1, unit: "hour" },
        is_active: true,
      },
    });
  });

  it("lists only scheduled tasks owned by agents in the runtime workspace", async () => {
    const result = await executeDatabaseTool(scheduledTaskTool("scheduled_task.list"), {}, { workspaceId, agentId });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output).scheduledTasks.map((task: { id: string }) => task.id)).toEqual([
      "scheduled-task-1",
    ]);
  });

  it("rejects cross-workspace scheduled task reads", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("scheduled_task.read"),
        { scheduledTaskId: "foreign-scheduled-task" },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_not_found",
    });
  });

  it("soft-cancels scheduled tasks instead of deleting rows", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("scheduled_task.delete"),
      { scheduledTaskId: "scheduled-task-1", reason: "User canceled it." },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    const scheduledTasks = tables.scheduled_task;
    expect(scheduledTasks).toHaveLength(2);
    expect(scheduledTasks?.[0]).toMatchObject({
      id: "scheduled-task-1",
      is_active: false,
      is_completed: true,
      cancelled_reason: "User canceled it.",
    });
  });

  it("executes memory.search for the runtime agent without a learning gate", async () => {
    tables.agent = [
      {
        id: agentId,
        workspace_id: workspaceId,
      },
    ];
    tables.memory_items = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: workspaceId,
        agent_id: null,
        content: "This repo uses pnpm for package scripts.",
        importance: 9,
        scope: "long_term",
        tags: {},
        source_run_id: null,
        source_task_id: null,
        event_time: "2026-04-25T00:00:00.000Z",
        is_deleted: false,
      },
    ];

    const result = await executeDatabaseTool(
      scheduledTaskTool("memory.search"),
      { query: "pnpm", limit: 20, importance_min: 1 },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      resultCount: 1,
      results: [
        {
          content: "This repo uses pnpm for package scripts.",
          importance: 9,
          scope: "long_term",
        },
      ],
    });
  });

  it("creates an agent-owned long-term memory for the runtime agent", async () => {
    tables.workspaces = [{ id: workspaceId, settings: {} }];
    tables.memory_items = [];

    const result = await executeDatabaseTool(
      scheduledTaskTool("memory.create"),
      {
        content: "Use pnpm validate before opening PRs.",
        tags: { source: "tool" },
        importance: 8,
      },
      { workspaceId, agentId, sessionId: "run-1" },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.output)).toMatchObject({
      memoryItem: {
        workspaceId,
        agentId,
        scope: "long_term",
        content: "Use pnpm validate before opening PRs.",
        importance: 8,
        sourceRunId: "run-1",
      },
    });
    expect(tables.memory_items).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        agent_id: agentId,
        scope: "long_term",
        content: "Use pnpm validate before opening PRs.",
        tags: { source: "tool" },
        importance: 8,
        source_run_id: "run-1",
      }),
    ]);
  });

  it("creates workspace-visible memory when requested", async () => {
    tables.workspaces = [{ id: workspaceId, settings: {} }];
    tables.memory_items = [];

    const result = await executeDatabaseTool(
      scheduledTaskTool("memory.create"),
      {
        content: "The workspace uses pnpm.",
        visibility: "workspace",
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(201);
    expect(tables.memory_items?.[0]).toMatchObject({
      workspace_id: workspaceId,
      agent_id: null,
      content: "The workspace uses pnpm.",
    });
  });

  it("appends examples to a tool assigned to the runtime agent", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("tool_examples.append"),
      {
        tool_slug: "repo.read_file",
        example: {
          when: "Need package metadata.",
          input: { path: "package.json" },
        },
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      appendedCount: 1,
      exampleCount: 2,
      tool: {
        id: "tool-repo-read",
        slug: "repo.read_file",
      },
    });
    expect(tables.tool?.[0]?.examples).toEqual([
      { input: { path: "README.md" } },
      { when: "Need package metadata.", input: { path: "package.json" } },
    ]);
  });

  it("creates draft skills for an agent in the runtime workspace", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("skill.create"),
      {
        agentId: targetAgentId,
        name: "debug-tool-failures",
        description: "Use when a tool call fails with a database or validation error.",
        body: "Inspect the tool schema, compare the attempted arguments, and preserve the exact error in the fix.",
      },
      { workspaceId, agentId, userId: "66666666-6666-4666-8666-666666666666", sessionId: "run-123" },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.output)).toMatchObject({
      skill: {
        agentId: targetAgentId,
        name: "debug-tool-failures",
        status: "draft",
        createdByAgentId: agentId,
        createdByUserId: "66666666-6666-4666-8666-666666666666",
        sourceRunId: "run-123",
      },
    });
    expect(tables.skill).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        agent_id: targetAgentId,
        name: "debug-tool-failures",
        status: "draft",
      }),
    ]);
  });

  it("rejects skill creation for agents outside the runtime workspace", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("skill.create"),
        {
          agentId: foreignAgentId,
          name: "foreign-skill",
          description: "Use somewhere else.",
          body: "Do not write cross-workspace skills.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_not_found",
    });
  });

  it("reports invalid skill.create arguments as tool argument errors", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("skill.create"),
        {
          agentId: targetAgentId,
          name: "Invalid Skill Name",
          description: "Use when invalid.",
          body: "Do not create this skill.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_tool_arguments",
    });
  });

  it("rejects tool example updates for tools not assigned to the runtime agent", async () => {
    tables.tool?.push({
      id: "tool-unassigned",
      workspace_id: null,
      slug: "repo.search",
      name: "Search",
      description: "Search files.",
      examples: [],
      parameters: {},
      function_name: "repo.search",
      execution_kind: "filesystem_read",
      runner_kind: "codex",
      enabled: true,
    });

    await expect(
      executeDatabaseTool(
        scheduledTaskTool("tool_examples.append"),
        {
          tool_slug: "repo.search",
          example: { input: { query: "ToolDefinition" } },
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "tool_not_assigned",
    });
  });

  it("rejects memory.create without runtime agent context", async () => {
    await expect(
      executeDatabaseTool(scheduledTaskTool("memory.create"), { content: "Remember this." }, { workspaceId }),
    ).rejects.toMatchObject({
      status: 400,
      code: "runtime_context_required",
    });
  });

  it("creates system-authored agent tool grants for planner remediation", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("agent_tool_grant.create"),
      {
        agentId: targetAgentId,
        toolSlug: "repo.read_file",
        reason: "operability signature tool:repo.read_file|error:tool_not_granted|agent:coding",
      },
      { workspaceId, agentId, sessionId: "grant-create-run" },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.output)).toMatchObject({
      grant: {
        agent_id: targetAgentId,
        workspace_id: workspaceId,
        tool_id: "tool-repo-read",
        mode: "include",
        source: "system",
        reason: "operability signature tool:repo.read_file|error:tool_not_granted|agent:coding",
        created_by_user_id: null,
      },
      tool: {
        slug: "repo.read_file",
      },
    });
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: targetAgentId,
          tool_id: "tool-repo-read",
          source: "system",
        }),
      ]),
    );
  });

  it("requires agent_tool_grant.update to target an existing grant", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("agent_tool_grant.update"),
        {
          agentId: targetAgentId,
          toolSlug: "repo.read_file",
          mode: "exclude",
          reason: "Reverse an incorrect grant.",
        },
        { workspaceId, agentId, sessionId: "grant-update-missing-run" },
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_tool_grant_not_found",
    });
  });

  it("backs off when create repeats the same system grant", async () => {
    tables.agent_tool_grant?.push({
      id: "grant-system-existing",
      agent_id: targetAgentId,
      workspace_id: workspaceId,
      tool_id: "tool-repo-read",
      mode: "include",
      source: "system",
      reason: "previous autonomous grant",
    });

    await expect(
      executeDatabaseTool(
        scheduledTaskTool("agent_tool_grant.create"),
        {
          agentId: targetAgentId,
          toolSlug: "repo.read_file",
          reason: "operability signature still recurs",
        },
        { workspaceId, agentId, sessionId: "grant-backoff-run" },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "system_tool_grant_backoff",
    });
  });

  it("caps autonomous grants per planner run", async () => {
    for (let index = 1; index <= 4; index += 1) {
      tables.tool?.push({
        id: `tool-cap-${index}`,
        workspace_id: null,
        slug: `cap.tool_${index}`,
        name: `Cap Tool ${index}`,
        description: "Cap test tool.",
        examples: [],
        parameters: {},
        function_name: `cap.tool_${index}`,
        execution_kind: "database",
        runner_kind: "planner",
        enabled: true,
      });
    }

    for (let index = 1; index <= 3; index += 1) {
      await expect(
        executeDatabaseTool(
          scheduledTaskTool("agent_tool_grant.create"),
          {
            agentId: targetAgentId,
            toolSlug: `cap.tool_${index}`,
            reason: `operability grant ${index}`,
          },
          { workspaceId, agentId, sessionId: "grant-cap-run" },
        ),
      ).resolves.toMatchObject({ status: 201 });
    }

    await expect(
      executeDatabaseTool(
        scheduledTaskTool("agent_tool_grant.create"),
        {
          agentId: targetAgentId,
          toolSlug: "cap.tool_4",
          reason: "operability grant 4",
        },
        { workspaceId, agentId, sessionId: "grant-cap-run" },
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "system_tool_grant_cap_exceeded",
    });
  });

  it("lists routing rules with fallback chains", async () => {
    const result = await executeDatabaseTool(scheduledTaskTool("routing_rule.list"), {}, { workspaceId, agentId });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      routingRules: [
        {
          id: "routing-rule-1",
          provider: "openai",
          model: "gpt-4.1",
          modelTierFloor: "any",
          fallbacks: [
            {
              provider: "anthropic",
              model: "claude-3-5-sonnet-latest",
              credentialRef: { type: "alias", value: "anthropic-default" },
            },
          ],
        },
      ],
    });
  });

  it("returns schema-unavailable errors for local model list tools before migrations exist", async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      is: vi.fn(() => query),
      order: vi.fn(() => query),
      then: vi.fn((onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
        Promise.resolve({
          data: null,
          error: { code: "PGRST205", message: "Could not find the table local_runtime_machine" },
        }).then(onfulfilled, onrejected),
      ),
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue({ from: vi.fn(() => query) } as never);

    await expect(
      executeDatabaseTool(scheduledTaskTool("local_model.list"), {}, { workspaceId, agentId }),
    ).rejects.toMatchObject({
      status: 503,
      code: "routing_tool_schema_unavailable",
      details: { context: "local_runtime_machine query" },
    });
  });

  it("rejects routing floor changes through the agent tool", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("routing_rule.update"),
        {
          routingRuleId: "routing-rule-1",
          modelTierFloor: "frontier",
          reason: "Raise quality bar.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "model_tier_floor_user_owned",
    });
    expect(tables.routing_rule_change).toEqual([]);
  });

  it("requires a reason for routing rule updates", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("routing_rule.update"),
        { routingRuleId: "routing-rule-1", provider: "anthropic", model: "claude-3-5-sonnet-latest" },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "missing_reason",
    });
  });

  it("rejects unknown provider/model links", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("routing_rule.update"),
        {
          routingRuleId: "routing-rule-1",
          fallbacks: [{ provider: "unknown_provider", model: "mystery-model" }],
          reason: "Try a newly observed model.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "unknown_model_in_fallback_chain",
    });
  });

  it("rejects self-brick routing updates", async () => {
    await expect(
      executeDatabaseTool(
        scheduledTaskTool("routing_rule.update"),
        {
          routingRuleId: "routing-rule-1",
          enabled: false,
          reason: "Disable myself.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "self_brick_update",
    });
  });

  it("rejects self-brick routing updates for agent_id match rows", async () => {
    tables.routing_rule_match = [
      {
        id: "routing-rule-match-1",
        workspace_id: workspaceId,
        rule_id: "routing-rule-1",
        kind: "agent_id",
        key: "id",
        value: agentId,
      },
    ];

    await expect(
      executeDatabaseTool(
        scheduledTaskTool("routing_rule.update"),
        {
          routingRuleId: "routing-rule-1",
          enabled: false,
          reason: "Disable myself.",
        },
        { workspaceId, agentId },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "self_brick_update",
    });
  });

  it("preserves credentials when updating only the primary model", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("routing_rule.update"),
      {
        routingRuleId: "routing-rule-1",
        model: "gpt-4.1-mini",
        reason: "Use a cheaper OpenAI model.",
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      routingRule: {
        provider: "openai",
        model: "gpt-4.1-mini",
        credentialRef: { type: "alias", value: "openai-default" },
      },
    });
    expect(tables.routing_rule?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
      credential_id: null,
      credential_alias: "openai-default",
    });
  });

  it("accepts a self-reroute to a valid primary and fallback chain and writes audit rows", async () => {
    const result = await executeDatabaseTool(
      scheduledTaskTool("routing_rule.update"),
      {
        routingRuleId: "routing-rule-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        credentialRef: { type: "alias", value: "anthropic-default" },
        fallbacks: [
          { provider: "openai", model: "gpt-4.1", credentialRef: { type: "alias", value: "openai-default" } },
        ],
        reason: "Anthropic has been more reliable for this workspace.",
      },
      { workspaceId, agentId },
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.output)).toMatchObject({
      routingRule: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        credentialRef: { type: "alias", value: "anthropic-default" },
        fallbacks: [{ provider: "openai", model: "gpt-4.1" }],
      },
    });
    expect(tables.routing_rule?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      credential_alias: "anthropic-default",
    });
    expect(tables.routing_rule_fallback).toEqual([
      expect.objectContaining({
        position: 0,
        provider: "openai",
        model: "gpt-4.1",
        credential_alias: "openai-default",
      }),
    ]);
    expect(tables.routing_rule_change).toEqual([
      expect.objectContaining({
        actor_agent_id: agentId,
        change_kind: "primary_model",
        reason: "Anthropic has been more reliable for this workspace.",
      }),
      expect.objectContaining({
        actor_agent_id: agentId,
        change_kind: "fallback_chain",
        reason: "Anthropic has been more reliable for this workspace.",
      }),
    ]);
  });
});
