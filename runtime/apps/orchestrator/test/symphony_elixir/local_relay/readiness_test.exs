defmodule SymphonyElixir.LocalRelay.ReadinessTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.LocalRelay.{PersistentPresence, Readiness, Registry}
  alias SymphonyElixir.Time

  setup do
    Registry.reset!()

    Application.put_env(:symphony_elixir, PersistentPresence,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :local_relay_persistent_presence_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :local_relay_persistent_presence_fresh_ms, 60_000)
    Application.put_env(:symphony_elixir, :local_relay_reconnect_wait_ms, 250)
    Application.put_env(:symphony_elixir, :local_relay_reconnect_poll_ms, 10)

    on_exit(fn ->
      Registry.reset!()
      Application.delete_env(:symphony_elixir, PersistentPresence)
      Application.delete_env(:symphony_elixir, :local_relay_persistent_presence_req_options)
      Application.delete_env(:symphony_elixir, :local_relay_persistent_presence_fresh_ms)
      Application.delete_env(:symphony_elixir, :local_relay_reconnect_wait_ms)
      Application.delete_env(:symphony_elixir, :local_relay_reconnect_poll_ms)
    end)

    :ok
  end

  test "returns an already registered helper without consulting persistent presence" do
    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: ["openai_compatible"]
             })

    assert {:ok, helper} = Readiness.lookup("workspace-1", "openai_compatible")
    assert helper.machine_id == "machine-1"
    refute_received {:get, _path, _params}
  end

  test "waits for a helper reconnect when persistent presence is fresh" do
    stub([
      %{
        "id" => "machine-1",
        "last_seen_at" => Time.now_iso8601(),
        "runner_kinds" => ["openai_compatible"],
        "advertised_runner_kinds" => ["openai_compatible"],
        "status" => "online"
      }
    ])

    test_pid = self()

    spawn(fn ->
      Process.sleep(40)

      send(
        test_pid,
        Registry.register(%{
          workspace_id: "workspace-1",
          machine_id: "machine-1",
          pid: self(),
          runners: ["openai_compatible"]
        })
      )

      Process.sleep(:infinity)
    end)

    assert {:ok, helper} = Readiness.lookup("workspace-1", "openai_compatible")
    assert helper.machine_id == "machine-1"
    assert_received {:ok, _registered}
    assert_received {:get, "/rest/v1/local_runtime_machine", _params}
  end

  test "returns offline immediately when persistent presence is not fresh" do
    stub([])

    assert {:error, :local_runtime_offline} = Readiness.lookup("workspace-1", "openai_compatible")
    assert_received {:get, "/rest/v1/local_runtime_machine", _params}
  end

  defp stub(rows) do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:get, conn.request_path, URI.decode_query(conn.query_string)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(rows))
    end)
  end
end
