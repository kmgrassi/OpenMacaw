defmodule SymphonyElixir.WorkerBridge.SessionLifecycle do
  @moduledoc false

  alias SymphonyElixir.RuntimeLease
  alias SymphonyElixir.WorkerBridge.{PortLauncher, RepositoryManager, ResourceAuthorization}

  @spec heartbeat(map(), GenServer.server()) :: {:ok, map()} | {:error, term(), map()}
  def heartbeat(entry, lease_registry) do
    with {:ok, refreshed} <- revalidate(entry, lease_registry),
         {:ok, lease} <-
           RuntimeLease.Registry.heartbeat(lease_registry, refreshed.lease_id, idle_timeout_ms: refreshed.idle_timeout_ms) do
      {:ok,
       %{
         refreshed
         | heartbeat_at: lease.heartbeat_at,
           idle_expires_at: lease.idle_expires_at
       }}
    else
      {:error, reason, stopped} -> {:error, reason, stopped}
      {:error, reason} -> {:error, reason, entry}
    end
  end

  @spec finalize(map(), String.t(), integer(), GenServer.server()) :: map()
  def finalize(entry, status, exit_status, lease_registry) do
    cleanup_result = cleanup_workspace(entry.workspace_cleanup_path)
    release_lease(lease_registry, entry, status)
    log_cleanup_result(entry, status, cleanup_result)

    %{
      entry
      | status: status,
        stopped_at: DateTime.utc_now(),
        exit_status: exit_status,
        workspace_cleanup_path: nil
    }
  end

  @spec write_lease(GenServer.server(), map(), map()) :: :ok
  def write_lease(lease_registry, entry, params) do
    metadata = Map.get(params, "lease", %{}) |> normalize_metadata()
    grant_versions = Map.merge(resource_grant_versions(entry), Map.get(metadata, "materialized_grant_versions", %{}))

    {:ok, _lease} =
      RuntimeLease.Registry.upsert_lease(lease_registry, %{
        id: entry.lease_id,
        kind: "session",
        owner: "worker_bridge",
        workspace_id: entry.workspace_id,
        agent_id: entry.agent_id,
        session_id: entry.id,
        workspace_path: entry.workspace_cleanup_path,
        heartbeat_at: entry.heartbeat_at,
        idle_expires_at: entry.idle_expires_at,
        max_expires_at: entry.max_expires_at,
        materialized_grant_versions: grant_versions,
        metadata: metadata
      })

    :ok
  end

  @spec cleanup_stale_workspace(String.t() | nil, map()) :: map()
  def cleanup_stale_workspace(nil, metrics), do: metrics

  def cleanup_stale_workspace(path, metrics) do
    case cleanup_workspace(path) do
      :ok ->
        metrics

      {:error, reason} ->
        require Logger
        Logger.warning("worker_bridge_cleanup event=workspace_cleanup_failed path=#{path} reason=#{inspect(reason)}")
        %{metrics | cleanup_failures: metrics.cleanup_failures + 1}
    end
  end

  @spec empty_reap_metrics() :: %{reaped_sessions: non_neg_integer(), stale_missing_sessions: non_neg_integer(), cleanup_failures: non_neg_integer()}
  def empty_reap_metrics do
    %{reaped_sessions: 0, stale_missing_sessions: 0, cleanup_failures: 0}
  end

  defp revalidate(%{status: status} = entry, _lease_registry) when status != "running", do: {:ok, entry}
  defp revalidate(%{authorized_resources: []} = entry, _lease_registry), do: {:ok, entry}

  defp revalidate(%{authorized_resources: resources} = entry, lease_registry) when is_list(resources) do
    case ResourceAuthorization.revalidate(resources, entry) do
      {:ok, refreshed_resources} ->
        {:ok, %{entry | authorized_resources: refreshed_resources}}

      {:error, reason} ->
        PortLauncher.stop(entry.port)
        {:error, reason, finalize(entry, "revoked", entry.exit_status || 0, lease_registry)}
    end
  end

  defp revalidate(entry, _lease_registry), do: {:ok, Map.put(entry, :authorized_resources, [])}

  defp cleanup_workspace(nil), do: :ok

  defp cleanup_workspace(path) do
    case RepositoryManager.cleanup_workspace(path) do
      :ok -> :ok
      {:error, {:workspace_cleanup_failed, failed_path, reason}} -> {:error, {reason, failed_path}}
      {:error, {:resource_path_outside_workspace, _expanded_path, _expanded_root}} -> cleanup_workspace_fallback(path)
      {:error, :invalid_workspace_path} -> cleanup_workspace_fallback(path)
      {:error, reason} -> {:error, reason}
    end
  end

  defp cleanup_workspace_fallback(path) do
    case File.rm_rf(path) do
      {:ok, _paths} -> :ok
      {:error, reason, failed_path} -> {:error, {reason, failed_path}}
    end
  end

  defp release_lease(lease_registry, entry, status) do
    if Map.get(entry, :lease_id) do
      case RuntimeLease.Registry.release_lease(lease_registry, entry.lease_id) do
        {:ok, _lease} ->
          :ok

        {:error, :not_found} ->
          require Logger
          Logger.warning("worker_bridge_cleanup event=lease_release_missing session_id=#{entry.id} status=#{status}")
      end
    end
  end

  defp log_cleanup_result(entry, status, :ok) do
    require Logger
    Logger.info("worker_bridge_cleanup event=session_finalized session_id=#{entry.id} status=#{status} workspace_id=#{entry.workspace_id || "unknown"}")
  end

  defp log_cleanup_result(entry, status, {:error, reason}) do
    require Logger
    Logger.warning("worker_bridge_cleanup event=session_cleanup_failed session_id=#{entry.id} status=#{status} reason=#{inspect(reason)}")
  end

  defp normalize_metadata(%{} = metadata), do: metadata
  defp normalize_metadata(_metadata), do: %{}

  defp resource_grant_versions(%{authorized_resources: resources}) when is_list(resources) do
    Map.new(resources, fn resource -> {resource.grant_id, resource.grant_version} end)
  end

  defp resource_grant_versions(_entry), do: %{}
end
