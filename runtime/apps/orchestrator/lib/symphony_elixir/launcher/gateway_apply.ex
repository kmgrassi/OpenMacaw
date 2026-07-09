defmodule SymphonyElixir.Launcher.GatewayApply do
  @moduledoc false

  require Logger

  alias SymphonyElixir.Launcher.GatewayConfig

  @spec record(map() | nil, :ok | :error, String.t() | nil) :: :ok
  def record(resolution, status, broker_instance_id) do
    record(resolution, status, broker_instance_id, [])
  end

  @spec record(map() | nil, :ok | :error, String.t() | nil, keyword()) :: :ok
  def record(nil, _status, _broker_instance_id, _opts), do: :ok

  def record(
        %{scope_type: scope_type, scope_id: scope_id} = resolution,
        :ok,
        broker_instance_id,
        _opts
      ) do
    case GatewayConfig.record_apply_state(scope_type, scope_id, :ok,
           last_applied_hash: Map.get(resolution, :config_hash),
           last_applied_version: Map.get(resolution, :version),
           broker_instance_id: broker_instance_id
         ) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to record gateway_config_state ok for #{scope_type}/#{scope_id}: #{inspect(reason)}")

        :ok
    end
  end

  def record(%{scope_type: scope_type, scope_id: scope_id}, :error, broker_instance_id, opts) do
    error_message = Keyword.get(opts, :error)

    case GatewayConfig.record_apply_state(scope_type, scope_id, :error,
           broker_instance_id: broker_instance_id,
           last_apply_error: error_message
         ) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to record gateway_config_state error for #{scope_type}/#{scope_id}: #{inspect(reason)}")

        :ok
    end
  end
end
