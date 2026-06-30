defmodule SymphonyElixir.AppServerToolCallTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.AppServerTestSupport

  test "app server rejects unsupported dynamic tool calls without stalling" do
    with_test_root("symphony-elixir-app-server-tool-call", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-90")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-tool-call.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-tool-call.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-90"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-90"}}}'
            printf '%s\\n' '{"id":101,"method":"item/tool/call","params":{"tool":"some_tool","callId":"call-90","threadId":"thread-90","turnId":"turn-90","arguments":{}}}'
            ;;
          5)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-tool-call",
          "MT-90",
          "Unsupported tool call",
          "Ensure unsupported tool calls do not stall a turn"
        )

      assert {:ok, _result} = AppServer.run(workspace, "Reject unsupported tool calls", issue)

      trace_lines(trace_file)
      |> assert_json_trace(fn payload ->
        payload["id"] == 101 and
          get_in(payload, ["result", "success"]) == false and
          String.contains?(get_in(payload, ["result", "output"]), "Unsupported dynamic tool")
      end)
    end)
  end

  test "app server executes supported dynamic tool calls and returns the tool result" do
    with_test_root("symphony-elixir-app-server-supported-tool-call", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-90A")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-supported-tool-call.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-supported-tool-call.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-90a"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-90a"}}}'
            printf '%s\\n' '{"id":102,"method":"item/tool/call","params":{"name":"linear_graphql","callId":"call-90a","threadId":"thread-90a","turnId":"turn-90a","arguments":{"query":"query Viewer { viewer { id } }","variables":{"includeTeams":false}}}}'
            ;;
          5)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-supported-tool-call",
          "MT-90A",
          "Supported tool call",
          "Ensure supported tool calls return tool output"
        )

      test_pid = self()

      tool_executor = fn tool, arguments ->
        send(test_pid, {:tool_called, tool, arguments})

        %{
          "success" => true,
          "contentItems" => [
            %{
              "type" => "inputText",
              "text" => ~s({"data":{"viewer":{"id":"usr_123"}}})
            }
          ]
        }
      end

      assert {:ok, _result} =
               AppServer.run(workspace, "Handle supported tool calls", issue, tool_executor: tool_executor)

      assert_received {:tool_called, "linear_graphql",
                       %{
                         "query" => "query Viewer { viewer { id } }",
                         "variables" => %{"includeTeams" => false}
                       }}

      trace_lines(trace_file)
      |> assert_json_trace(fn payload ->
        payload["id"] == 102 and
          get_in(payload, ["result", "success"]) == true and
          get_in(payload, ["result", "output"]) == ~s({"data":{"viewer":{"id":"usr_123"}}})
      end)
    end)
  end

  test "app server emits tool_call_failed for supported tool failures" do
    with_test_root("symphony-elixir-app-server-tool-call-failed", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-90B")
      codex_binary = Path.join(test_root, "fake-codex")
      trace_file = Path.join(test_root, "codex-tool-call-failed.trace")

      put_env_for_test("SYMP_TEST_CODEx_TRACE", trace_file)
      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh
      trace_file="${SYMP_TEST_CODEx_TRACE:-/tmp/codex-tool-call-failed.trace}"
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        printf 'JSON:%s\\n' "$line" >> "$trace_file"

        case "$count" in
          1)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          2)
            ;;
          3)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-90b"}}}'
            ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-90b"}}}'
            printf '%s\\n' '{"id":103,"method":"item/tool/call","params":{"tool":"linear_graphql","callId":"call-90b","threadId":"thread-90b","turnId":"turn-90b","arguments":{"query":"query Viewer { viewer { id } }"}}}'
            ;;
          5)
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      issue =
        issue(
          "issue-tool-call-failed",
          "MT-90B",
          "Tool call failed",
          "Ensure supported tool failures emit a distinct event"
        )

      test_pid = self()

      tool_executor = fn tool, arguments ->
        send(test_pid, {:tool_called, tool, arguments})

        %{
          "success" => false,
          "contentItems" => [
            %{
              "type" => "inputText",
              "text" => ~s({"error":{"message":"boom"}})
            }
          ]
        }
      end

      on_message = fn message -> send(test_pid, {:app_server_message, message}) end

      assert {:ok, _result} =
               AppServer.run(workspace, "Handle failed tool calls", issue,
                 on_message: on_message,
                 tool_executor: tool_executor
               )

      assert_received {:tool_called, "linear_graphql", %{"query" => "query Viewer { viewer { id } }"}}

      assert_received {:app_server_message, %{event: :tool_call_started, payload: %{"params" => %{"tool" => "linear_graphql"}}}}

      assert_received {:app_server_message,
                       %{
                         event: :tool_call_failed,
                         payload: %{"params" => %{"tool" => "linear_graphql"}},
                         result: %{"success" => false}
                       }}
    end)
  end
end
