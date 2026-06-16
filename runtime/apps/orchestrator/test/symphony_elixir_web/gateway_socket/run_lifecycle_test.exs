defmodule SymphonyElixirWeb.GatewaySocket.RunLifecycleTest do
  use SymphonyElixirWeb.GatewaySocketCase

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

  test "deleting a session with an in-flight run aborts the run's client" do
    session_key = default_session_key()

    {:ok, state} =
      GatewaySocket.init(%{
        query_params: scope_query(),
        request_headers: %{},
        peer_data: {127, 0, 0, 1}
      })

    {:push, [{:text, _hello_json}], state} =
      GatewaySocket.handle_in({request_frame("connect", %{}), []}, state)

    {:ok, %{run: _run}} = SessionStore.start_run(session_key, "run-deleted", self())

    :ok = SessionStore.delete_session(session_key)

    assert_receive {:gateway_runner_aborted, ^session_key, "run-deleted"}

    {:push, [{:text, aborted_json}], _state} =
      GatewaySocket.handle_info({:gateway_runner_aborted, session_key, "run-deleted"}, state)

    aborted = Jason.decode!(aborted_json)
    assert aborted["event"] == "chat"
    assert aborted["payload"]["state"] == "aborted"
    assert aborted["payload"]["runId"] == "run-deleted"
    assert aborted["payload"]["sessionKey"] == session_key
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
end
