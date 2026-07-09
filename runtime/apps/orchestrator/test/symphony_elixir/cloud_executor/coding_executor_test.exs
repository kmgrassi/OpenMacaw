defmodule SymphonyElixir.CloudExecutor.CodingExecutorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.CloudExecutor.CodingExecutor
  alias SymphonyElixir.PathSafety

  setup do
    root = Path.join(System.tmp_dir!(), "symphony-coding-executor-test-#{System.unique_integer([:positive])}")
    workspace = Path.join(root, "repo")
    File.mkdir_p!(workspace)
    {:ok, canonical_root} = PathSafety.canonicalize(root)
    {:ok, canonical_workspace} = PathSafety.canonicalize(workspace)

    on_exit(fn -> File.rm_rf(root) end)

    {:ok, root: canonical_root, workspace: canonical_workspace}
  end

  test "executes shell.exec and emits relay-shaped result frames", %{root: root, workspace: workspace} do
    assert {:ok, prepared} = CodingExecutor.prepare(%{"existing_workspace" => "repo"}, workspace_root: root)
    assert prepared.tool_workspace == workspace

    frames =
      capture_frames(fn emit ->
        CodingExecutor.execute_frame(
          %{
            "type" => "tool_execution_request",
            "schema_version" => "1",
            "correlation_id" => "corr-1",
            "tool_call_id" => "call-shell",
            "name" => "shell.exec",
            "arguments" => %{"argv" => ["sh", "-c", "pwd; echo err >&2"], "cwd" => "."}
          },
          prepared,
          emit
        )
      end)

    result = Enum.find(frames, &(&1["type"] == "tool_call_result"))
    assert result["correlation_id"] == "corr-1"
    assert result["tool_call_id"] == "call-shell"
    assert result["success"] == true
    assert String.trim(result["output"]["stdout"]) == workspace
    assert String.trim(result["output"]["stderr"]) == "err"
  end

  test "policy ask gates shell.exec before execution", %{root: root, workspace: workspace} do
    assert {:ok, prepared} = CodingExecutor.prepare(%{"existing_workspace" => "repo"}, workspace_root: root)

    frames =
      capture_frames(fn emit ->
        CodingExecutor.execute_frame(
          %{
            "type" => "tool_execution_request",
            "schema_version" => "1",
            "correlation_id" => "corr-policy",
            "tool_call_id" => "call-shell-policy",
            "name" => "shell.exec",
            "arguments" => %{"argv" => ["sh", "-c", "touch should-not-exist"], "cwd" => "."},
            "policies" => [
              %{
                "scope" => "session",
                "kind" => "ask_on_shell",
                "params" => %{},
                "enabled" => true
              }
            ]
          },
          prepared,
          emit
        )
      end)

    result = Enum.find(frames, &(&1["type"] == "tool_call_result"))
    assert result["success"] == false
    assert result["output"]["error_code"] == "policy_ask"
    assert result["output"]["approval_state"] == "requested"
    refute File.exists?(Path.join(workspace, "should-not-exist"))
  end

  test "applies patches inside the prepared workspace", %{root: root, workspace: workspace} do
    File.write!(Path.join(workspace, "message.txt"), "before\n")
    assert {:ok, prepared} = CodingExecutor.prepare(%{"existing_workspace" => "repo"}, workspace_root: root)

    frames =
      capture_frames(fn emit ->
        CodingExecutor.execute_frame(
          %{
            "type" => "tool_execution_request",
            "schema_version" => "1",
            "tool_call_id" => "call-patch",
            "name" => "apply_patch",
            "arguments" => %{
              "patch" => """
              *** Begin Patch
              *** Update File: message.txt
              @@
              -before
              +after
              *** End Patch
              """
            }
          },
          prepared,
          emit
        )
      end)

    result = Enum.find(frames, &(&1["type"] == "tool_call_result"))
    assert result["success"] == true
    assert File.read!(Path.join(workspace, "message.txt")) == "after\n"
  end

  test "rejects unsafe patch paths", %{root: root, workspace: workspace} do
    File.write!(Path.join(workspace, "message.txt"), "before\n")
    assert {:ok, prepared} = CodingExecutor.prepare(%{"existing_workspace" => "repo"}, workspace_root: root)

    frames =
      capture_frames(fn emit ->
        CodingExecutor.execute_frame(
          %{
            "type" => "tool_execution_request",
            "schema_version" => "1",
            "tool_call_id" => "call-patch",
            "name" => "apply_patch",
            "arguments" => %{
              "patch" => """
              *** Begin Patch
              *** Update File: ../escape.txt
              @@
              -before
              +after
              *** End Patch
              """
            }
          },
          prepared,
          emit
        )
      end)

    result = Enum.find(frames, &(&1["type"] == "tool_call_result"))
    assert result["success"] == false
    assert result["output"]["success"] == false
    refute File.exists?(Path.join(root, "escape.txt"))
  end

  test "cancels a running shell command through relay correlation id", %{root: root} do
    assert {:ok, prepared} = CodingExecutor.prepare(%{"existing_workspace" => "repo"}, workspace_root: root)

    frames =
      delayed_stream([
        Jason.encode!(%{
          "type" => "tool_execution_request",
          "schema_version" => "1",
          "correlation_id" => "corr-cancel",
          "tool_call_id" => "call-sleep",
          "name" => "shell.exec",
          "arguments" => %{"argv" => ["sh", "-c", "sleep 5"], "timeout_ms" => 10_000}
        }),
        Jason.encode!(%{"type" => "cancel", "schema_version" => "1", "correlation_id" => "corr-cancel"})
      ])

    emitted =
      capture_frames(fn emit ->
        CodingExecutor.run_loop(prepared, input: frames, output: emit)
      end)

    assert Enum.any?(emitted, &match?(%{"type" => "progress", "event" => "cancelled", "payload" => %{"command_id" => "call-sleep"}}, &1))

    result = Enum.find(emitted, &(&1["type"] == "tool_call_result" and &1["tool_call_id"] == "call-sleep"))
    assert result["success"] == false
    assert result["output"]["cancelled"] == true
  end

  test "rejects existing workspaces outside the workspace root", %{root: root} do
    assert {:error, %{"code" => "existing_workspace_denied"}} =
             CodingExecutor.prepare(%{"existing_workspace" => "../outside"}, workspace_root: root)
  end

  defp capture_frames(fun) do
    parent = self()
    fun.(fn frame -> send(parent, {:frame, frame}) end)
    drain_frames([])
  end

  defp drain_frames(frames) do
    receive do
      {:frame, frame} -> drain_frames([frame | frames])
    after
      0 -> Enum.reverse(frames)
    end
  end

  defp delayed_stream([first, second]) do
    Stream.resource(
      fn -> {0, [first, second]} end,
      fn
        {0, [line | rest]} ->
          {[line], {1, rest}}

        {1, [line | rest]} ->
          Process.sleep(250)
          {[line], {2, rest}}

        {_index, []} ->
          {:halt, nil}
      end,
      fn _state -> :ok end
    )
  end
end
