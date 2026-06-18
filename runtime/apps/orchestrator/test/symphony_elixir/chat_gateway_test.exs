defmodule SymphonyElixir.ChatGatewayTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ChatGateway
  alias SymphonyElixir.Gateway.SessionStore

  defmodule FakeRunner do
    def run(agent, scope, prompt, run_id, owner_pid) do
      text = if String.contains?(prompt, "second"), do: "Second", else: "Done"

      send(owner_pid, {:fake_runner_workflow, SymphonyElixir.Launcher.ConfigRegistry.get(self())})
      send(owner_pid, {:fake_runner_trace_id, Process.get(:symphony_trace_id)})
      send(owner_pid, {:fake_runner_agent, agent.id})
      send(owner_pid, {:fake_runner_prompt, prompt})

      send(owner_pid, {
        :gateway_runner_event,
        scope.session_key,
        run_id,
        %{event: :notification, payload: %{"params" => %{"textDelta" => text}}}
      })

      send(owner_pid, {
        :gateway_runner_event,
        scope.session_key,
        run_id,
        %{event: :turn_completed, payload: %{"id" => "resp-1", "usage" => %{"input_tokens" => 2}}}
      })

      send(
        owner_pid,
        {:gateway_runner_complete, scope.session_key, run_id, {:ok, %{"output_text" => "fallback", "model" => "gpt-test", "provider" => "openai"}}}
      )

      :ok
    end
  end

  defmodule SlowRunner do
    def run(_agent, scope, _prompt, run_id, owner_pid) do
      Process.sleep(100)

      send(
        owner_pid,
        {:gateway_runner_complete, scope.session_key, run_id, {:ok, %{"output_text" => "too late", "model" => "gpt-test", "provider" => "openai"}}}
      )
    end
  end

  defmodule ToolRunner do
    def run(_agent, scope, _prompt, run_id, owner_pid) do
      send(owner_pid, {
        :gateway_runner_event,
        scope.session_key,
        run_id,
        %{
          event: :tool_call_started,
          payload: %{
            "params" => %{
              "tool" => "task.create",
              "callId" => "call-1",
              "arguments" => %{"title" => "Verify"}
            }
          },
          details: %{"arguments" => %{"title" => "Verify"}}
        }
      })

      send(owner_pid, {
        :gateway_runner_event,
        scope.session_key,
        run_id,
        %{
          event: :tool_call_completed,
          payload: %{"params" => %{"tool" => "task.create", "callId" => "call-1"}},
          details: %{"success" => true, "output" => Jason.encode!(%{"id" => "task-1"})}
        }
      })

      send(owner_pid, {
        :gateway_runner_event,
        scope.session_key,
        run_id,
        %{event: :notification, payload: %{"params" => %{"textDelta" => "Created"}}}
      })

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, %{"model" => "gpt-test", "provider" => "openai"}}})
      :ok
    end
  end

  defmodule FakeMessageLog do
    def upsert_session_thread(scope, opts) do
      send(owner(), {:message_log_thread, scope, opts})
      {:ok, "thread-1"}
    end

    def record_user_message(scope, session_thread_id, content, opts) do
      send(owner(), {:message_log_user_message, scope, session_thread_id, content, opts})
      :ok
    end

    def record_assistant_message(scope, session_thread_id, content, run_id, metadata, opts \\ []) do
      send(owner(), {:message_log_assistant_message, scope, session_thread_id, content, run_id, metadata, opts})
      :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :chat_gateway_test_owner)
  end

  defmodule AgentInventoryStub do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents, do: {:ok, []}

    def get_agent(agent_id) do
      {:ok,
       %Agent{
         id: agent_id,
         name: "Gateway Agent",
         slug: "gateway-agent",
         workspace_id: "workspace-1",
         model_settings: %{"model" => "gpt-5.3-codex", "provider" => "openai"},
         has_credentials: true
       }}
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  setup do
    original_runner = Application.get_env(:symphony_elixir, :gateway_chat_runner)
    original_inventory = Application.get_env(:symphony_elixir, :agent_inventory_adapter)
    original_message_log = Application.get_env(:symphony_elixir, :message_log_adapter)
    original_owner = Application.get_env(:symphony_elixir, :chat_gateway_test_owner)

    if is_nil(Process.whereis(SymphonyElixir.Launcher.ConfigRegistry)) do
      start_supervised!(SymphonyElixir.Launcher.ConfigRegistry)
    end

    Application.put_env(:symphony_elixir, :gateway_chat_runner, FakeRunner)
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, AgentInventoryStub)
    Application.put_env(:symphony_elixir, :message_log_adapter, FakeMessageLog)
    Application.put_env(:symphony_elixir, :chat_gateway_test_owner, self())

    restart_session_store!()

    on_exit(fn ->
      restore_app_env(:gateway_chat_runner, original_runner)
      restore_app_env(:agent_inventory_adapter, original_inventory)
      restore_app_env(:message_log_adapter, original_message_log)
      restore_app_env(:chat_gateway_test_owner, original_owner)
    end)

    :ok
  end

  test "post_message appends chat, persists metadata, and starts the configured runner" do
    scope = scope()

    assert {:ok, "run-1"} =
             ChatGateway.post_message(scope, "Ping",
               run_id: "run-1",
               owner_pid: self(),
               session_thread_id: "thread-1",
               metadata: %{"source" => "browser"},
               workflow_path: "/tmp/chat-gateway-workflow.json",
               trace_id: "trc-chat-gateway"
             )

    assert_received {:message_log_user_message, ^scope, "thread-1", "Ping", [metadata: %{"source" => "browser"}, run_id: "run-1"]}

    assert_receive {:fake_runner_agent, "agent-1"}
    assert_receive {:fake_runner_prompt, "Ping"}
    assert_receive {:fake_runner_workflow, {:ok, "/tmp/chat-gateway-workflow.json"}}
    assert_receive {:fake_runner_trace_id, "trc-chat-gateway"}
    assert_receive {:gateway_runner_complete, "session-1", "run-1", {:ok, _result}}

    assert Enum.any?(
             SessionStore.get_messages("session-1"),
             &(&1["role"] == "user" and &1["content"] == "Ping")
           )
  end

  test "post_message retry does not clear an existing active run" do
    scope = scope()

    {:ok, _session} = SessionStore.ensure_session(scope)
    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-1", self())

    assert {:error, :run_already_active} =
             ChatGateway.post_message(scope, "Retry",
               run_id: "run-1",
               owner_pid: self(),
               session_thread_id: "thread-1"
             )

    refute_receive {:message_log_user_message, ^scope, "thread-1", "Retry", _opts}
    refute Enum.any?(SessionStore.get_messages("session-1"), &(&1["content"] == "Retry"))

    assert {:ok, session} = SessionStore.complete_run("run-1", assistant_fallback: "Still completes")

    assert Enum.any?(
             session.messages,
             &(&1["role"] == "assistant" and &1["content"] == "Still completes")
           )
  end

  test "post_message awaits and persists assistant metadata for scheduler callers" do
    scope = scope()

    assert {:ok, "run-2"} =
             ChatGateway.post_message(scope, ~s({"due_tasks":[]}),
               run_id: "run-2",
               await?: true,
               metadata: %{"source" => "manager_scheduler", "work_item_ids" => ["wi-1"]},
               assistant_metadata: %{"source" => "manager_scheduler"},
               work_item_ids: ["wi-1"]
             )

    assert_received {:message_log_thread, ^scope, opts}
    assert opts[:label] == "Gateway Agent"

    assert_received {:message_log_user_message, ^scope, "thread-1", ~s({"due_tasks":[]}), opts}
    assert opts[:metadata]["source"] == "manager_scheduler"

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "Done", "run-2", metadata, opts}
    assert metadata["source"] == "manager_scheduler"
    assert metadata["kind"] == "assistant_turn"
    assert metadata["work_item_ids"] == ["wi-1"]
    assert metadata["usage"] == %{"input_tokens" => 2}
    assert metadata["response_id"] == "resp-1"
    assert metadata["model"] == "gpt-test"
    assert metadata["provider"] == "openai"
    assert metadata["runner_kind"] == "manager"
    assert opts[:tool_calls] == []
  end

  test "post_message passes buffered terminal tool calls to MessageLog" do
    scope = scope()
    Application.put_env(:symphony_elixir, :gateway_chat_runner, ToolRunner)

    assert {:ok, "run-tools"} =
             ChatGateway.post_message(scope, "Create a task",
               run_id: "run-tools",
               await?: true,
               work_item_ids: ["wi-1"]
             )

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "Created", "run-tools", metadata, opts}
    assert metadata["tool_calls"] == [%{"tool" => "task.create", "call_id" => "call-1", "status" => "ok"}]

    assert [
             %{
               "call_id" => "call-1",
               "tool_name" => "task.create",
               "status" => "ok",
               "input" => %{"id" => "call-1", "name" => "task.create", "arguments" => %{"title" => "Verify"}},
               "output" => %{"success" => true, "output" => encoded_output}
             }
           ] = opts[:tool_calls]

    assert Jason.decode!(encoded_output) == %{"id" => "task-1"}
  end

  test "post_message persists the newest assistant turn for an existing session" do
    scope = scope()

    assert {:ok, "run-older"} =
             ChatGateway.post_message(scope, "first",
               run_id: "run-older",
               await?: true
             )

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "Done", "run-older", _metadata, _opts}

    assert {:ok, "run-newer"} =
             ChatGateway.post_message(scope, "second",
               run_id: "run-newer",
               await?: true
             )

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "Second", "run-newer", _metadata, _opts}
  end

  test "post_message kills the runner task after timeout" do
    scope = scope()
    Application.put_env(:symphony_elixir, :gateway_chat_runner, SlowRunner)

    assert {:error, :gateway_runner_timeout} =
             ChatGateway.post_message(scope, "slow",
               run_id: "run-timeout",
               await?: true,
               timeout_ms: 10
             )

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "gateway_runner_timeout", "run-timeout", metadata, _opts}
    assert metadata["kind"] == "error"

    refute_receive {:gateway_runner_complete, "session-1", "run-timeout", _result}, 150
  end

  defp scope do
    %{
      agent_id: "agent-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "session-1"
    }
  end

  defp restore_app_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app_env(key, value), do: Application.put_env(:symphony_elixir, key, value)

  defp restart_session_store! do
    case Enum.find(Supervisor.which_children(SymphonyElixir.Supervisor), fn
           {SymphonyElixir.Gateway.SessionStore, _pid, _type, _modules} -> true
           _child -> false
         end) do
      {SymphonyElixir.Gateway.SessionStore, _pid, _type, _modules} ->
        :ok =
          Supervisor.terminate_child(
            SymphonyElixir.Supervisor,
            SymphonyElixir.Gateway.SessionStore
          )

        {:ok, _pid} =
          Supervisor.restart_child(SymphonyElixir.Supervisor, SymphonyElixir.Gateway.SessionStore)

        :ok

      _ ->
        :ok
    end
  end
end
