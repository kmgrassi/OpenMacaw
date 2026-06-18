defmodule SymphonyElixir.Planner.RepositoryReadToolsTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Codex.{DynamicTool, ToolPolicy}
  alias SymphonyElixir.Planner.{RepositoryReadTools, RepositoryTools}

  @runtime_settings %{
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: %{"type" => "workspaceWrite", "writableRoots" => ["/tmp/workspace"]}
  }

  test "defines stable repository-read tool names" do
    assert RepositoryReadTools.tool_names() == ["repo.list", "repo.search", "repo.read_file"]
    assert Enum.map(RepositoryReadTools.tool_specs(), & &1["name"]) == RepositoryReadTools.tool_names()
  end

  test "repo.list schema includes common repo inputs and bounded list output" do
    spec = tool_spec("repo.list")

    assert %{
             "inputSchema" => %{
               "additionalProperties" => false,
               "required" => ["workspace_id", "repo_id", "path"],
               "properties" => %{
                 "workspace_id" => %{"type" => "string"},
                 "repo_id" => %{"type" => "string"},
                 "path" => %{"type" => "string", "minLength" => 1},
                 "max_depth" => %{"maximum" => 10},
                 "limit" => %{"maximum" => 200}
               }
             },
             "outputLimits" => %{"defaultLimit" => 50, "maxEntries" => 200}
           } = spec
  end

  test "repo.search schema includes query, optional path prefix, and snippet limits" do
    spec = tool_spec("repo.search")

    assert %{
             "inputSchema" => %{
               "additionalProperties" => false,
               "required" => ["workspace_id", "repo_id", "query"],
               "properties" => %{
                 "workspace_id" => %{"type" => "string"},
                 "repo_id" => %{"type" => "string"},
                 "query" => %{"type" => "string"},
                 "path" => %{"type" => ["string", "null"]},
                 "limit" => %{"maximum" => 100}
               }
             },
             "outputLimits" => %{
               "defaultLimit" => 50,
               "maxResults" => 100,
               "maxSnippetBytes" => 4096
             }
           } = spec
  end

  test "repo.read_file schema includes bounded file output" do
    spec = tool_spec("repo.read_file")

    assert %{
             "inputSchema" => %{
               "additionalProperties" => false,
               "required" => ["workspace_id", "repo_id", "path"],
               "properties" => %{
                 "workspace_id" => %{"type" => "string"},
                 "repo_id" => %{"type" => "string"},
                 "path" => %{"type" => "string", "minLength" => 1},
                 "limit" => %{"maximum" => 65_536}
               }
             },
             "outputLimits" => %{"maxFileBytes" => 65_536}
           } = spec
  end

  test "schemas document path-safety rules" do
    assert RepositoryReadTools.safety_rules() == [
             "no_path_traversal",
             "no_symlink_escape",
             "stay_inside_workspace_or_repo_cache"
           ]

    for spec <- RepositoryReadTools.tool_specs() do
      assert spec["safetyRules"] == RepositoryReadTools.safety_rules()
      assert spec["description"] =~ "path traversal"
      assert spec["description"] =~ "symlink escapes"
    end
  end

  test "repository-read tools are exposed only through planner Codex tool policies" do
    contract_repo_tools = RepositoryReadTools.tool_names()
    runtime_repo_tools = RepositoryTools.tool_names()

    coding = ToolPolicy.resolve("coding", %{}, @runtime_settings)
    planning = ToolPolicy.resolve("planning", %{}, @runtime_settings)
    planning_with_mutation = ToolPolicy.resolve("planning", %{"planning" => %{"allow_workspace_mutation_tools" => true}}, @runtime_settings)

    assert coding.dynamic_tool_names -- runtime_repo_tools == coding.dynamic_tool_names
    assert DynamicTool.tool_specs() |> Enum.map(& &1["name"]) |> Enum.all?(&(&1 not in runtime_repo_tools))

    assert contract_repo_tools -- planning.dynamic_tool_names == []
    assert runtime_repo_tools -- planning.dynamic_tool_names == []
    assert runtime_repo_tools -- planning_with_mutation.dynamic_tool_names == []
    assert DynamicTool.planner_tool_specs() |> Enum.map(& &1["name"]) |> then(&(runtime_repo_tools -- &1 == []))
  end

  defp tool_spec(name) do
    Enum.find(RepositoryReadTools.tool_specs(), &(&1["name"] == name))
  end
end
