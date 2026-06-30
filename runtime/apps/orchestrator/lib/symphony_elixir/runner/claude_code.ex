defmodule SymphonyElixir.Runner.ClaudeCode do
  @moduledoc """
  Runner adapter for Claude Code through the Claude Agent SDK bridge.

  The Elixir runner owns workspace validation and runner lifecycle semantics.
  The Node bridge owns Claude Agent SDK details and streams provider-specific
  events over an internal JSON-lines protocol.
  """

  @behaviour SymphonyElixir.Runner
  @behaviour SymphonyElixir.Runner.CodingRunner

  alias SymphonyElixir.{ClaudeCode.Bridge, Config, PathSafety, WorkItem}
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Runner.ClaudeCode.EventMapper
  alias SymphonyElixir.Runner.SkillMaterializer
  alias SymphonyElixir.Runner.WorkerBridgeRouting

  @impl true
  def start_session(config, workspace) when is_map(config) do
    cond do
      probe_only?(config) ->
        with :ok <- ping(config) do
          {:ok, %{probe_only: true, runner: "claude_code"}}
        end

      WorkerBridgeRouting.container_target?(config) ->
        with {:ok, cwd} <- validate_workspace_cwd(workspace, config),
             :ok <- validate_credentials(config) do
          WorkerBridgeRouting.start_session("claude_code", config, cwd)
        end

      true ->
        with {:ok, cwd} <- validate_workspace_cwd(workspace, config),
             :ok <- SkillMaterializer.materialize("claude_code", config, cwd),
             :ok <- validate_credentials(config) do
          options = normalize_options(config)
          Bridge.start_session(cwd, options)
        end
    end
  end

  @impl true
  def run_turn(%{worker_bridge: true} = session, _prompt, %WorkItem{}) do
    WorkerBridgeRouting.run_turn(session, "claude_code")
  end

  def run_turn(session, prompt, %WorkItem{} = work_item) when is_map(session) do
    on_message =
      session.options
      |> Map.get("on_message", fn _message -> :ok end)
      |> normalize_event_callback(session)

    case Bridge.run_turn(session, prompt, work_item, on_message) do
      {:ok, result} ->
        {:ok,
         %{
           result: Map.get(result, "result"),
           session_id: Map.get(result, "sessionId") || session.session_id,
           raw_result: result
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl SymphonyElixir.Runner.CodingRunner
  def send_input(session, input, work_item, opts) when is_map(session) and is_list(opts) do
    with {:ok, prompt} <- Contract.normalize_coding_input(input) do
      session
      |> maybe_put_on_message(Keyword.get(opts, :on_message))
      |> run_turn(prompt, work_item)
    end
  end

  @impl SymphonyElixir.Runner.CodingRunner
  def interrupt(session, opts) when is_map(session), do: Bridge.interrupt(session, opts)

  @impl SymphonyElixir.Runner.CodingRunner
  def stream_capabilities do
    Contract.coding_capabilities(
      input: :turn,
      output_stream: :runner_events,
      interrupt: :supported,
      tool_activity: true,
      metadata: %{backend: "claude_agent_bridge"}
    )
  end

  @impl true
  def stop_session(%{probe_only: true}), do: :ok
  def stop_session(%{worker_bridge: true} = session), do: WorkerBridgeRouting.stop_session(session)

  def stop_session(session), do: Bridge.stop(session)

  @impl true
  def ping(config) when is_map(config) do
    cond do
      is_nil(System.find_executable("node")) and blank?(config_value(config, "bridge_command")) ->
        {:error, :node_not_found}

      is_nil(config_value(config, "bridge_command")) and not File.exists?(default_bridge_path()) ->
        {:error, {:bridge_not_found, default_bridge_path()}}

      true ->
        validate_credentials(config)
    end
  end

  @impl true
  def requires_workspace?, do: true

  defp validate_workspace_cwd(workspace, config) when is_binary(workspace) do
    configured_cwd = config_value(config, "cwd")

    expanded_workspace = Path.expand(workspace)

    with :ok <- validate_configured_cwd(configured_cwd, expanded_workspace),
         {:ok, canonical_root} <- workspace_root(config) do
      PathSafety.validate_local_workspace_cwd(expanded_workspace, canonical_root)
    end
  end

  defp validate_workspace_cwd(_workspace, _config), do: {:error, {:invalid_workspace_cwd, :missing_workspace}}

  defp validate_configured_cwd(nil, _workspace), do: :ok

  defp validate_configured_cwd(configured_cwd, workspace) do
    if Path.expand(configured_cwd) == workspace do
      :ok
    else
      {:error, {:invalid_workspace_cwd, :configured_cwd_mismatch, configured_cwd, workspace}}
    end
  end

  defp workspace_root(config) do
    root = config_value(config, "workspace_root") || Config.settings!().workspace.root
    PathSafety.canonicalize(Path.expand(root))
  end

  defp validate_credentials(config) do
    cond do
      present?(config_value(config, "api_key")) ->
        :ok

      present?(config_value(config, "credential_ref")) ->
        :ok

      present?(System.get_env("ANTHROPIC_API_KEY")) ->
        :ok

      config_value(config, "bridge_command") ->
        :ok

      true ->
        {:error, :missing_anthropic_api_key}
    end
  end

  defp normalize_options(config) do
    config
    |> stringify_keys()
    |> Map.put_new("permission_mode", "acceptEdits")
  end

  defp maybe_put_on_message(session, nil), do: session

  defp maybe_put_on_message(%{options: options} = session, on_message) when is_function(on_message, 1) do
    Map.put(session, :options, Map.put(options, "on_message", on_message))
  end

  defp maybe_put_on_message(session, _on_message), do: session

  defp normalize_event_callback(on_message, session) when is_function(on_message, 1) do
    fn message ->
      opts = [
        provider: Map.get(session.options, "provider") || Map.get(session.options, "model_provider"),
        model: Map.get(session.options, "model")
      ]

      case EventMapper.normalize(message, opts) do
        {:ok, event} -> on_message.(event)
        {:error, _reason} -> :ok
      end
    end
  end

  defp normalize_event_callback(_on_message, _session), do: fn _message -> :ok end

  defp default_bridge_path do
    :code.priv_dir(:symphony_elixir)
    |> Path.join("claude_agent_bridge/bridge.js")
  end

  defp config_value(config, key) do
    Map.get(config, key) || Map.get(config, String.to_atom(key))
  end

  defp stringify_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), value}
      {key, value} -> {key, value}
    end)
  end

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false
  defp blank?(value), do: not present?(value)

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
