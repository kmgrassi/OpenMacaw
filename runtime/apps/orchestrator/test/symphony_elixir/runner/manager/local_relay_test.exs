defmodule SymphonyElixir.Runner.LlmToolRunner.LocalRelayTest do
  use SymphonyElixir.Runner.ManagerTestSupport

  alias SymphonyElixir.LocalRelay.Registry

  test "runs a local relay manager tool loop and sends tool outputs as continuation frames" do
    test_pid = self()
    helper = start_manager_relay_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:relay_snooze_patch, URI.decode_query(conn.query_string), Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1",
          on_message: fn message -> send(test_pid, {:manager_event, message}) end
        },
        nil
      )

    assert session.model_client == ModelClient.LocalRelay
    assert session.api_key == "local-runtime"

    # session.tool_specs is the source helper_executed_tool?/2 reads to decide
    # delegation, so git.run must be marked here (not only on the dispatch
    # frame) or the manager would silently run it in-orchestrator.
    git_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "git.run"))
    assert git_spec, "expected git.run in session.tool_specs"
    assert git_spec["execution_kind"] == "helper"

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"response_id" => correlation_id, "output_text" => "Snoozed from relay."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert is_binary(correlation_id)

    assert_received {:relay_dispatch,
                     %{
                       "type" => "dispatch",
                       "target_runner_kind" => "openai_compatible",
                       "provider" => "local",
                       "model" => "qwen",
                       "messages" => [
                         %{"role" => "system"},
                         %{"role" => "user", "content" => ~s({"due_tasks":[]})}
                       ],
                       "capability_requirements" => %{"runtime_managed_tools" => true},
                       "provider_tool_specs" => provider_tool_specs,
                       "tool_definitions" => tool_definitions
                     }}

    assert Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"])) ==
             Enum.map(tool_names(), &String.replace(&1, ".", "_"))

    # git.run is marked for helper-side execution so the relay helper runs
    # git/gh on the user's machine; other manager tools stay runtime-executed.
    git_tool = Enum.find(tool_definitions, &(Map.get(&1, "name") == "git.run"))
    assert git_tool, "expected git.run in manager tool_definitions"
    assert git_tool["execution_kind"] == "helper"

    assert_received {:relay_snooze_patch, %{"id" => "eq.work-1", "workspace_id" => "eq.workspace-1"}, %{"next_poll_at" => next_poll_at}}

    assert {:ok, _datetime, _offset} = DateTime.from_iso8601(next_poll_at)

    assert_received {:relay_continuation, continuation}

    assert %{
             "type" => "dispatch",
             "tool_outputs" => [
               %{
                 "type" => "function_call_output",
                 "call_id" => "call-1",
                 "output" => output
               }
             ],
             "messages" => [
               %{
                 "role" => "tool",
                 "tool_call_id" => "call-1",
                 "content" => tool_message_content
               }
             ]
           } = continuation

    assert tool_message_content == output

    assert %{"work_item_id" => "work-1", "next_poll_at" => _next_poll_at} = Jason.decode!(output)

    assert_received {:manager_event, %{event: :tool_call_completed}}

    assert_received {:manager_event, %{event: :notification, payload: %{"params" => %{"textDelta" => "Snoozed from relay."}}}}

    assert_received {:manager_event, %{event: :turn_completed, payload: %{"id" => ^correlation_id}}}

    assert :ok = Manager.stop_session(session)
  end

  test "treats local relay disconnect before continuation as retryable offline" do
    test_pid = self()
    helper = start_disconnect_before_continuation_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1"
        },
        nil
      )

    assert {:error, {:retryable, :local_runtime_offline}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{
               id: "work-1",
               identifier: "MAN-1",
               title: "Manage work"
             })

    assert_received {:relay_disconnected_before_continuation, _correlation_id}

    assert :ok = Manager.stop_session(session)
  end
end
