import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { reflectRunToMemories } from "./reflector.js";
import type * as SupabaseClientModule from "../../supabase-client.js";

vi.mock("../../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

const { getServiceRoleSupabase } = await import("../../supabase-client.js");

const sourceRunId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const sourceTaskId = "44444444-4444-4444-8444-444444444444";

function tables(): Record<string, Record<string, unknown>[]> {
  return {
    broker_run: [
      {
        run_id: sourceRunId,
        agent_id: agentId,
        workspace_id: workspaceId,
        input: {},
        output: {},
        metadata: {},
        completed_at: "2026-05-18T12:00:00.000Z",
        updated_at: "2026-05-18T12:00:00.000Z",
      },
    ],
    agent: [
      {
        id: agentId,
        workspace_id: workspaceId,
        model_settings: { primary: "openai/gpt-5.2" },
      },
    ],
    gateway_config: [],
    message: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        role: "user",
        content: "Always use the staging database for invoice tests.",
        payload: null,
        created_at: "2026-05-18T11:55:00.000Z",
        workspace_id: workspaceId,
        run_id: sourceRunId,
        is_deleted: false,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        role: "assistant",
        content: "I updated the invoice tests against staging fixtures.",
        payload: null,
        created_at: "2026-05-18T11:56:00.000Z",
        workspace_id: workspaceId,
        run_id: sourceRunId,
        is_deleted: false,
      },
    ],
    credential: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        workspace_id: workspaceId,
        kind: "openai",
        key_value: { provider: "openai", OPENAI_API_KEY: "sk-test" },
        updated_at: "2026-05-18T10:00:00.000Z",
      },
    ],
    agent_tool_call_event: [],
    memory_items: [],
  };
}

