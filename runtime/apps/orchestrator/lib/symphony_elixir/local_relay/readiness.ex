defmodule SymphonyElixir.LocalRelay.Readiness do
  @moduledoc """
  Looks up a local relay helper, waiting briefly for reconnect after deploys.

  `Registry` presence is intentionally node-local. If a helper heartbeat is
  fresh in PostgREST but the current node has no WebSocket yet, a rolling
  deploy is probably in the short window between draining the old socket and
  the helper reconnecting. Waiting here prevents an immediate user-visible
  `local_runtime_offline` for that transient state.
  """

  alias SymphonyElixir.LocalRelay.{PersistentPresence, Registry}
  alias SymphonyElixir.RuntimeLog

  @default_wait_ms 15_000
  @default_poll_ms 250

  @spec lookup(String.t(), String.t()) :: Registry.lookup_result()
  def lookup(workspace_id, runner_kind) do
    case Registry.lookup(workspace_id, runner_kind) do
      {:ok, helper} ->
        {:ok, helper}

      {:error, :local_runtime_offline} = offline ->
        maybe_wait_for_reconnect(workspace_id, runner_kind, offline)
    end
  end

  defp maybe_wait_for_reconnect(workspace_id, runner_kind, offline) do
    if PersistentPresence.fresh?(workspace_id, runner_kind) do
      RuntimeLog.log(:info, :local_relay_waiting_for_helper_reconnect, %{
        workspace_id: workspace_id,
        runner_kind: runner_kind,
        wait_ms: wait_ms()
      })

      poll_until_connected(workspace_id, runner_kind, monotonic_deadline(wait_ms()))
    else
      offline
    end
  end

  defp poll_until_connected(workspace_id, runner_kind, deadline) do
    case Registry.lookup(workspace_id, runner_kind) do
      {:ok, helper} ->
        {:ok, helper}

      {:error, :local_runtime_offline} = offline ->
        if System.monotonic_time(:millisecond) >= deadline do
          offline
        else
          Process.sleep(poll_ms())
          poll_until_connected(workspace_id, runner_kind, deadline)
        end
    end
  end

  defp monotonic_deadline(wait_ms), do: System.monotonic_time(:millisecond) + wait_ms

  defp wait_ms do
    Application.get_env(:symphony_elixir, :local_relay_reconnect_wait_ms, @default_wait_ms)
  end

  defp poll_ms do
    Application.get_env(:symphony_elixir, :local_relay_reconnect_poll_ms, @default_poll_ms)
  end
end
