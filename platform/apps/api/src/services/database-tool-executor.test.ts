import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { executeDatabaseTool } from "./database-tool-executor.js";
import type { ToolDefinition } from "./tool-spec-translator.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
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
        { id: foreignAgentId, workspace_id: "foreign-workspace" },
      ],
      tool: [
        {
          id: "tool-repo-read",
          workspace_id: null,
          slug: "repo.read_file",
          name: "Read File",
          examples: [{ input: { path: "README.md" } }],
        },
        {
          id: "foreign-tool",
          workspace_id: "foreign-workspace",
          slug: "foreign.tool",
          name: "Foreign Tool",
          examples: [],
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

  it("executes memory.search only when learning is enabled for the runtime agent", async () => {
    tables.agent = [
      {
        id: agentId,
        workspace_id: workspaceId,
      },
    ];
    tables.workspaces = [{ id: workspaceId, settings: { learning: { enabled: true } } }];
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

  it("rejects tool example updates for tools not assigned to the runtime agent", async () => {
    tables.tool?.push({
      id: "tool-unassigned",
      workspace_id: null,
      slug: "repo.search",
      name: "Search",
      examples: [],
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

  it("rejects memory.search when learning is disabled", async () => {
    tables.agent = [{ id: agentId, workspace_id: workspaceId, tool_policy: { learning: { enabled: true } } }];
    tables.workspaces = [{ id: workspaceId, settings: { learning: { enabled: false } } }];

    await expect(
      executeDatabaseTool(scheduledTaskTool("memory.search"), { query: "pnpm" }, { workspaceId, agentId }),
    ).rejects.toMatchObject({
      status: 403,
      code: "learning_disabled",
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
