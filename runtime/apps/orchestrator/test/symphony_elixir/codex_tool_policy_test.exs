defmodule SymphonyElixir.Codex.ToolPolicyTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Codex.ToolPolicy

  @runtime_settings %{
    approval_policy: "on-request",
    model: nil,
    model_provider: nil,
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: %{"type" => "workspaceWrite", "writableRoots" => ["/tmp/workspace"]}
  }

  @repo_read_tools ["repo.list", "repo.search", "repo.read_file", "repo.read_symbols"]
  @plan_task_tools [
    "plan.create",
    "plan.update",
    "plan.delete",
    "delegate",
    "task.create",
    "task.update",
    "task.schedule",
    "agent_tool_grant.create",
    "agent_tool_grant.update",
    "skill.create",
    "scheduled_task.create",
    "scheduled_task.read",
    "scheduled_task.update",
    "scheduled_task.list",
    "scheduled_task.delete",
    "plan.read",
    "task.read",
    "task.status"
  ]
  @planning_profile_tools ["planning_profile.create_update", "planning_profile.delete"]
  @workspace_settings_tools ["workspace_settings.manage", "workspace_settings.update_tracker_kind"]
  @agent_communication_tools ["agent.message", "agent.remediate"]
  @universal_tools ["snooze_work_item"]

  test "normalizes missing and empty agent kinds to coding" do
    assert ToolPolicy.normalize_agent_kind(nil) == "coding"
    assert ToolPolicy.normalize_agent_kind("") == "coding"
    assert ToolPolicy.coding?(nil)
  end

  test "coding agents keep the current dynamic tool profile and sandbox" do
    resolved = ToolPolicy.resolve("coding", %{}, @runtime_settings)

    assert resolved.agent_kind == "coding"
    assert resolved.dynamic_tool_names == ["linear_graphql", "snooze_work_item"]
    assert resolved.thread_sandbox == "workspace-write"

    assert resolved.turn_sandbox_policy == %{
             "type" => "workspaceWrite",
             "writableRoots" => ["/tmp/workspace"]
           }
  end

  test "custom agents keep the current dynamic tool profile and sandbox" do
    resolved = ToolPolicy.resolve("custom", %{}, @runtime_settings)

    assert resolved.agent_kind == "custom"
    assert resolved.dynamic_tool_names == ["linear_graphql", "snooze_work_item"]
    assert resolved.thread_sandbox == "workspace-write"
    assert resolved.turn_sandbox_policy == %{"type" => "workspaceWrite", "writableRoots" => ["/tmp/workspace"]}
  end

  test "planning agents get repo-read plus plan/task tools and read-only mutation posture by default" do
    resolved = ToolPolicy.resolve("planning", %{}, @runtime_settings)

    assert resolved.agent_kind == "planning"

    assert resolved.dynamic_tool_names ==
             @repo_read_tools ++ @plan_task_tools ++ @planning_profile_tools ++ @workspace_settings_tools ++ @universal_tools

    refute "linear_graphql" in resolved.dynamic_tool_names
    refute "agent.remediate" in resolved.dynamic_tool_names
    assert resolved.thread_sandbox == "read-only"
    assert resolved.turn_sandbox_policy == %{"type" => "readOnly", "networkAccess" => false}
  end

  test "planning dynamic tools are deterministic and isolated from coding tools" do
    first = ToolPolicy.resolve("planning", %{}, @runtime_settings)
    second = ToolPolicy.resolve("planning", %{}, @runtime_settings)

    assert first.dynamic_tool_names == second.dynamic_tool_names
    assert first.dynamic_tool_specs == second.dynamic_tool_specs
    refute "linear_graphql" in first.dynamic_tool_names
  end

  test "planning tool policy can explicitly keep workspace mutation tools enabled" do
    resolved =
      ToolPolicy.resolve(
        "planning",
        %{"planning" => %{"allow_workspace_mutation_tools" => true}},
        @runtime_settings
      )

    assert resolved.dynamic_tool_names ==
             @repo_read_tools ++ @plan_task_tools ++ @planning_profile_tools ++ @workspace_settings_tools ++ @universal_tools

    assert resolved.thread_sandbox == "workspace-write"

    assert resolved.turn_sandbox_policy == %{
             "type" => "workspaceWrite",
             "writableRoots" => ["/tmp/workspace"]
           }
  end

  test "planning agent control tools require explicit policy opt-in" do
    resolved =
      ToolPolicy.resolve(
        "planning",
        %{"planning" => %{"allow_agent_control_tools" => true}},
        @runtime_settings
      )

    assert resolved.dynamic_tool_names ==
             @repo_read_tools ++
               @plan_task_tools ++ @planning_profile_tools ++ @workspace_settings_tools ++ @universal_tools ++ @agent_communication_tools
  end

  test "planning-specific mutation policy overrides legacy top-level allow flag" do
    resolved =
      ToolPolicy.resolve(
        "planning",
        %{
          "allow_workspace_mutation_tools" => true,
          "planning" => %{"allow_workspace_mutation_tools" => false}
        },
        @runtime_settings
      )

    assert resolved.thread_sandbox == "read-only"
    assert resolved.turn_sandbox_policy == %{"type" => "readOnly", "networkAccess" => false}
  end
end
