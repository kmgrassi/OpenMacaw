defmodule SymphonyElixir.Planner.RepositoryToolsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planner.RepositoryTools

  setup do
    root = Path.join(System.tmp_dir!(), "symphony-repo-tools-#{System.unique_integer([:positive])}")
    workspace = Path.join(root, "workspace-1")

    File.mkdir_p!(Path.join(workspace, "lib"))
    File.mkdir_p!(Path.join(workspace, "test"))
    File.write!(Path.join(workspace, "README.md"), "# Example\n")
    File.write!(Path.join(workspace, "lib/app.ex"), "defmodule App do\n  def hello, do: :world\nend\n")
    File.write!(Path.join(workspace, "test/app_test.exs"), "assert App.hello() == :world\n")
    File.write!(Path.join(workspace, ".env"), "TOKEN=secret\n")

    on_exit(fn -> File.rm_rf(root) end)

    %{root: root, workspace: workspace}
  end

  test "tool_specs advertises repository read contracts" do
    specs = RepositoryTools.tool_specs()

    assert Enum.map(specs, & &1["name"]) == ["repo.list", "repo.search", "repo.read_file", "repo.read_symbols"]

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id"],
               "properties" => %{"workspace_id" => _, "repo_id" => _, "repository_id" => _, "path" => _, "max_depth" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.list"))

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id", "query"],
               "properties" => %{"query" => _, "limit" => _, "snippet_chars" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.search"))

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id"],
               "properties" => %{"workspace_id" => _, "path" => _, "query" => _, "kinds" => _, "limit" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.read_symbols"))
  end

  test "repo.list returns bounded structured entries", %{root: root} do
    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.list",
               %{"workspace_id" => "workspace-1", "path" => ".", "max_depth" => 1, "limit" => 10},
               workspace_root: root
             )

    assert result["path"] == "."
    assert Enum.any?(result["entries"], &(&1["path"] == "README.md" and &1["type"] == "regular"))
    assert Enum.any?(result["entries"], &(&1["path"] == "lib" and &1["type"] == "directory"))
    assert Enum.any?(result["entries"], &(&1["path"] == ".env" and &1["type"] == "regular"))
  end

  test "repo.read_file enforces byte limits", %{root: root} do
    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.read_file",
               %{"workspace_id" => "workspace-1", "path" => "lib/app.ex", "byte_limit" => 12},
               workspace_root: root
             )

    assert result["path"] == "lib/app.ex"
    assert result["content"] == "defmodule Ap"
    assert result["bytes_read"] == 12
    assert result["truncated"] == true
  end

  test "repo.read_file returns an empty response for empty files", %{root: root, workspace: workspace} do
    File.write!(Path.join(workspace, "EMPTY"), "")

    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.read_file",
               %{"workspace_id" => "workspace-1", "path" => "EMPTY"},
               workspace_root: root
             )

    assert result["path"] == "EMPTY"
    assert result["content"] == ""
    assert result["bytes_read"] == 0
    assert result["truncated"] == false
  end

  test "repo.search uses ripgrep and returns line-numbered snippets", %{root: root} do
    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.search",
               %{"workspace_id" => "workspace-1", "query" => "hello", "limit" => 5},
               workspace_root: root
             )

    assert %{"path" => "lib/app.ex", "line" => 2, "column" => 7, "snippet" => snippet} =
             Enum.find(result["matches"], &(&1["path"] == "lib/app.ex"))

    assert snippet =~ "hello"
  end

  test "repo.search passes requested limit to ripgrep before collecting output", %{root: root} do
    rg =
      write_fake_rg!(root, """
      #!/bin/sh
      printf '%s\\n' "$@" > ../rg-args.txt
      printf '%s\\n' '{"type":"match","data":{"path":{"text":"lib/app.ex"},"line_number":2,"submatches":[{"start":6}],"lines":{"text":"  def hello, do: :world\\n"}}}'
      """)

    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.search",
               %{"workspace_id" => "workspace-1", "query" => "hello", "limit" => 7},
               workspace_root: root,
               rg_path: rg
             )

    assert [%{"path" => "lib/app.ex"}] = result["matches"]
    assert File.read!(Path.join(root, "rg-args.txt")) =~ "--max-count\n7\n"
  end

  test "repo.search emits a null column when ripgrep does not provide a submatch offset", %{root: root} do
    rg =
      write_fake_rg!(root, """
      #!/bin/sh
      printf '%s\\n' '{"type":"match","data":{"path":{"text":"lib/app.ex"},"line_number":2,"submatches":[],"lines":{"text":"  def hello, do: :world\\n"}}}'
      """)

    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.search",
               %{"workspace_id" => "workspace-1", "query" => "hello", "limit" => 1},
               workspace_root: root,
               rg_path: rg
             )

    assert [%{"path" => "lib/app.ex", "column" => nil}] = result["matches"]
  end

  test "path traversal is rejected", %{root: root} do
    assert {:error, {:invalid_path, :traversal, "../README.md"}} =
             RepositoryTools.execute(
               "repo.read_file",
               %{"workspace_id" => "workspace-1", "path" => "../README.md"},
               workspace_root: root
             )
  end

  test "symlink escapes cannot read outside the workspace", %{root: root, workspace: workspace} do
    outside = Path.join(root, "outside.txt")
    File.write!(outside, "outside")
    File.ln_s!(outside, Path.join(workspace, "outside-link.txt"))

    assert {:error, {:path_outside_workspace, _, _}} =
             RepositoryTools.execute(
               "repo.read_file",
               %{"workspace_id" => "workspace-1", "path" => "outside-link.txt"},
               workspace_root: root
             )
  end

  test "repo.list does not traverse symlinked directories", %{root: root, workspace: workspace} do
    outside = Path.join(root, "outside-dir")
    File.mkdir_p!(outside)
    File.write!(Path.join(outside, "leak.txt"), "outside")
    File.ln_s!(outside, Path.join(workspace, "outside-link"))

    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.list",
               %{"workspace_id" => "workspace-1", "path" => ".", "max_depth" => 2, "limit" => 20},
               workspace_root: root
             )

    assert Enum.any?(result["entries"], &(&1["path"] == "outside-link" and &1["type"] == "symlink"))
    refute Enum.any?(result["entries"], &(&1["path"] == "outside-link/leak.txt"))
  end

  test "secret-like files are readable", %{root: root} do
    assert {:ok, result} =
             RepositoryTools.execute(
               "repo.read_file",
               %{"workspace_id" => "workspace-1", "path" => ".env"},
               workspace_root: root
             )

    assert result["path"] == ".env"
    assert result["content"] == "TOKEN=secret\n"
  end

  defp write_fake_rg!(root, script) do
    path = Path.join(root, "fake-rg")
    File.write!(path, script)
    File.chmod!(path, 0o755)
    path
  end
end
