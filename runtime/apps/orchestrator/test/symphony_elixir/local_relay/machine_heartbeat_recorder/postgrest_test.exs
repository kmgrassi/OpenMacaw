defmodule SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.PostgRESTTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.PostgREST, as: Recorder

  @machine_id "00000000-0000-0000-0000-0000000000aa"

  setup do
    Application.put_env(:symphony_elixir, Recorder,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_req_options, plug: {Req.Test, __MODULE__})

    # Run writes inline so the PATCH is observable in-test.
    Application.put_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_mode, :sync)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, Recorder)
      Application.delete_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_req_options)
      Application.delete_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_mode)
    end)

    :ok
  end

  defp stub(status \\ 204) do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, raw, conn} = Plug.Conn.read_body(conn)
      body = if raw == "", do: %{}, else: Jason.decode!(raw)
      send(test_pid, {:patch, conn.method, conn.request_path, URI.decode_query(conn.query_string), body})
      Plug.Conn.send_resp(conn, status, "")
    end)
  end

  test "record_register patches last_seen_at + advertised_runner_kinds keyed by machine id" do
    stub()

    assert :ok =
             Recorder.record_register(@machine_id, %{
               advertised_runner_kinds: ["openai_compatible"],
               helper_version: "1.2.3"
             })

    assert_received {:patch, "PATCH", "/rest/v1/local_runtime_machine", params, body}
    assert params["id"] == "eq.#{@machine_id}"
    assert is_binary(body["last_seen_at"])
    assert body["status"] == "online"
    assert body["advertised_runner_kinds"] == ["openai_compatible"]
    assert body["helper_version"] == "1.2.3"
  end

  test "record_heartbeat omits advertised_runner_kinds when none reported" do
    stub()

    assert :ok = Recorder.record_heartbeat(@machine_id, %{})

    assert_received {:patch, "PATCH", _path, _params, body}
    assert is_binary(body["last_seen_at"])
    assert body["status"] == "online"
    refute Map.has_key?(body, "advertised_runner_kinds")
    refute Map.has_key?(body, "helper_version")
  end

  test "record_disconnect clears advertised_runner_kinds" do
    stub()

    assert :ok = Recorder.record_disconnect(@machine_id)

    assert_received {:patch, "PATCH", _path, params, body}
    assert params["id"] == "eq.#{@machine_id}"
    assert body["advertised_runner_kinds"] == []
    assert body["status"] == "offline"
    assert is_binary(body["last_seen_at"])
  end

  test "a failed write is logged but never raises (socket must stay up)" do
    stub(500)

    log =
      capture_log(fn ->
        assert :ok =
                 Recorder.record_heartbeat(@machine_id, %{advertised_runner_kinds: ["openai_compatible"]})
      end)

    assert log =~ "local_relay_machine_heartbeat_write_failed"
  end
end
