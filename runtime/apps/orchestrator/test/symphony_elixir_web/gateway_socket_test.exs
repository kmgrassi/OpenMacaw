defmodule SymphonyElixirWeb.GatewaySocketTest do
  use SymphonyElixir.TestSupport

  import ExUnit.CaptureLog

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixirWeb.GatewaySocket

  defmodule FakeRunner do
    def run(agent, scope, prompt, run_id, owner_pid) do
      send(owner_pid, {:fake_runner_workflow, SymphonyElixir.Launcher.ConfigRegistry.get(self())})

      send(
        owner_pid,
        {:gateway_runner_event, scope.session_key, run_id,
         %{
           event: :notification,
           payload: %{"params" => %{"textDelta" => "hello #{agent.name || scope.agent_id}"}}
         }}
      )

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, :ok})
      send(owner_pid, {:fake_runner_prompt, prompt})
      :ok
    end
  end

  defmodule FakeMessageLog do
    def upsert_session_thread(scope, opts) do
      send(owner(), {:message_log_upsert_session_thread, scope, opts})
      failure(:upsert_session_thread) || {:ok, "thread-1"}
    end

    def record_user_message(scope, session_thread_id, content, opts) do
      send(owner(), {:message_log_user_message, scope, session_thread_id, content, opts})
      failure(:record_user_message) || :ok
    end

    def record_assistant_message(scope, session_thread_id, content, run_id, metadata, opts \\ []) do
      send(
        owner(),
        {:message_log_assistant_message, scope, session_thread_id, content, run_id, metadata, opts}
      )

      failure(:record_assistant_message) || :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :gateway_socket_test_owner)

    defp failure(operation) do
      :symphony_elixir
      |> Application.get_env(:gateway_socket_test_message_log_failure, %{})
      |> Map.get(operation)
    end
  end

  setup do
    if is_nil(Process.whereis(SymphonyElixir.Launcher.ConfigRegistry)) do
      start_supervised!(SymphonyElixir.Launcher.ConfigRegistry)
    end

    put_app_envs(:symphony_elixir,
      gateway_chat_runner: FakeRunner,
      agent_inventory_adapter: SymphonyElixirWeb.GatewaySocketTest.AgentInventoryStub,
      message_log_adapter: SymphonyElixirWeb.GatewaySocketTest.FakeMessageLog,
      gateway_socket_test_owner: self(),
      gateway_socket_test_message_log_failure: nil
    )

    restart_session_store!()

    :ok
  end

  defmodule AgentInventoryStub do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents, do: {:ok, []}

    def get_agent(agent_id) do
      {:ok,
       %Agent{
         id: agent_id,
         name: "Stub Agent",
         slug: "stub-agent",
         workspace_id: "22222222-2222-4222-8222-222222222222",
         model_settings: %{"model" => "gpt-5.3-codex", "provider" => "openai"},
         has_credentials: true
       }}
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  defmodule AgentInventoryUnavailableStub do
    @behaviour SymphonyElixir.AgentInventory

    def list_agents, do: {:ok, []}
    def get_agent(_agent_id), do: raise(ArgumentError, "agent inventory endpoint is required")
    def list_credentials(_agent_id), do: {:ok, []}
  end

  test "connect responds with hello-ok for scoped websocket connections" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    hello = Jason.decode!(hello_json)

    assert hello["type"] == "hello-ok"
    assert hello["protocol"] == 3
    assert "chat.send" in hello["features"]["methods"]
    assert state.connected?
    assert state.session_thread_id == "thread-1"

    assert_received {:message_log_upsert_session_thread,
                     %{
                       user_id: "33333333-3333-4333-8333-333333333333",
                       session_key: "22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111"
                     }, _opts}
  end

  test "websocket scope uses one shared session key across users and ignores client session key" do
    first_query = Map.put(scope_query(), "session_key", "client-session-a")

    second_query =
      scope_query()
      |> Map.put("user_id", "44444444-4444-4444-8444-444444444444")
      |> Map.put("session_key", "client-session-b")

    {:ok, first_state} =
      GatewaySocket.init(%{
        query_params: first_query,
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:ok, second_state} =
      GatewaySocket.init(%{
        query_params: second_query,
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    assert first_state.scope.session_key == default_session_key()
    assert second_state.scope.session_key == default_session_key()
    assert first_state.scope.user_id == "33333333-3333-4333-8333-333333333333"
    assert second_state.scope.user_id == "44444444-4444-4444-8444-444444444444"
  end

  test "initializes websocket trace and connection ids from platform headers" do
    log =
      capture_log(fn ->
        {:ok, state} =
          GatewaySocket.init(%{
            query_params: scope_query(),
            request_headers: %{
              "x-trace-id" => "trc-platform",
              "x-connection-id" => "conn-platform"
            },
            peer_data: {127, 0, 0, 1}
          })

        assert state.trace_id == "trc-platform"
        assert state.connection_id == "conn-platform"
      end)

    payload = logged_event!(log, "gateway_ws_opened")

    assert payload["trace_id"] == "trc-platform"
    assert payload["connection_id"] == "conn-platform"
    assert payload["workspace_id"] == "22222222-2222-4222-8222-222222222222"
    assert payload["agent_id"] == "11111111-1111-4111-8111-111111111111"
    assert payload["session_key"] == default_session_key()
    assert payload["protocol_version"] == 3
  end

  test "connect rejects scoped websocket connections without user_id" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: %{
          "agent_id" => "11111111-1111-4111-8111-111111111111",
          "workspace_id" => "22222222-2222-4222-8222-222222222222"
        },
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, response_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    response = Jason.decode!(response_json)

    assert response["ok"] == false
    assert response["error"]["code"] == "runtime_scope_required"
    assert response["error"]["message"] =~ "user_id"
    refute state.connected?
  end

  test "connect rejects websocket scope without user_id" do
    query = Map.delete(scope_query(), "user_id")

    {:ok, state} =
      GatewaySocket.init(%{query_params: query, request_headers: %{}, peer_data: {127, 0, 0, 1}})

    {:push, [{:text, response_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    response = Jason.decode!(response_json)

    assert response["ok"] == false
    assert response["error"]["code"] == "runtime_scope_required"
    assert response["error"]["message"] =~ "user_id"
    refute state.connected?
  end

  test "ping responds with pong to keep browser websocket connections alive" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, pong_json}], ^state} =
      GatewaySocket.handle_in({Jason.encode!(%{type: "ping", ts: 123}), []}, state)

    assert Jason.decode!(pong_json) == %{"type" => "pong", "ts" => 123}
  end

  test "malformed inbound frames are logged and rejected" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    test_pid = self()
    handler_id = {__MODULE__, :gateway_frame_rejected, test_pid}

    :ok =
      :telemetry.attach(
        handler_id,
        [:symphony_elixir, :gateway, :frame, :rejected],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:gateway_frame_rejected, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    log =
      capture_log(fn ->
        assert {:ok, ^state} =
                 GatewaySocket.handle_in(
                   {Jason.encode!(%{type: "req", id: "req-1", method: 42}), []},
                   state
                 )
      end)

    payload = logged_event!(log, "gateway_ws_frame_rejected")

    assert payload["trace_id"] == state.trace_id
    assert payload["connection_id"] == state.connection_id
    assert payload["workspace_id"] == "22222222-2222-4222-8222-222222222222"
    assert payload["agent_id"] == "11111111-1111-4111-8111-111111111111"
    assert payload["session_key"] == default_session_key()
    assert payload["error_code"] == "invalid_field"
    assert payload["reason"] == "invalid field method: expected a string"
    assert payload["retryable"] == false

    assert_received {:gateway_frame_rejected, [:symphony_elixir, :gateway, :frame, :rejected], %{count: 1}, %{reason: :invalid_field}}
  end

  test "terminate logs websocket close metadata" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{"x-trace-id" => "trc-close", "x-connection-id" => "conn-close"},
        peer_data: {127, 0, 0, 1}
      })

    log =
      capture_log(fn ->
        assert :ok = GatewaySocket.terminate({:remote, 1001, "going away"}, state)
      end)

    payload = logged_event!(log, "gateway_ws_closed")

    assert payload["trace_id"] == "trc-close"
    assert payload["connection_id"] == "conn-close"
    assert payload["close_code"] == 1001
    assert payload["close_reason"] == "{:remote, 1001, \"going away\"}"
    assert payload["error_code"] == "gateway_ws_closed_abnormally"
    assert payload["protocol_version"] == 3
  end

  test "terminate treats 4-tuple close code 1000 as normal" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{"x-trace-id" => "trc-normal-close"},
        peer_data: {127, 0, 0, 1}
      })

    log =
      capture_log(fn ->
        assert :ok = GatewaySocket.terminate({:remote, 1000, "normal", %{adapter: :websock}}, state)
      end)

    payload = logged_event!(log, "gateway_ws_closed")

    assert payload["trace_id"] == "trc-normal-close"
    assert payload["close_code"] == 1000
    refute Map.has_key?(payload, "error_code")
  end

  test "chat message persistence failures are structured and non-fatal" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{"x-trace-id" => "trc-gateway-test", "x-connection-id" => "conn-gateway-test"},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    put_app_env(:symphony_elixir, :gateway_socket_test_message_log_failure, %{
      record_user_message: {:error, {:http_error, 429, %{"message" => "rate limited"}}}
    })

    log =
      capture_log(fn ->
        assert {:push, [{:text, response_json}], _state} =
                 GatewaySocket.handle_in(
                   {request_frame(
                      "chat.send",
                      Map.merge(scope_query(), %{"message" => "Persist this best-effort"})
                    ), []},
                   state
                 )

        assert %{"ok" => true} = Jason.decode!(response_json)
      end)

    payload = logged_event!(log, "gateway_message_persistence_failed")

    assert payload["error_code"] == "message_persistence_failed"
    assert payload["operation"] == "message_log.record_user_message"
    assert payload["non_fatal"] == true
    assert payload["retryable"] == true
    assert payload["workspace_id"] == "22222222-2222-4222-8222-222222222222"
    assert payload["agent_id"] == "11111111-1111-4111-8111-111111111111"
    assert payload["session_thread_id"] == "thread-1"
    assert payload["trace_id"] == "trc-gateway-test"
    assert payload["connection_id"] == "conn-gateway-test"
  end

  test "connect falls back to scoped placeholder agent when inventory is unavailable" do
    put_app_env(
      :symphony_elixir,
      :agent_inventory_adapter,
      SymphonyElixirWeb.GatewaySocketTest.AgentInventoryUnavailableStub
    )

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    hello = Jason.decode!(hello_json)

    assert hello["type"] == "hello-ok"
    assert state.connected?
  end

  test "chat.send streams a delta event and persists a completed assistant message" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1},
        workflow_path: "/tmp/gateway-socket-workflow.json"
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, response_json}], state} =
      GatewaySocket.handle_in(
        {request_frame("chat.send", %{
           "agent_id" => "11111111-1111-4111-8111-111111111111",
           "workspace_id" => "22222222-2222-4222-8222-222222222222",
           "message" => "Ping",
           "deliver" => false,
           "idempotencyKey" => "run-123"
         }), []},
        state
      )

    response = Jason.decode!(response_json)
    assert response["ok"] == true
    assert response["payload"]["runId"] == "run-123"

    assert_received {:message_log_user_message, %{user_id: "33333333-3333-4333-8333-333333333333"}, "thread-1", "Ping", [run_id: "run-123"]}

    assert_receive {:gateway_runner_event, ^session_key, "run-123", _message}
    assert_receive {:gateway_runner_complete, ^session_key, "run-123", :ok}
    assert_receive {:fake_runner_prompt, "Ping"}
    assert_receive {:fake_runner_workflow, {:ok, "/tmp/gateway-socket-workflow.json"}}

    {:push, [{:text, delta_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-123", %{event: :notification, payload: %{"params" => %{"textDelta" => "hello Stub Agent"}}}},
        state
      )

    delta = Jason.decode!(delta_json)
    assert delta["event"] == "chat"
    assert delta["payload"]["state"] == "delta"
    assert delta["payload"]["message"] == "hello Stub Agent"

    {:push, [{:text, final_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_complete, session_key, "run-123", :ok}, state)

    final = Jason.decode!(final_json)
    assert final["event"] == "chat"
    assert final["payload"]["state"] == "final"

    assert_received {:message_log_assistant_message, %{user_id: "33333333-3333-4333-8333-333333333333"}, "thread-1", "hello Stub Agent", "run-123", metadata, _opts}

    assert metadata.input_tokens == 0
    assert metadata.output_tokens == 0
    assert metadata.total_tokens == 0

    messages = SessionStore.get_messages(session_key)

    assert Enum.any?(
             messages,
             &(&1["role"] == "user" and &1["content"] == "Ping" and
                 &1["user_id"] == "33333333-3333-4333-8333-333333333333")
           )

    assert Enum.any?(
             messages,
             &(&1["role"] == "assistant" and &1["content"] == "hello Stub Agent")
           )
  end

  test "completed planner result is used when no assistant delta was buffered" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1},
        workflow_path: "/tmp/gateway-socket-workflow.json"
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    scope = %{
      agent_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      session_key: session_key
    }

    {:ok, _session} = SessionStore.ensure_session(scope)
    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-fallback", self())

    {:push, [{:text, final_json}], _state} =
      GatewaySocket.handle_info(
        {:gateway_runner_complete, session_key, "run-fallback", {:ok, %{"output_text" => "Created plan \"Fallback\". [Open plan](/plans/plan-1)."}}},
        state
      )

    final = Jason.decode!(final_json)
    assert final["event"] == "chat"
    assert final["payload"]["state"] == "final"

    assert get_in(final, ["payload", "message", "content"]) ==
             "Created plan \"Fallback\". [Open plan](/plans/plan-1)."

    messages = SessionStore.get_messages(session_key)
    assert Enum.any?(messages, &(&1["role"] == "assistant" and &1["content"] =~ "Created plan"))
  end

  test "chat.send forwards runner tool call events as chat timeline events" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, started_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-123",
         %{
           event: :tool_call_started,
           payload: %{
             "tool_call_id" => "call-1",
             "tool_name" => "task.create",
             "arguments" => %{"title" => "Verify runtime tool smoke"}
           }
         }},
        state
      )

    started = Jason.decode!(started_json)
    assert started["event"] == "chat"
    assert started["payload"]["state"] == "tool_call_started"
    assert started["payload"]["runId"] == "run-123"
    assert started["payload"]["sessionKey"] == session_key
    assert started["payload"]["tool_name"] == "task.create"
    assert started["payload"]["tool_call_id"] == "call-1"
    assert started["payload"]["arguments"]["title"] == "Verify runtime tool smoke"

    {:push, [{:text, completed_json}], _state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-123",
         %{
           event: :tool_call_completed,
           payload: %{
             "tool_call_id" => "call-1",
             "tool_name" => "task.create",
             "success" => true,
             "duration_ms" => 12
           }
         }},
        state
      )

    completed = Jason.decode!(completed_json)
    assert completed["event"] == "chat"
    assert completed["payload"]["state"] == "tool_call_completed"
    assert completed["payload"]["success"] == true
    assert completed["payload"]["duration_ms"] == 12
  end

  test "chat.send persists terminal tool calls with the final assistant message" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    scope = %{
      agent_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      session_key: session_key
    }

    {:ok, _session} = SessionStore.ensure_session(scope)
    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-tools", self())

    {:push, [{:text, _started_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-tools",
         %{
           event: :tool_call_started,
           payload: %{
             "tool_call_id" => "call-1",
             "tool_name" => "task.create",
             "arguments" => %{"title" => "Verify runtime tool smoke"}
           }
         }},
        state
      )

    {:push, [{:text, _completed_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-tools",
         %{
           event: :tool_call_completed,
           payload: %{
             "tool_call_id" => "call-1",
             "tool_name" => "task.create",
             "success" => true,
             "result" => %{"id" => "task-1"}
           }
         }},
        state
      )

    {:push, [{:text, _delta_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-tools", %{event: :notification, payload: %{"params" => %{"textDelta" => "Created"}}}},
        state
      )

    {:push, [{:text, _final_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_complete, session_key, "run-tools", :ok}, state)

    assert_received {:message_log_assistant_message, ^scope, "thread-1", "Created", "run-tools", _metadata, opts}

    assert [
             %{
               "call_id" => "call-1",
               "tool_name" => "task.create",
               "status" => "ok",
               "input" => %{"id" => "call-1", "name" => "task.create", "arguments" => %{"title" => "Verify runtime tool smoke"}},
               "output" => %{"success" => true, "result" => %{"id" => "task-1"}}
             }
           ] = opts[:tool_calls]
  end

  test "chat.send forwards planner-style nested tool call events" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, completed_json}], _state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-123",
         %{
           event: :tool_call_completed,
           payload: %{
             "params" => %{"tool" => "task.create", "callId" => "call-1"},
             details: %{"success" => true}
           }
         }},
        state
      )

    completed = Jason.decode!(completed_json)
    assert completed["event"] == "chat"
    assert completed["payload"]["state"] == "tool_call_completed"
    assert completed["payload"]["runId"] == "run-123"
    assert completed["payload"]["params"]["tool"] == "task.create"
    assert completed["payload"]["params"]["callId"] == "call-1"
  end

  test "runner notification stream errors do not clear accumulated chat output" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, _response_json}], state} =
      GatewaySocket.handle_in(
        {request_frame("chat.send", %{
           "agent_id" => "11111111-1111-4111-8111-111111111111",
           "workspace_id" => "22222222-2222-4222-8222-222222222222",
           "message" => "Ping",
           "deliver" => false,
           "idempotencyKey" => "run-error"
         }), []},
        state
      )

    {:push, [{:text, delta_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-error",
         %{
           event: :notification,
           payload: %{
             "method" => "item/agentMessage/delta",
             "params" => %{"textDelta" => "provider kept going"}
           }
         }},
        state
      )

    assert Jason.decode!(delta_json)["payload"]["message"] == "provider kept going"

    assert {:ok, ^state} =
             GatewaySocket.handle_info(
               {:gateway_runner_event, session_key, "run-error",
                %{
                  event: :notification,
                  payload: %{
                    "method" => "codex/event/stream_error",
                    "params" => %{"message" => "provider stream failed"}
                  }
                }},
               state
             )

    {:push, [{:text, final_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_complete, session_key, "run-error", :ok}, state)

    assert get_in(Jason.decode!(final_json), ["payload", "state"]) == "final"

    assert get_in(Jason.decode!(final_json), ["payload", "message", "content"]) ==
             "provider kept going"

    messages = SessionStore.get_messages(session_key)

    assert Enum.any?(
             messages,
             &(&1["role"] == "assistant" and &1["content"] == "provider kept going")
           )

    assert_received {:message_log_assistant_message, %{user_id: "33333333-3333-4333-8333-333333333333"}, "thread-1", "provider kept going", "run-error", metadata, _opts}

    refute Map.has_key?(metadata, :error_code)
  end

  test "chat deltas ignore duplicate Codex notification aliases" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, _response_json}], state} =
      GatewaySocket.handle_in(
        {request_frame("chat.send", %{
           "agent_id" => "11111111-1111-4111-8111-111111111111",
           "workspace_id" => "22222222-2222-4222-8222-222222222222",
           "message" => "Ping",
           "deliver" => false,
           "idempotencyKey" => "run-dup"
         }), []},
        state
      )

    assert {:ok, ^state} =
             GatewaySocket.handle_info(
               {:gateway_runner_event, session_key, "run-dup",
                %{
                  event: :notification,
                  payload: %{
                    "method" => "codex/event/agent_message_content_delta",
                    "params" => %{"textDelta" => "pong"}
                  }
                }},
               state
             )

    {:push, [{:text, delta_json}], state} =
      GatewaySocket.handle_info(
        {:gateway_runner_event, session_key, "run-dup",
         %{
           event: :notification,
           payload: %{"method" => "item/agentMessage/delta", "params" => %{"textDelta" => "pong"}}
         }},
        state
      )

    assert Jason.decode!(delta_json)["payload"]["message"] == "pong"

    assert {:ok, ^state} =
             GatewaySocket.handle_info(
               {:gateway_runner_event, session_key, "run-dup",
                %{
                  event: :notification,
                  payload: %{
                    "method" => "codex/event/agent_message_delta",
                    "params" => %{"textDelta" => "pong"}
                  }
                }},
               state
             )

    {:push, [{:text, final_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_complete, session_key, "run-dup", :ok}, state)

    assert get_in(Jason.decode!(final_json), ["payload", "message", "content"]) == "pong"
  end

  test "config.get and config.set round-trip the workflow config snapshot" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:push, [{:text, config_json}], state} =
      GatewaySocket.handle_in({request_frame("config.get", %{}), []}, state)

    config_res = Jason.decode!(config_json)
    assert config_res["ok"] == true
    assert is_binary(config_res["payload"]["raw"])

    raw =
      ~s({"tracker":{"kind":"memory"},"workspace":{"root":"/tmp/ws-test"},"codex":{"command":"codex app-server"}})

    {:push, [{:text, set_json}], _state} =
      GatewaySocket.handle_in(
        {request_frame("config.set", %{"raw" => raw, "baseHash" => config_res["payload"]["hash"]}), []},
        state
      )

    set_res = Jason.decode!(set_json)
    assert set_res["ok"] == true
    assert set_res["payload"]["config"]["tracker"]["kind"] == "memory"
  end

  test "stale runs are cleared when the monitored task exits unexpectedly" do
    scope = %{
      agent_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      session_key: default_session_key()
    }

    session_key = scope.session_key

    {:ok, _session} = SessionStore.ensure_session(scope)

    {:ok, sleeper} =
      Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn -> Process.sleep(5_000) end)

    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-down", self())
    {:ok, _attached} = SessionStore.attach_run("run-down", sleeper)

    Process.exit(sleeper, :kill)
    assert_receive {:gateway_runner_down, ^session_key, "run-down", reason}
    assert reason in [:killed, :noproc]

    :timer.sleep(20)
    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-next", self())
  end

  test "gateway_runner_down clears the run and records an error assistant message" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:ok, %{run: _run}} = SessionStore.start_run(session_key, "run-down", self())

    {:push, [{:text, error_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_down, session_key, "run-down", :killed}, state)

    error = Jason.decode!(error_json)
    assert error["event"] == "chat"
    assert error["payload"]["state"] == "error"
    assert error["payload"]["errorMessage"] == "killed"

    assert_received {:message_log_assistant_message, %{user_id: "33333333-3333-4333-8333-333333333333"}, "thread-1", "killed", "run-down", metadata, _opts}

    assert metadata.error_code == "runtime_error"
    assert metadata.error_message == "killed"

    {:ok, %{run: _run}} = SessionStore.start_run(session_key, "run-next", self())
  end

  test "completing an unresolved run still pushes a terminal final frame" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    # Start a run then delete the session out from under it so the store has
    # nothing left to attach the assistant message to — complete_run returns
    # {:ok, nil}. The client must still receive a terminal frame so its send
    # lifecycle unwinds instead of spinning forever.
    {:ok, %{run: _run}} = SessionStore.start_run(session_key, "run-orphan", self())
    :ok = SessionStore.delete_session(session_key)

    {:push, [{:text, final_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_complete, session_key, "run-orphan", :ok}, state)

    final = Jason.decode!(final_json)
    assert final["event"] == "chat"
    assert final["payload"]["state"] == "final"
    assert final["payload"]["runId"] == "run-orphan"
    assert final["payload"]["sessionKey"] == session_key
  end

  test "completing a run after session deletion does not crash the store" do
    scope = %{
      agent_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      session_key: default_session_key()
    }

    {:ok, _session} = SessionStore.ensure_session(scope)
    {:ok, %{run: _run}} = SessionStore.start_run(scope, "run-delete", self())
    :ok = SessionStore.delete_session(scope.session_key)

    assert {:ok, nil} = SessionStore.complete_run("run-delete")
    assert Process.alive?(Process.whereis(SessionStore))
  end

  defp request_frame(method, params) do
    Jason.encode!(%{type: "req", id: Ecto.UUID.generate(), method: method, params: params})
  end

  defp scope_query do
    %{
      "agent_id" => "11111111-1111-4111-8111-111111111111",
      "workspace_id" => "22222222-2222-4222-8222-222222222222",
      "user_id" => "33333333-3333-4333-8333-333333333333"
    }
  end

  defp default_session_key do
    "22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111"
  end

  defp logged_event!(log, event_name) do
    log
    |> String.split("\n", trim: true)
    |> Enum.find_value(fn line ->
      with [_, json] <- Regex.run(~r/(\{.*\})/, line),
           {:ok, %{"event" => ^event_name} = payload} <- Jason.decode(json) do
        payload
      else
        _ -> nil
      end
    end) ||
      flunk("expected #{event_name} log in:\n#{log}")
  end

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
