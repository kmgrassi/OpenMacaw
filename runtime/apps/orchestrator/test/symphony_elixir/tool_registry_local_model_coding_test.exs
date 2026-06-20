defmodule SymphonyElixir.ToolRegistryLocalModelCodingTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolRegistry

  setup do
    workspace_root =
      Path.join(System.tmp_dir!(), "tool-registry-coding-#{System.unique_integer([:positive])}")

    File.mkdir_p!(workspace_root)

    on_exit(fn -> File.rm_rf(workspace_root) end)

    %{workspace_root: workspace_root}
  end

  test "coding bundle resolves repo and local execution tools" do
    assert ToolRegistry.bundle(:coding) == [
             "skill.create",
             "scheduled_task.list",
             "repo.list",
             "repo.read_file",
             "repo.search",
             "shell.exec",
             "apply_patch",
             "git.run"
           ]
  end

  test "coding definitions expose provider-compatible schema keys" do
    definition = ToolRegistry.definitions(["shell.exec"]) |> List.first()

    assert definition["parameters_schema"]["required"] == ["argv"]
    assert definition["parameters"] == definition["parameters_schema"]
    assert definition["inputSchema"] == definition["parameters_schema"]
  end

  test "runs argv commands in a workspace cwd", %{workspace_root: workspace_root} do
    File.mkdir_p!(Path.join(workspace_root, "src"))
    File.write!(Path.join([workspace_root, "src", "hello.txt"]), "hello\n")

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "shell.exec",
               %{"argv" => ["cat", "hello.txt"], "cwd" => "src"},
               %{workspace_root: workspace_root},
               ToolRegistry.bundle(:coding)
             )

    assert result["tool"] == "shell.exec"
    assert result["status"] == "completed"
    assert result["exit_code"] == 0
    assert result["stdout"] == "hello\n"
    assert result["output_truncated"] == false
    assert result["workspace_root"] == workspace_root
  end

  test "reads bounded repository files from the workspace", %{workspace_root: workspace_root} do
    File.write!(Path.join(workspace_root, "README.md"), "hello world\n")

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "repo.read_file",
               %{"path" => "README.md", "byte_limit" => 5},
               %{workspace_root: workspace_root},
               ToolRegistry.bundle(:coding)
             )

    assert result["tool"] == "repo.read_file"
    assert result["path"] == "README.md"
    assert result["content"] == "hello"
    assert result["output"] == "hello"
    assert result["bytes_read"] == 5
    assert result["truncated"] == true
  end

  test "repo tools drop nil optional arguments before dispatch", %{workspace_root: workspace_root} do
    File.write!(Path.join(workspace_root, "README.md"), "hello world\n")

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "repo.read_file",
               %{"path" => "README.md", "byte_limit" => nil},
               %{workspace_root: workspace_root},
               ToolRegistry.bundle(:coding)
             )

    assert result["tool"] == "repo.read_file"
    assert result["content"] == "hello world\n"
    assert result["truncated"] == false
  end

  test "lists workspace entries through the repository tool", %{workspace_root: workspace_root} do
    File.mkdir_p!(Path.join(workspace_root, "lib"))
    File.write!(Path.join(workspace_root, "README.md"), "hello\n")

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "repo.list",
               %{"path" => ".", "limit" => 10, "max_depth" => 1},
               %{workspace_root: workspace_root},
               ToolRegistry.bundle(:coding)
             )

    decoded = Jason.decode!(result["output"])

    assert result["tool"] == "repo.list"
    assert result["path"] == "."
    assert decoded["path"] == "."
    assert Enum.any?(decoded["entries"], &(&1["path"] == "README.md" and &1["type"] == "regular"))
    assert Enum.any?(decoded["entries"], &(&1["path"] == "lib" and &1["type"] == "directory"))
  end

  test "searches workspace text through the repository tool", %{workspace_root: workspace_root} do
    File.write!(Path.join(workspace_root, "README.md"), "hello world\n")
    rg = write_fake_rg!(workspace_root)

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "repo.search",
               %{"query" => "hello", "limit" => 1},
               %{workspace_root: workspace_root, metadata: %{"rg_path" => rg}},
               ToolRegistry.bundle(:coding)
             )

    decoded = Jason.decode!(result["output"])

    assert result["tool"] == "repo.search"
    assert decoded["query"] == "hello"
    assert [%{"path" => "README.md"}] = decoded["matches"]
  end

  test "applies structured patches in the workspace", %{workspace_root: workspace_root} do
    patch = """
    *** Begin Patch
    *** Add File: lib/example.ex
    +defmodule Example, do: nil
    *** End Patch
    """

    assert {:ok, %{output: result}} =
             ToolRegistry.execute(
               "apply_patch",
               %{"patch" => patch},
               %{workspace_root: workspace_root},
               ToolRegistry.bundle(:coding)
             )

    assert File.read!(Path.join([workspace_root, "lib", "example.ex"])) == "defmodule Example, do: nil"

    assert result["success"] == true
    assert [%{"action" => "add", "path" => "lib/example.ex"}] = result["changes"]
  end

  test "rejects unsupported tools before execution", %{workspace_root: workspace_root} do
    assert {:error, :not_allowed} =
             ToolRegistry.execute("web_search", %{}, %{workspace_root: workspace_root}, ToolRegistry.bundle(:coding))
  end

  defp write_fake_rg!(root) do
    path = Path.join(root, "fake-rg")

    File.write!(
      path,
      """
      #!/bin/sh
      printf '%s\\n' '{"type":"match","data":{"path":{"text":"README.md"},"line_number":1,"submatches":[{"start":0}],"lines":{"text":"hello world\\n"}}}'
      """
    )

    File.chmod!(path, 0o755)
    path
  end
end
