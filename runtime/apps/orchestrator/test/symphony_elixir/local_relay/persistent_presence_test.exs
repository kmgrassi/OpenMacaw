defmodule SymphonyElixir.LocalRelay.PersistentPresenceTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.LocalRelay.PersistentPresence
  alias SymphonyElixir.Time

  setup do
    Application.put_env(:symphony_elixir, PersistentPresence,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :local_relay_persistent_presence_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :local_relay_persistent_presence_fresh_ms, 60_000)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, PersistentPresence)
      Application.delete_env(:symphony_elixir, :local_relay_persistent_presence_req_options)
      Application.delete_env(:symphony_elixir, :local_relay_persistent_presence_fresh_ms)
    end)

    :ok
  end

  test "returns true for a fresh online helper advertising the requested runner kind" do
    stub([
      machine_row(%{
        "advertised_runner_kinds" => ["openai_compatible"],
        "status" => "online"
      })
    ])

    assert PersistentPresence.fresh?("workspace-1", "openai_compatible")

    assert_received {:get, "/rest/v1/local_runtime_machine", params}
    assert params["workspace_id"] == "eq.workspace-1"
    assert params["revoked_at"] == "is.null"
    assert params["order"] == "last_seen_at.desc.nullslast"
  end

  test "falls back to registered runner kinds for older rows without advertised kinds" do
    stub([
      machine_row(%{
        "advertised_runner_kinds" => [],
        "runner_kinds" => ["openai_compatible"],
        "status" => nil
      })
    ])

    assert PersistentPresence.fresh?("workspace-1", "openai_compatible")
  end

  test "returns false when helper is offline, stale, or does not advertise the runner" do
    stale =
      Time.now()
      |> DateTime.add(-120, :second)
      |> DateTime.to_iso8601()

    stub([
      machine_row(%{"status" => "offline"}),
      machine_row(%{"last_seen_at" => stale}),
      machine_row(%{"advertised_runner_kinds" => ["openclaw"]})
    ])

    refute PersistentPresence.fresh?("workspace-1", "openai_compatible")
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

  defp machine_row(overrides) do
    Map.merge(
      %{
        "id" => "machine-1",
        "last_seen_at" => Time.now_iso8601(),
        "runner_kinds" => ["openai_compatible"],
        "advertised_runner_kinds" => ["openai_compatible"],
        "status" => "online"
      },
      overrides
    )
  end
end
