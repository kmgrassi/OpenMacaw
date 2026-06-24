defmodule SymphonyElixir.Runner.LlmToolRunner.LocalRelayTest do
  use SymphonyElixir.Runner.ManagerTestSupport

  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.ToolRegistry

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
          "agent_context" => "Always check the repo before answering.",
          on_message: fn message -> send(test_pid, {:manager_event, message}) end
        },
        nil
      )

    assert session.model_client == ModelClient.LocalRelay
    assert session.api_key == "local-runtime"

    # No-grants manager/local-relay fallback must not expose broad local
    # git/gh execution. git.run is still available when platform-supplied
    # tool_definitions explicitly include it.
    git_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "git.run"))
    refute git_spec, "did not expect git.run in fallback session.tool_specs"

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
                         %{"role" => "system", "content" => system_prompt},
                         %{"role" => "user", "content" => ~s({"due_tasks":[]})}
                       ],
                       "capability_requirements" => %{"runtime_managed_tools" => true},
                       "provider_tool_specs" => provider_tool_specs,
                       "tool_definitions" => tool_definitions
                     }}

    assert system_prompt =~ "manager agent"
    assert system_prompt =~ "Agent instructions:\nAlways check the repo before answering."

    assert Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"])) ==
             tool_names()
             |> Enum.reject(&(&1 == "git.run"))
             |> Enum.map(&String.replace(&1, ".", "_"))

    git_tool = Enum.find(tool_definitions, &(Map.get(&1, "name") == "git.run"))
    refute git_tool, "did not expect git.run in fallback manager tool_definitions"

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

  test "keeps explicitly supplied manager local relay git.run helper-executed" do
    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1",
          "tool_definitions" => ToolRegistry.definitions(["snooze", "git.run"])
        },
        nil
      )

    assert session.allowed_tools == ["snooze", "git.run"]

    git_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "git.run"))
    assert git_spec, "expected explicitly supplied git.run in session.tool_specs"
    assert git_spec["execution_kind"] == "helper"

    snooze_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "snooze"))
    assert snooze_spec
    refute Map.get(snooze_spec, "execution_kind") == "helper"

    assert :ok = Manager.stop_session(session)
  end

  test "keeps explicitly supplied manager local relay shell.exec helper-executed" do
    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1",
          "tool_definitions" => ToolRegistry.definitions(["snooze", "shell.exec"])
        },
        nil
      )

    assert session.allowed_tools == ["snooze", "shell.exec"]

    shell_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "shell.exec"))
    assert shell_spec, "expected explicitly supplied shell.exec in session.tool_specs"
    assert shell_spec["execution_kind"] == "helper"

    snooze_spec = Enum.find(session.tool_specs, &(Map.get(&1, "name") == "snooze"))
    assert snooze_spec
    refute Map.get(snooze_spec, "execution_kind") == "helper"

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
