defmodule SymphonyElixir.Runner.WorkerBridgeRouting do
  @moduledoc """
  Routes coding runner session starts through the worker bridge when an
  execution profile requests the container target.
  """

  alias SymphonyElixir.WorkerBridge.Client, as: WorkerBridgeClient

  @container_targets ~w(container aws ecs)

  @spec container_target?(map()) :: boolean()
  def container_target?(config) when is_map(config) do
    config
    |> execution_target()
    |> case do
      target when target in @container_targets -> true
      _target -> false
    end
  end

  def container_target?(_config), do: false

  @spec start_session(String.t(), map(), String.t() | nil) :: {:ok, map()} | {:error, term()}
  def start_session(kind, config, workspace) when is_binary(kind) and is_map(config) do
    params = start_params(kind, config, workspace)

    case worker_bridge_client().start_session(params) do
      {:ok, bridge_session} ->
        {:ok,
         %{
           worker_bridge: true,
           runner: kind,
           session_id: Map.get(bridge_session, :id) || Map.get(bridge_session, "id"),
           bridge_session: bridge_session,
           on_message: config_value(config, "on_message"),
           trace_id: config_value(config, "trace_id"),
           execution_profile: config_value(config, "execution_profile")
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec run_turn(map(), String.t()) :: {:error, term()}
  def run_turn(%{worker_bridge: true, session_id: session_id}, runner_kind) do
    _ = maybe_heartbeat(session_id)

    {:error, {:fatal, {:worker_bridge_turn_transport_unavailable, "worker bridge #{runner_kind} session started, but no turn transport is registered for this runtime"}}}
  end

  @spec stop_session(map()) :: :ok | {:error, term()}
  def stop_session(%{worker_bridge: true, session_id: session_id}) when is_binary(session_id) do
    case worker_bridge_client().stop_session(session_id) do
      {:ok, _session} -> :ok
      {:error, :not_found} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  def stop_session(%{worker_bridge: true}), do: :ok

  @spec start_params(String.t(), map(), String.t() | nil) :: map()
  def start_params(kind, config, workspace) do
    %{
      "kind" => kind,
      "cwd" => workspace,
      "command" => command_for(kind, config),
      "env" => config_value(config, "env") || %{},
      "execution_target" => execution_target(config),
      "execution_profile" => config_value(config, "execution_profile"),
      "dispatch_metadata" => dispatch_metadata(config),
      "skills_snapshot" => config_value(config, "skills_snapshot") || config_value(config, "skillsSnapshot"),
      "runner_config" => sanitize_runner_config(config),
      "run_id" => config_value(config, "run_id"),
      "session_id" => config_value(config, "session_id")
    }
    |> compact_blank()
  end

  defp worker_bridge_client do
    Application.get_env(:symphony_elixir, :worker_bridge_client, WorkerBridgeClient)
  end

  defp maybe_heartbeat(session_id) when is_binary(session_id) do
    worker_bridge_client().heartbeat_session(session_id)
  end

  defp maybe_heartbeat(_session_id), do: :ok

  defp execution_target(config) do
    first_present([
      config_value(config, "execution_target"),
      config_value(config, "executionTarget"),
      config_value(config, ["execution_profile", "executionTarget", "kind"]),
      config_value(config, ["execution_profile", "execution_target", "kind"]),
      config_value(config, ["execution_profile", "execution_target"]),
      config_value(config, ["execution_profile", "executionTarget"]),
      config_value(config, ["execution_profile", "execution_target_kind"]),
      config_value(config, ["execution_profile", "executionTargetKind"]),
      config_value(config, ["execution_profile", "adapter_config", "execution_target"]),
      config_value(config, ["execution_profile", "adapter_config", "executionTarget"])
    ])
    |> normalize_target()
  end

  defp dispatch_metadata(config) do
    first_present([
      config_value(config, "dispatch_metadata"),
      config_value(config, "dispatchMetadata"),
      config_value(config, ["execution_profile", "dispatch_metadata"]),
      config_value(config, ["execution_profile", "dispatchMetadata"]),
      config_value(config, ["execution_profile", "executionTarget", "metadata"]),
      config_value(config, ["execution_profile", "execution_target", "metadata"]),
      config_value(config, ["execution_profile", "adapter_config", "dispatch_metadata"]),
      config_value(config, ["execution_profile", "adapter_config", "dispatchMetadata"])
    ])
  end

  defp config_value(config, [key]) when is_map(config), do: config_value(config, key)

  defp config_value(config, [key | rest]) when is_map(config) do
    case config_value(config, key) do
      nested when is_map(nested) -> config_value(nested, rest)
      _value -> nil
    end
  end

  defp config_value(config, key) when is_map(config) and is_binary(key) do
    atom_key = atom_key(key)

    cond do
      Map.has_key?(config, key) -> Map.get(config, key)
      atom_key && Map.has_key?(config, atom_key) -> Map.get(config, atom_key)
      true -> nil
    end
  end

  defp config_value(_config, _key), do: nil

  defp atom_key("command"), do: :command
  defp atom_key("dispatch_metadata"), do: :dispatch_metadata
  defp atom_key("dispatchMetadata"), do: :dispatch_metadata
  defp atom_key("env"), do: :env
  defp atom_key("execution_profile"), do: :execution_profile
  defp atom_key("execution_target"), do: :execution_target
  defp atom_key("executionTarget"), do: :execution_target
  defp atom_key("execution_target_kind"), do: :execution_target_kind
  defp atom_key("executionTargetKind"), do: :execution_target_kind
  defp atom_key("kind"), do: :kind
  defp atom_key("metadata"), do: :metadata
  defp atom_key("adapter_config"), do: :adapter_config
  defp atom_key("run_id"), do: :run_id
  defp atom_key("session_id"), do: :session_id
  defp atom_key("skills_snapshot"), do: :skills_snapshot
  defp atom_key("skillsSnapshot"), do: :skills_snapshot
  defp atom_key("on_message"), do: :on_message
  defp atom_key("trace_id"), do: :trace_id
  defp atom_key(_key), do: nil

  defp first_present(values) do
    Enum.find(values, fn
      value when is_binary(value) -> String.trim(value) != ""
      nil -> false
      _value -> true
    end)
  end

  defp normalize_target(target) when is_binary(target), do: target |> String.trim() |> String.downcase()
  defp normalize_target(_target), do: nil

  defp command_for("claude_code", config) do
    config_value(config, "command") || config_value(config, "bridge_command") ||
      default_command("claude_code")
  end

  defp command_for(_kind, config), do: config_value(config, "command")

  defp default_command("claude_code"), do: config_value(config_runner("claude_code"), "bridge_command")
  defp default_command(_kind), do: nil

  defp config_runner("claude_code") do
    SymphonyElixir.Config.runner_config() |> Map.get("claude_code", %{})
  rescue
    ArgumentError -> %{}
  end

  defp config_runner(_kind), do: %{}

  defp sanitize_runner_config(config) do
    config
    |> Map.drop([:on_message, "on_message"])
    |> Map.update("execution_profile", nil, &sanitize_execution_profile/1)
    |> Map.update(:execution_profile, nil, &sanitize_execution_profile/1)
    |> compact_blank()
  end

  defp sanitize_execution_profile(profile) when is_map(profile), do: SymphonyElixir.ExecutionProfile.sanitize(profile)
  defp sanitize_execution_profile(profile), do: profile

  defp compact_blank(map) when is_map(map) do
    Map.reject(map, fn
      {_key, nil} -> true
      {_key, ""} -> true
      {_key, value} when is_map(value) -> map_size(value) == 0
      _entry -> false
    end)
  end
end
