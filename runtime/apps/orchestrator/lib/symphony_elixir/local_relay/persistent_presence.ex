defmodule SymphonyElixir.LocalRelay.PersistentPresence do
  @moduledoc """
  Reads relay helper presence from `local_runtime_machine`.

  The in-memory relay registry is per orchestrator node. During rolling
  deploys, a helper WebSocket can briefly remain connected to a draining node
  while a chat request lands on a fresh node. This module checks the persisted
  heartbeat row so callers can distinguish a truly offline helper from a likely
  reconnect-in-progress.
  """

  alias SymphonyElixir.{PostgRESTClient, RuntimeLog, Time}

  @machine_table "local_runtime_machine"
  @select "id,last_seen_at,runner_kinds,advertised_runner_kinds,status"
  @default_fresh_ms 60_000

  @spec fresh?(String.t(), String.t()) :: boolean()
  def fresh?(workspace_id, runner_kind) when is_binary(workspace_id) and is_binary(runner_kind) do
    with {:ok, rows} <- fetch_rows(workspace_id) do
      Enum.any?(rows, &fresh_machine?(&1, runner_kind))
    else
      {:error, reason} ->
        RuntimeLog.log(:warning, :local_relay_persistent_presence_check_failed, %{
          workspace_id: workspace_id,
          runner_kind: runner_kind,
          reason: inspect(reason)
        })

        false
    end
  rescue
    error ->
      RuntimeLog.log(:warning, :local_relay_persistent_presence_check_failed, %{
        workspace_id: workspace_id,
        runner_kind: runner_kind,
        reason: Exception.message(error)
      })

      false
  end

  def fresh?(_workspace_id, _runner_kind), do: false

  defp fetch_rows(workspace_id) do
    query = %{
      "select" => @select,
      "workspace_id" => "eq.#{workspace_id}",
      "revoked_at" => "is.null",
      "order" => "last_seen_at.desc.nullslast",
      "limit" => "10"
    }

    with {:ok, client} <- client(),
         {:ok, rows} when is_list(rows) <-
           PostgRESTClient.get(client, @machine_table, query, log_metadata: %{operation: "local_relay.persistent_presence", table: @machine_table}) do
      {:ok, rows}
    else
      {:ok, body} -> {:error, {:unexpected_response, body}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp fresh_machine?(row, runner_kind) when is_map(row) do
    status = Map.get(row, "status")

    status in [nil, "online", "degraded"] and
      runner_kind_advertised?(row, runner_kind) and
      fresh_last_seen?(Map.get(row, "last_seen_at"))
  end

  defp fresh_machine?(_row, _runner_kind), do: false

  defp runner_kind_advertised?(row, runner_kind) do
    row
    |> Map.get("advertised_runner_kinds")
    |> case do
      kinds when is_list(kinds) and kinds != [] -> runner_kind in kinds
      _ -> runner_kind in normalize_kinds(Map.get(row, "runner_kinds"))
    end
  end

  defp normalize_kinds(kinds) when is_list(kinds), do: Enum.filter(kinds, &is_binary/1)
  defp normalize_kinds(_kinds), do: []

  defp fresh_last_seen?(last_seen_at) do
    case Time.parse_iso8601(last_seen_at) do
      nil ->
        false

      last_seen ->
        DateTime.diff(Time.now(), last_seen, :millisecond) <= fresh_ms()
    end
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
    Application.get_env(:symphony_elixir, :local_relay_persistent_presence_req_options, [])
  end

  defp fresh_ms do
    Application.get_env(:symphony_elixir, :local_relay_persistent_presence_fresh_ms, @default_fresh_ms)
  end
end
