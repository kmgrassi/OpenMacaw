import { describe, expect, it } from "vitest";

import {
  accessToken,
  agentId,
  appendToolExamples,
  createTool,
  listTools,
  mockedGetServiceRoleSupabase,
  setupAgentToolsTest,
  tool,
  toolId,
  updateTool,
  userId,
  workspaceId,
  getToolsForAgent,
} from "./agent-tools.test-support.js";

describe("agent tool definitions", () => {
  const harness = setupAgentToolsTest();

  it("loads tools assigned to an authorized agent", async () => {
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({ slug: "memory.create" }),
      expect.objectContaining({ slug: "memory.search" }),
      expect.objectContaining({
        id: toolId,
        slug: "read_file",
        parameters: expect.objectContaining({ type: "object" }),
        executionKind: "filesystem_read",
        runnerKind: "local_relay",
      }),
    ]);
  });

  it("creates a new tool definition with validated parameters", async () => {
    const created = await createTool({
      userId,
      request: {
        workspaceId,
        slug: "run_tests",
        name: "Run Tests",
        description: "Run the test suite",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        executionKind: "shell",
        runnerKind: "local_relay",
      },
    });

    expect(created).toMatchObject({ slug: "run_tests", executionKind: "shell" });
    expect(harness.tables.tool).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "run_tests",
          workspace_id: workspaceId,
          created_by_user_id: userId,
          execution_kind: "shell",
          runner_kind: "local_relay",
        }),
      ]),
    );
  });

  it("appends loose examples to a visible tool definition", async () => {
    harness.tables.tool[0] = tool({
      examples: [{ input: { path: "README.md" } }],
    });

    const updated = await appendToolExamples({
      userId,
      toolId,
      request: {
        workspaceId,
        examples: [{ input: { path: "package.json" }, note: "Inspect dependencies." }],
      },
    });

    expect(updated.examples).toEqual([
      { input: { path: "README.md" } },
      { input: { path: "package.json" }, note: "Inspect dependencies." },
    ]);
    expect(harness.tables.tool[0]).toEqual(
      expect.objectContaining({
        examples: [
          { input: { path: "README.md" } },
          { input: { path: "package.json" }, note: "Inspect dependencies." },
        ],
      }),
    );
  });

  it("rejects invalid JSON Schema parameter shapes", async () => {
    await expect(
      createTool({
        userId,
        request: {
          workspaceId,
          slug: "bad_tool",
          name: "Bad Tool",
          description: "",
          parameters: { type: "definitely-not-json-schema" },
          executionKind: null,
          runnerKind: null,
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_parameters_schema",
    });
  });

  it("maps duplicate slug database failures through the Supabase error path", async () => {
    mockedGetServiceRoleSupabase.mockReturnValue({
      from: () => ({
        insert: () => ({
          select: async () => ({
            data: null,
            error: {
              message: "duplicate key value violates unique constraint",
              code: "23505",
              details: null,
              hint: null,
              name: "PostgrestError",
            },
          }),
        }),
      }),
    } as never);

    await expect(
      createTool({
        userId,
        request: {
          workspaceId,
          slug: "read_file",
          name: "Read File",
          description: "",
          parameters: {},
          executionKind: null,
          runnerKind: null,
        },
      }),
    ).rejects.toThrow("duplicate key value violates unique constraint");
  });

  it("returns not found when updating a missing tool", async () => {
    await expect(
      updateTool({
        userId,
        toolId: "55555555-5555-4555-8555-555555555555",
        request: {
          workspaceId,
          name: "Missing",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });
  });

  it("does not list tools scoped to a different workspace", async () => {
    harness.tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        slug: "workspace_tool",
      }),
    );

    const tools = await getToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(tools.map((visibleTool) => visibleTool.slug)).toEqual(["memory.create", "memory.search", "read_file"]);
  });

  it("lists only global and requested-workspace tool definitions", async () => {
    harness.tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: workspaceId,
        slug: "workspace_tool",
      }),
    );

    const tools = await listTools({ userId, workspaceId });

    expect(tools.map((visibleTool) => visibleTool.slug)).toEqual(["read_file", "workspace_tool"]);
  });

  it("lists seeded local model coding tools with their runtime-owned runner kind", async () => {
    harness.tables.tool = [
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
        execution_kind: "shell",
        runner_kind: "local_model_coding",
        parameters: { type: "object", required: ["argv"] },
      }),
      tool({
        id: "66666666-6666-4666-8666-666666666666",
        slug: "apply_patch",
        name: "Apply Patch",
        function_name: "apply_patch",
        execution_kind: "filesystem_write",
        runner_kind: "local_model_coding",
        parameters: { type: "object", required: ["patch"] },
      }),
    ];

    const tools = await listTools({ userId, workspaceId });

    expect(tools).toEqual([
      expect.objectContaining({
        slug: "apply_patch",
        executionKind: "filesystem_write",
        runnerKind: "local_model_coding",
        enabled: true,
      }),
      expect.objectContaining({
        slug: "shell.exec",
        executionKind: "shell",
        runnerKind: "local_model_coding",
        enabled: true,
      }),
    ]);
  });

  it("prevents updates to global or cross-workspace tool definitions", async () => {
    await expect(
      updateTool({
        userId,
        toolId,
        request: {
          workspaceId,
          name: "Renamed Global Tool",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });

    harness.tables.tool.push(
      tool({
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "99999999-9999-4999-8999-999999999999",
        slug: "other_workspace_tool",
      }),
    );

    await expect(
      updateTool({
        userId,
        toolId: "55555555-5555-4555-8555-555555555555",
        request: {
          workspaceId,
          name: "Renamed Other Workspace Tool",
        },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });
  });
});
