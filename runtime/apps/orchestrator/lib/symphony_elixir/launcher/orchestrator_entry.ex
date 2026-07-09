defmodule SymphonyElixir.Launcher.OrchestratorEntry do
  @moduledoc false

  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Launcher.EngineInstanceSync
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.Time

  @spec new(String.t(), pid(), reference(), non_neg_integer(), map(), map()) :: map()
  def new(id, pid, ref, port, config, attrs \\ %{}) do
    %{
      id: id,
      pid: pid,
      ref: ref,
      port: port,
      config: config,
      started_at: DateTime.utc_now(),
      status: :running,
      restart_count: 0
    }
    |> Map.merge(attrs)
  end

  @spec restarted(map(), pid(), reference(), map(), map()) :: map()
  def restarted(entry, pid, ref, config, attrs \\ %{}) do
    entry
    |> Map.merge(%{
      pid: pid,
      ref: ref,
      config: config,
      started_at: DateTime.utc_now(),
      status: :running,
      restart_count: Map.get(entry, :restart_count, 0) + 1
    })
    |> Map.merge(attrs)
  end

  @spec crash_restarted(map(), pid(), reference()) :: map()
  def crash_restarted(entry, pid, ref) do
    entry
    |> Map.put(:pid, pid)
    |> Map.put(:ref, ref)
    |> Map.put(:status, :running)
    |> Map.put(:restart_count, Map.get(entry, :restart_count, 0) + 1)
  end

  @spec serialize(map(), boolean()) :: map()
  def serialize(entry, reused \\ false) do
    %{
      id: entry.id,
      port: entry.port,
      config: entry.config,
      started_at: format_datetime(entry.started_at),
      status: to_string(entry.status),
      reused: reused
    }
    |> maybe_put(:agent_id, Map.get(entry, :agent_id))
    |> maybe_put(:type, Map.get(entry, :type))
    |> maybe_put(:agent_name, Map.get(entry, :agent_name))
    |> maybe_put(:workspace_id, Map.get(entry, :workspace_id))
    |> maybe_put(:project_id, Map.get(entry, :project_id))
    |> maybe_put(:restart_count, Map.get(entry, :restart_count))
  end

  @spec trace_id_from_config(term()) :: String.t()
  def trace_id_from_config(config) when is_map(config) do
    RuntimeLog.ensure_trace_id(
      Map.get(config, "trace_id") ||
        Map.get(config, :trace_id) ||
        get_in(config, ["runtime", "trace_id"]) ||
        get_in(config, [:runtime, :trace_id])
    )
  end

  def trace_id_from_config(_config), do: RuntimeLog.ensure_trace_id(nil)

  @spec runtime_log_fields(map(), map()) :: map()
  def runtime_log_fields(entry, extra) do
    %{
      agent_id: Map.get(entry, :agent_id),
      workspace_id: Map.get(entry, :workspace_id),
      run_id: Map.get(entry, :id),
      port: Map.get(entry, :port),
      status: Map.get(entry, :status),
      agent_type: Map.get(entry, :type),
      host: EngineInstanceSync.host(),
      desired_state: Map.get(entry, :desired_state),
      actual_state: Map.get(entry, :status),
      restart_count: Map.get(entry, :restart_count)
    }
    |> Map.merge(ExecutionProfile.log_fields(get_in(entry, [:config, "execution_profile"])))
    |> Map.merge(extra)
  end

  defp format_datetime(value), do: Time.to_iso8601(value) || to_string(value)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
