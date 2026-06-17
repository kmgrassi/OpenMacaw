import { describe, expect, it } from "vitest";

import {
  accessToken,
  addToolOverrideToAgent,
  agentId,
  applyToolPolicyTemplateToAgent,
  assignToolToAgent,
  deleteAgentToolGrant,
  getAgentToolSettings,
  getResolvedToolsForAgent,
  getToolsForAgent,
  removeToolOverrideFromAgent,
  replaceAgentToolBundles,
  setAgentToolGrant,
  setupAgentToolsTest,
  tool,
  toolId,
  unassignToolFromAgent,
  userId,
  workspaceId,
} from "./agent-tools.test-support.js";

describe("agent tool grants", () => {
  const harness = setupAgentToolsTest();

  it("assigns a tool to an agent only once", async () => {
    await assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId });

    expect(harness.tables.agent_tool_grant).toHaveLength(1);
  });

  it("returns not found when unassigning a missing assignment", async () => {
    await expect(
      unassignToolFromAgent({
        accessToken,
        userId,
        agentId,
        toolId: "55555555-5555-4555-8555-555555555555",
        workspaceId,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "agent_tool_not_found",
    });
  });

  it("does not return disabled assigned tools", async () => {
    harness.tables.tool[0] = tool({ enabled: false });

    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([]);
  });

  it("prevents assigning disabled tool definitions", async () => {
    harness.tables.tool[0] = tool({ enabled: false });
    harness.tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "tool_disabled",
    });
  });

  it("loads tool settings from templates, grants, and visible tools", async () => {
    harness.tables.agent_tool_grant = [
      {
        id: "grant-include",
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    const settings = await getAgentToolSettings({ accessToken, userId, agentId, workspaceId });

    expect(settings.templates).toEqual([expect.objectContaining({ slug: "coding", name: "Coding" })]);
    expect(settings.availableTools).toEqual([expect.objectContaining({ id: toolId })]);
    expect(settings.grants).toEqual([
      expect.objectContaining({ agentId, toolId, workspaceId, mode: "include", source: "manual" }),
    ]);
    expect(settings.tools).toEqual([expect.objectContaining({ id: toolId, enabledForAgent: true, source: "manual" })]);
  });

  it("applies a template by writing include grants", async () => {
    harness.tables.agent_tool_grant = [];

    await applyToolPolicyTemplateToAgent({
      accessToken,
      userId,
      agentId,
      templateId: "55555555-5555-4555-8555-555555555555",
      workspaceId,
    });

    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "template",
        source_tool_template_id: "55555555-5555-4555-8555-555555555555",
      }),
    ]);
    expect(harness.tables.agent_tool).toHaveLength(1);
  });

  it("upserts manual include and exclude grants", async () => {
    await setAgentToolGrant({
      accessToken,
      userId,
      agentId,
      toolId,
      mode: "include",
      workspaceId,
    });
    await setAgentToolGrant({
      accessToken,
      userId,
      agentId,
      toolId,
      mode: "exclude",
      reason: "No file reads",
      workspaceId,
    });

    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "exclude",
        source: "manual",
        reason: "No file reads",
      }),
    ]);
  });

  it("deletes grants without writing legacy agent_tool rows", async () => {
    harness.tables.agent_tool_grant = [
      {
        id: "grant-1",
        agent_id: agentId,
        tool_id: toolId,
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    await deleteAgentToolGrant({ accessToken, userId, agentId, toolId, workspaceId });

    expect(harness.tables.agent_tool_grant).toEqual([]);
    expect(harness.tables.agent_tool).toHaveLength(1);
  });

  it("resolves bundles, included extras, and excluded bundle tools for an agent", async () => {
    harness.tables.agent = [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [":repo_read"] }];
    harness.tables.tool = [
      tool({
        id: "tool-read",
        slug: "repo.read_file",
        name: "Read File",
        function_name: "repo_read_file",
      }),
      tool({
        id: "tool-search",
        slug: "repo.search",
        name: "Search",
        function_name: "repo_search",
      }),
      tool({
        id: "tool-shell",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
      }),
    ];
    harness.tables.agent_tool_grant = [
      {
        id: "include-read",
        agent_id: agentId,
        tool_id: "tool-read",
        workspace_id: workspaceId,
        mode: "include",
        source: "template",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
      {
        id: "exclude-search",
        agent_id: agentId,
        tool_id: "tool-search",
        workspace_id: workspaceId,
        mode: "exclude",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
      {
        id: "include-shell",
        agent_id: agentId,
        tool_id: "tool-shell",
        workspace_id: workspaceId,
        mode: "include",
        source: "manual",
        source_tool_template_id: null,
        reason: null,
        created_by_user_id: userId,
      },
    ];

    const result = await getResolvedToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(result.bundles).toEqual([]);
    expect(
      result.tools.map((resolvedTool) => [resolvedTool.slug, resolvedTool.source, resolvedTool.enabledForAgent]),
    ).toEqual([
      ["repo.read_file", "include", true],
      ["repo.search", "exclude", false],
      ["shell.exec", "include", true],
    ]);
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({ slug: "repo.read_file" }),
      expect.objectContaining({ slug: "shell.exec" }),
    ]);
  });

  it("resolves effective grant rows for runtime dispatch", async () => {
    harness.tables.agent = [{ id: agentId, workspace_id: workspaceId, type: "coding", tool_bundles: [":repo_read"] }];
    harness.tables.tool = [
      tool({
        id: "tool-read",
        slug: "repo.read_file",
        name: "Read File",
        function_name: "repo_read_file",
      }),
      tool({
        id: "tool-shell",
        slug: "shell.exec",
        name: "Shell Exec",
        function_name: "shell_exec",
        execution_kind: "shell",
        runner_kind: "local_model_coding",
      }),
      tool({
        id: "tool-apply-patch",
        slug: "apply_patch",
        name: "Apply Patch",
        function_name: "apply_patch",
        execution_kind: "filesystem_write",
        runner_kind: "local_model_coding",
      }),
    ];
    harness.tables.agent_tool = [];
    harness.tables.agent_tool_grant = [
      {
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-shell",
        mode: "include",
        source: "template",
        source_tool_template_id: "template-local_model_coding",
      },
      {
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-apply-patch",
        mode: "include",
        source: "template",
        source_tool_template_id: "template-local_model_coding",
      },
    ];

    const result = await getResolvedToolsForAgent({ accessToken, userId, agentId, workspaceId });

    expect(result.bundles).toEqual([]);
    expect(
      result.tools.map((resolvedTool) => [
        resolvedTool.slug,
        resolvedTool.source,
        resolvedTool.enabledForAgent,
        resolvedTool.runnerKind,
      ]),
    ).toEqual([
      ["apply_patch", "include", true, "local_model_coding"],
      ["shell.exec", "include", true, "local_model_coding"],
    ]);
    await expect(getToolsForAgent({ accessToken, userId, agentId, workspaceId })).resolves.toEqual([
      expect.objectContaining({ slug: "apply_patch", runnerKind: "local_model_coding" }),
      expect.objectContaining({ slug: "shell.exec", runnerKind: "local_model_coding" }),
    ]);
  });

  it("adds and removes agent tool overrides by tool name", async () => {
    harness.tables.tool = [
      tool({
        id: "tool-custom",
        slug: "custom_tool",
        name: "Custom Tool",
        function_name: "custom_tool",
      }),
    ];
    harness.tables.agent_tool_grant = [];

    await addToolOverrideToAgent({
      accessToken,
      userId,
      agentId,
      toolName: "custom_tool",
      workspaceId,
    });
    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-custom",
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);

    await removeToolOverrideFromAgent({
      accessToken,
      userId,
      agentId,
      toolName: "Custom Tool",
      workspaceId,
    });
    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-custom",
        mode: "exclude",
        source: "manual",
      }),
    ]);
  });

  it("replaces agent tool bundles with the allowlisted bundle names", async () => {
    await replaceAgentToolBundles({
      accessToken,
      userId,
      agentId,
      workspaceId,
      bundles: [":repo_read", ":repo_write"],
    });

    expect(harness.tables.agent[0]).toEqual(
      expect.objectContaining({
        tool_bundles: [":repo_read", ":repo_write"],
      }),
    );
  });

  it("rejects unsupported agent tool bundles", async () => {
    await expect(
      replaceAgentToolBundles({
        accessToken,
        userId,
        agentId,
        workspaceId,
        bundles: [":repo_read", ":not_real" as ":repo_read"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_tool_bundle",
    });
  });
});
