defmodule SymphonyElixir.ToolRegistryPlannerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolRegistry

  test "resolves planner database and repo read tools" do
    assert {:ok, SymphonyElixir.Planner.Tools.PlanCreate} = ToolRegistry.get("plan.create")

    assert {:ok, SymphonyElixir.Planner.Tools.AgentToolGrantCreate} =
             ToolRegistry.get("agent_tool_grant.create")

    assert {:ok, SymphonyElixir.Planner.Tools.RepoReadFile} = ToolRegistry.get("repo.read_file")

    assert "plan.create" in ToolRegistry.bundle(:planner)
    assert "agent_tool_grant.create" in ToolRegistry.bundle(:planner)
    assert "agent_tool_grant.update" in ToolRegistry.bundle(:planner)
    assert "snooze_work_item" in ToolRegistry.bundle(:planner)
    assert "workspace_settings.update_tracker_kind" in ToolRegistry.bundle(:planner)
    assert "workspace_settings.manage" in ToolRegistry.bundle(:planner)
    assert "workspace_settings.manage" in ToolRegistry.bundle(:universal)
    assert ToolRegistry.bundle(:repo_read) == ~w(repo.list repo.read_file repo.search repo.read_symbols)
  end

  test "executes registered planner tools with allowlist enforcement" do
    root = Path.join(System.tmp_dir!(), "tool-registry-planner-#{System.unique_integer([:positive])}")
    workspace_id = "workspace-1"
    workspace = Path.join(root, workspace_id)
    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "README.md"), "Planner registry\n")

    context = %{workspace_root: root}

    assert {:error, :not_allowed} =
             ToolRegistry.execute("repo.read_file", %{"workspace_id" => workspace_id, "path" => "README.md"}, context, [
               "repo.list"
             ])

    assert {:ok, %{output: %{"content" => "Planner registry\n", "path" => "README.md"}}} =
             ToolRegistry.execute("repo.read_file", %{"workspace_id" => workspace_id, "path" => "README.md"}, context, [
               "repo.read_file"
             ])
  end

  test "formats registered tool specs for providers" do
    assert [
             %{
               "type" => "function",
               "function" => %{
                 "name" => "repo.read_file",
                 "parameters" => %{"required" => ["workspace_id", "path"]}
               }
             }
           ] = ToolRegistry.provider_specs(["repo.read_file"], :openai_compatible)
  end

  test "exposes workspace tracker kind updates in planner runtime settings" do
    resolved = ToolRegistry.resolve_for_agent("planning", %{}, %{})

    assert "workspace_settings.update_tracker_kind" in resolved.dynamic_tool_names
  end
end
