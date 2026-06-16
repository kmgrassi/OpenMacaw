defmodule SymphonyElixirWeb.GatewaySocket.ConnectionFlowTest do
  use SymphonyElixirWeb.GatewaySocketCase

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
        assert :ok =
                 GatewaySocket.terminate({:remote, 1000, "normal", %{adapter: :websock}}, state)
      end)

    payload = logged_event!(log, "gateway_ws_closed")

    assert payload["trace_id"] == "trc-normal-close"
    assert payload["close_code"] == 1000
    refute Map.has_key?(payload, "error_code")
  end

  test "connect falls back to scoped placeholder agent when inventory is unavailable" do
    put_app_env(
      :symphony_elixir,
      :agent_inventory_adapter,
      SymphonyElixirWeb.GatewaySocketCase.AgentInventoryUnavailableStub
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
end
