import { describe, expect, it } from "vitest";

import {
  accessToken,
  agent,
  agentId,
  applyToolPolicyTemplateToAgent,
  assignToolToAgent,
  mockedFindSetupAgentById,
  setupAgentToolsTest,
  tool,
  toolId,
  userId,
  workspaceId,
} from "./agent-tools.test-support.js";

describe("agent local model coding tool grants", () => {
  const harness = setupAgentToolsTest();

  it("prevents assigning local coding tools until a workspace execution target is registered", async () => {
    harness.tables.tool[0] = tool({
      slug: "shell.exec",
      function_name: "shell_exec",
      execution_kind: "shell",
      runner_kind: "local_model_coding",
    });
    harness.tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "local_coding_execution_target_required",
    });
  });

  it("allows assigning local coding tools when a local execution target has a workspace root", async () => {
    harness.tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    harness.tables.agent_tool_grant = [];
    harness.tables.local_runtime_machine = [
      {
        id: "machine-1",
        workspace_id: workspaceId,
        revoked_at: null,
      },
    ];
    harness.tables.routing_rule = [
      {
        id: "rule-1",
        workspace_id: workspaceId,
        name: "local:qwen",
        runner_kind: "local_relay",
        enabled: true,
      },
    ];
    harness.tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_machine",
        key: "id",
        value: "machine-1",
      },
      {
        id: "match-2",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "apply_patch",
    });
    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("allows assigning local coding tools when the agent uses container execution", async () => {
    mockedFindSetupAgentById.mockResolvedValue(
      agent(workspaceId, {
        executionTarget: {
          kind: "container",
        },
      }),
    );
    harness.tables.tool[0] = tool({
      slug: "shell.exec",
      function_name: "shell_exec",
      execution_kind: "shell",
      runner_kind: "local_model_coding",
    });
    harness.tables.agent_tool_grant = [];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "shell.exec",
    });
    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });

  it("allows applying coding tool templates when the agent uses container execution", async () => {
    mockedFindSetupAgentById.mockResolvedValue(
      agent(workspaceId, {
        executionTarget: {
          kind: "container",
        },
      }),
    );
    harness.tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
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
        created_by_user_id: userId,
      }),
    ]);
  });

  it("rejects local coding tool assignment for local runtime rules with a workspace root but no machine match", async () => {
    harness.tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    harness.tables.agent_tool_grant = [];
    harness.tables.local_runtime_machine = [{ id: "machine-1", workspace_id: workspaceId, revoked_at: null }];
    harness.tables.routing_rule = [
      { id: "rule-1", workspace_id: workspaceId, name: "local:qwen", runner_kind: "local_relay", enabled: true },
    ];
    harness.tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).rejects.toMatchObject({
      status: 409,
      code: "local_coding_execution_target_required",
    });
  });

  it("allows local coding tool assignment when the routing rule references a non-first active machine", async () => {
    harness.tables.tool[0] = tool({
      slug: "apply_patch",
      function_name: "apply_patch",
      execution_kind: "filesystem_write",
      runner_kind: "local_model_coding",
    });
    harness.tables.agent_tool_grant = [];
    harness.tables.local_runtime_machine = [
      { id: "machine-other", workspace_id: workspaceId, revoked_at: null },
      { id: "machine-target", workspace_id: workspaceId, revoked_at: null },
    ];
    harness.tables.routing_rule = [
      { id: "rule-1", workspace_id: workspaceId, name: "local:qwen", runner_kind: "local_relay", enabled: true },
    ];
    harness.tables.routing_rule_match = [
      {
        id: "match-1",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_machine",
        key: "id",
        value: "machine-target",
      },
      {
        id: "match-2",
        workspace_id: workspaceId,
        rule_id: "rule-1",
        kind: "local_workspace_root",
        key: "path",
        value: "/Users/dev/project",
      },
    ];

    await expect(assignToolToAgent({ accessToken, userId, agentId, toolId, workspaceId })).resolves.toMatchObject({
      slug: "apply_patch",
    });
    expect(harness.tables.agent_tool_grant).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: toolId,
        mode: "include",
        source: "manual",
        created_by_user_id: userId,
      }),
    ]);
  });
});
