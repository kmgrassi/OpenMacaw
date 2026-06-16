defmodule SymphonyElixirWeb.GatewaySocket.ChatFlowTest do
  use SymphonyElixirWeb.GatewaySocketCase

  test "chat message persistence failures are structured and non-fatal" do
    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{
          "x-trace-id" => "trc-gateway-test",
          "x-connection-id" => "conn-gateway-test"
        },
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
               "input" => %{
                 "id" => "call-1",
                 "name" => "task.create",
                 "arguments" => %{"title" => "Verify runtime tool smoke"}
               },
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
end
