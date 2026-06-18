defmodule SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.PostgREST do
  @moduledoc """
  Production recorder. Writes presence updates to `local_runtime_machine`
  through `PostgRESTClient` so the platform UI can show online state,
  advertised runner kinds, and the helper version without reaching into the
  in-memory orchestrator registry.

  Uses PostgREST rather than Ecto because the relay socket runs in launcher
  escript mode, which never starts `SymphonyElixir.Repo` — see CLAUDE.md
  "Database Connection Conventions".

  Writes are dispatched on a `Task.Supervisor` by default — the relay
  socket's hot path must not block on a DB round trip. Failures are logged
  via `RuntimeLog`; a write failure never tears down the live WebSocket
  connection.

  Set `:local_relay_machine_heartbeat_recorder_mode` to `:sync` in config to
  make writes synchronous (useful when running the recorder under a
  controlled test stub).
  """

  @behaviour SymphonyElixir.LocalRelay.MachineHeartbeatRecorder

  alias SymphonyElixir.{PostgRESTClient, RuntimeLog, Time}

  @machine_table "local_runtime_machine"

  @impl true
  def record_register(machine_id, fields) when is_binary(machine_id) do
    fields
    |> base_sets(Map.get(fields, :advertised_runner_kinds, []))
    |> dispatch_update(machine_id, :record_register)
  end

  @impl true
  def record_heartbeat(machine_id, fields) when is_binary(machine_id) do
    fields
    |> base_sets(Map.get(fields, :advertised_runner_kinds))
    |> dispatch_update(machine_id, :record_heartbeat)
  end

  @impl true
  def record_disconnect(machine_id) when is_binary(machine_id) do
    # On disconnect, clear advertised_runner_kinds so a stale row never
    # claims to advertise something the helper isn't currently serving.
    %{"last_seen_at" => Time.now_iso8601(), "advertised_runner_kinds" => [], "status" => "offline"}
    |> dispatch_update(machine_id, :record_disconnect)
  end

  defp base_sets(fields, advertised_runner_kinds) do
    sets = %{"last_seen_at" => Time.now_iso8601(), "status" => "online"}

    sets =
      case Map.get(fields, :helper_version) do
        value when is_binary(value) and value != "" -> Map.put(sets, "helper_version", value)
        _ -> sets
      end

    case advertised_runner_kinds do
      kinds when is_list(kinds) -> Map.put(sets, "advertised_runner_kinds", kinds)
      _ -> sets
    end
  end

  defp dispatch_update(sets, machine_id, op) do
    case mode() do
      :async ->
        Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
          do_update(sets, machine_id, op)
        end)

      :sync ->
        do_update(sets, machine_id, op)
    end

    :ok
  end

  defp do_update(sets, machine_id, op) do
    with {:ok, client} <- client(),
         {:ok, _body} <-
           PostgRESTClient.patch(client, @machine_table, %{"id" => "eq.#{machine_id}"}, sets,
             prefer: "return=minimal",
             log_metadata: %{operation: "local_relay.machine_#{op}", table: @machine_table}
           ) do
      :ok
    else
      {:error, reason} -> log_failure(op, machine_id, inspect(reason))
    end
  rescue
    error -> log_failure(op, machine_id, Exception.message(error))
  catch
    :exit, reason -> log_failure(op, machine_id, inspect(reason))
  end

  defp log_failure(op, machine_id, reason) do
    RuntimeLog.log(:warning, :local_relay_machine_heartbeat_write_failed, %{
      op: Atom.to_string(op),
      machine_id: machine_id,
      reason: reason
    })

    :ok
  end

  defp client do
    config =
      Application.get_env(:symphony_elixir, __MODULE__, [])
      |> normalize_config()

    {:ok, PostgRESTClient.new(config, req_options())}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  defp req_options do
    Application.get_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_req_options, [])
  end

  defp mode do
    Application.get_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder_mode, :async)
  end
end