describe("reflectRunToMemories", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables()) as never);
  });

  it("turns a run transcript into bounded memory writes", async () => {
    const generateReflection = vi.fn(async () => ({
      memories: [
        {
          content: "Invoice tests must use the staging database fixtures.",
          importance: 8,
          tags: { topic: "invoice-tests" },
        },
      ],
    }));
    const createEmbedding = vi.fn(async () => "[0.1,0.2]");
    const insertMemory = vi.fn(async (request) => ({
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId: request.workspaceId,
      agentId: request.agentId ?? null,
      scope: request.scope,
      content: request.content,
      importance: request.importance,
      eventTime: request.eventTime ?? "2026-05-18T12:00:00.000Z",
      sourceRunId: request.sourceRunId ?? null,
      sourceTaskId: request.sourceTaskId ?? null,
      sourcePath: null,
      tags: request.tags ?? {},
      embedding: request.embedding ?? null,
      canonicalId: null,
      supersedesId: null,
      isDeleted: false,
      createdAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-18T12:00:00.000Z",
    }));

    const result = await reflectRunToMemories({
      sourceRunId,
      sourceTaskId,
      clients: { generateReflection, createEmbedding, insertMemory },
    });

    expect(result).toMatchObject({
      sourceRunId,
      workspaceId,
      agentId,
      candidatesGenerated: 1,
      memoriesWritten: 1,
      memoryIds: ["88888888-8888-4888-8888-888888888888"],
    });
    expect(generateReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.2",
        provider: "openai",
        apiKey: "sk-test",
        transcript: expect.stringContaining("Always use the staging database"),
      }),
    );
    expect(insertMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        agentId,
        scope: "run_summary",
        content: "Invoice tests must use the staging database fixtures.",
        importance: 8,
        sourceRunId,
        sourceTaskId,
        embedding: "[0.1,0.2]",
        tags: { topic: "invoice-tests", source: "learning_reflection" },
      }),
    );
  });

  it("feeds failed tool-call events into reflection as operability memories", async () => {
    const data = tables();
    data.agent_tool_call_event = [
      {
        id: "99999999-9999-4999-8999-999999999991",
        workspace_id: workspaceId,
        agent_id: agentId,
        run_id: sourceRunId,
        tool_slug: "scheduled_task.create",
        status: "failed",
        arguments: {
          title: "Follow up",
          due_at: "2026-05-19T12:00:00.000Z",
          assignee: { agent_id: agentId },
        },
        result: { details: { column: "due_at" } },
        output_summary: "Database rejected scheduled_task.create.",
        error_code: null,
        error_message: "Could not find the 'due_at' column of 'scheduled_task' in the schema cache",
        approval_state: "rejected",
        started_at: "2026-05-18T11:57:00.000Z",
      },
    ];
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(data) as never);

    const generateReflection = vi.fn(async () => ({
      memories: [
        ...Array.from({ length: 5 }, (_, index) => ({
          content: `General run fact ${index + 1}.`,
          importance: 4,
          tags: { topic: `general-${index + 1}` },
        })),
        {
          content:
            "scheduled_task.create failed because the agent sent a due_at argument, but scheduled_task has no due_at column.",
          importance: 9,
          tags: { kind: "operability", failure: "tool_call", tool_slug: "scheduled_task.create" },
        },
      ],
    }));
    const createEmbedding = vi.fn(async () => "[0.3,0.4]");
    const insertMemory = vi.fn(async (request) => ({
      id: "88888888-8888-4888-8888-888888888889",
      workspaceId: request.workspaceId,
      agentId: request.agentId ?? null,
      scope: request.scope,
      content: request.content,
      importance: request.importance,
      eventTime: request.eventTime ?? "2026-05-18T12:00:00.000Z",
      sourceRunId: request.sourceRunId ?? null,
      sourceTaskId: request.sourceTaskId ?? null,
      sourcePath: null,
      tags: request.tags ?? {},
      embedding: request.embedding ?? null,
      canonicalId: null,
      supersedesId: null,
      isDeleted: false,
      createdAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-18T12:00:00.000Z",
    }));

    const result = await reflectRunToMemories({
      sourceRunId,
      sourceTaskId,
      clients: { generateReflection, createEmbedding, insertMemory },
    });

    expect(result.memoriesWritten).toBe(6);
    expect(generateReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.stringContaining("STRUCTURED TOOL-CALL EVENTS"),
      }),
    );
    expect(generateReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.stringContaining("tool_slug: scheduled_task.create"),
      }),
    );
    expect(generateReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.stringContaining('"due_at":"string"'),
      }),
    );
    expect(generateReflection).not.toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: expect.stringContaining("2026-05-19T12:00:00.000Z"),
      }),
    );
    expect(insertMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          kind: "operability",
          failure: "tool_call",
          tool_slug: "scheduled_task.create",
          source: "learning_reflection",
        },
      }),
    );
  });

  it("skips runs with no transcript messages", async () => {
    const data = tables();
    data.message = [];
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(data) as never);
    const generateReflection = vi.fn();

    const result = await reflectRunToMemories({
      sourceRunId,
      clients: { generateReflection },
    });

    expect(result.memoriesWritten).toBe(0);
    expect(generateReflection).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace has no provider credential", async () => {
    const data = tables();
    data.credential = [];
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(data) as never);

    await expect(
      reflectRunToMemories({
        sourceRunId,
        clients: { generateReflection: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: "reflection_credential_missing",
    });
  });

  it("reuses existing run-summary memories on retry instead of regenerating duplicates", async () => {
    const existingMemoryId = "99999999-9999-4999-8999-999999999999";
    const data = tables();
    data.memory_items = [
      {
        id: existingMemoryId,
        workspace_id: workspaceId,
        agent_id: agentId,
        scope: "run_summary",
        content: "Invoice tests must use the staging database fixtures.",
        importance: 8,
        event_time: "2026-05-18T12:00:00.000Z",
        source_run_id: sourceRunId,
        source_task_id: sourceTaskId,
        source_path: null,
        tags: { topic: "invoice-tests", source: "learning_reflection" },
        embedding: "[0.1,0.2]",
        canonical_id: null,
        supersedes_id: null,
        is_deleted: false,
        created_at: "2026-05-18T12:00:00.000Z",
        updated_at: "2026-05-18T12:00:00.000Z",
      },
    ];
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(data) as never);

    const generateReflection = vi.fn();
    const createEmbedding = vi.fn();
    const insertMemory = vi.fn();

    const result = await reflectRunToMemories({
      sourceRunId,
      sourceTaskId,
      clients: { generateReflection, createEmbedding, insertMemory },
    });

    expect(result.memoryIds).toEqual([existingMemoryId]);
    expect(result.candidatesGenerated).toBe(1);
    expect(result.memoriesWritten).toBe(1);
    expect(generateReflection).not.toHaveBeenCalled();
    expect(createEmbedding).not.toHaveBeenCalled();
    expect(insertMemory).not.toHaveBeenCalled();
  });
});
