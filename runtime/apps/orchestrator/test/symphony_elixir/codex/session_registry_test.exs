defmodule SymphonyElixir.Codex.SessionRegistryTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.AppServerTestSupport

  alias SymphonyElixir.Codex.SessionRegistry

  setup do
    if Process.whereis(SessionRegistry) do
      Supervisor.terminate_child(SymphonyElixir.Supervisor, SessionRegistry)
      Supervisor.restart_child(SymphonyElixir.Supervisor, SessionRegistry)
    else
      start_supervised!(SessionRegistry)
    end

    :ok
  end

  test "keeps one app-server thread warm across API inputs" do
    with_test_root("symphony-elixir-codex-session-registry-reuse", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-1300")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-session.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-session.trace}"
      printf 'RUN\\n' >> "$trace_file"
      turn=0

      while IFS= read -r line; do
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/start"'*)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1300"}}}'
            ;;
          *'"method":"turn/start"'*)
            turn=$((turn + 1))
            printf '{"id":3,"result":{"turn":{"id":"turn-%s"}}}\\n' "$turn"
            printf '{"method":"turn/completed","params":{"turnId":"turn-%s"}}\\n' "$turn"
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      assert {:ok, %{session_id: session_id, thread_id: "thread-1300"}} =
               SessionRegistry.create_session(workspace, %{})

      assert {:ok, %{status: "running"}} =
               SessionRegistry.send_message(session_id, "first message", %{"identifier" => "MT-1300"})

      wait_until(fn ->
        trace_lines(trace_file)
        |> json_trace_payloads()
        |> Enum.count(&(&1["method"] == "turn/start")) == 1
      end)

      wait_until(fn ->
        case SessionRegistry.send_message(session_id, "second message", %{"identifier" => "MT-1300"}) do
          {:ok, _} -> true
          {:error, :turn_already_running} -> false
        end
      end)

      wait_until(fn ->
        trace_lines(trace_file)
        |> json_trace_payloads()
        |> Enum.count(&(&1["method"] == "turn/start")) == 2
      end)

      lines = trace_lines(trace_file)
      assert Enum.count(lines, &(&1 == "RUN")) == 1

      payloads = json_trace_payloads(lines)
      assert Enum.count(payloads, &(&1["method"] == "thread/start")) == 1
      assert Enum.count(payloads, &(&1["method"] == "turn/start")) == 2
    end)
  end

  test "interrupt sends turn interrupt to the active app-server turn" do
    with_test_root("symphony-elixir-codex-session-registry-interrupt", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-1301")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-session-interrupt.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-session-interrupt.trace}"

      while IFS= read -r line; do
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/start"'*)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1301"}}}'
            ;;
          *'"method":"turn/start"'*)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-1301"}}}'
            printf '%s\\n' '{"method":"turn/started","params":{"turn":{"id":"turn-1301"}}}'
            ;;
          *'"method":"turn/interrupt"'*)
            printf '%s\\n' '{"method":"turn/cancelled","params":{"turnId":"turn-1301"}}'
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      assert {:ok, %{session_id: session_id}} = SessionRegistry.create_session(workspace, %{})
      assert {:ok, _} = SessionRegistry.send_message(session_id, "long message", %{"identifier" => "MT-1301"})

      wait_until(fn ->
        case SessionRegistry.interrupt(session_id) do
          {:ok, _} -> true
          {:error, :no_active_turn} -> false
        end
      end)

      wait_until(fn ->
        trace_lines(trace_file)
        |> json_trace_payloads()
        |> Enum.any?(fn payload ->
          payload["method"] == "turn/interrupt" &&
            get_in(payload, ["params", "threadId"]) == "thread-1301" &&
            get_in(payload, ["params", "turnId"]) == "turn-1301"
        end)
      end)
    end)
  end

  defp wait_until(fun, attempts \\ 40)
  defp wait_until(_fun, 0), do: flunk("condition was not met before timeout")

  defp wait_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(50)
      wait_until(fun, attempts - 1)
    end
  end
end
