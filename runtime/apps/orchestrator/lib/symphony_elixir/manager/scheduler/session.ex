defmodule SymphonyElixir.Manager.Scheduler.Session do
  @moduledoc false

  alias SymphonyElixir.Gateway.AgentExecutionProfile
  alias SymphonyElixir.Manager.SchedulerStatus
  alias SymphonyElixir.Runner
  alias SymphonyElixir.ToolRegistry

  @spec initial(String.t(), String.t(), keyword()) ::
          {map(), :explicit | :resolved, map(), atom() | nil, map() | nil}
  def initial(workspace_id, agent_id, opts) do
    case Keyword.fetch(opts, :session) do
      {:ok, session} when is_map(session) ->
        {session, :explicit, %{}, nil, nil}

      :error ->
        case resolve_for_agent(resolver(opts), workspace_id, agent_id, resolver_opts(opts)) do
          {:ok, session, details} ->
            {session, :resolved, details, nil, nil}

          {:idle, reason, details} ->
            {%{workspace_id: workspace_id}, :resolved, details, reason, nil}

          {:error, reason, details} ->
            {%{workspace_id: workspace_id}, :resolved, Map.put(details, :reason, inspect(reason)), :manager_session_error, SchedulerStatus.normalize_error(reason)}
        end
    end
  end

  @spec refresh(map()) :: map()
  def refresh(%{session_mode: :explicit} = state), do: state

  def refresh(%{session_mode: :resolved} = state) do
    if runnable?(state), do: refresh_running(state), else: resolve(state)
  end

  @spec runnable?(map()) :: boolean()
  def runnable?(%{idle_reason: nil, session: session}) when is_map(session),
    do: Map.has_key?(session, :runner)

  def runnable?(_state), do: false

  @spec resolver(keyword()) :: module()
  def resolver(opts) do
    Keyword.get(opts, :session_resolver, default_resolver())
  end

  @spec resolver_opts(keyword()) :: keyword()
  def resolver_opts(opts), do: Keyword.take(opts, [:agent_inventory, :secret_resolver, :runner])

  defp refresh_running(state) do
    case identity(state) do
      {:ok, details} ->
        if same_details?(state.session_details, details) and runnable?(state) do
          %{state | session_details: details, idle_reason: nil, session_error: nil}
        else
          resolve(state)
        end

      {:idle, reason, details} ->
        stop(state.session)

        %{
          state
          | session: %{workspace_id: state.workspace_id},
            session_details: details,
            idle_reason: reason,
            session_error: nil
        }

      {:error, reason, details} ->
        error_state(state, reason, details)
    end
  end

  defp identity(state) do
    case resolve_profile(state.session_resolver, state.agent_id, state.workspace_id, state.session_resolver_opts) do
      {:ok, profile} -> {:ok, details(profile)}
      other -> normalize_error(other)
    end
  end

  defp resolve(state) do
    case resolve_for_agent(state.session_resolver, state.workspace_id, state.agent_id, state.session_resolver_opts) do
      {:ok, session, details} ->
        stop(state.session)
        %{state | session: session, session_details: details, idle_reason: nil, session_error: nil}

      {:idle, reason, details} ->
        stop(state.session)

        %{
          state
          | session: %{workspace_id: state.workspace_id},
            session_details: details,
            idle_reason: reason,
            session_error: nil
        }

      {:error, reason, details} ->
        error_state(state, reason, details)
    end
  end

  defp error_state(state, reason, details) do
    stop(state.session)

    %{
      state
      | session: %{workspace_id: state.workspace_id},
        session_details: Map.put(details, :reason, inspect(reason)),
        idle_reason: :manager_session_error,
        session_error: SchedulerStatus.normalize_error(reason)
    }
  end

  defp resolve_for_agent(resolver, workspace_id, agent_id, opts) do
    runner = Keyword.get(opts, :runner, Runner.LlmToolRunner)

    with {:ok, profile} <- resolve_profile(resolver, agent_id, workspace_id, opts),
         config <- runner_config(profile),
         {:ok, session} <- runner.start_session(config, nil) do
      session =
        session
        |> Map.put(:runner, runner)
        |> Map.put(:workspace_id, workspace_id)
        |> Map.put(:session_key, "agent:#{agent_id}:main")

      {:ok, session, details(profile)}
    else
      other -> normalize_error(other)
    end
  end

  defp resolve_profile(resolver, agent_id, workspace_id, opts) do
    profile_opts = Keyword.take(opts, [:agent_inventory, :secret_resolver])

    # Resolver modules can be lazy-loaded in the bundled launcher, so load
    # them before checking which supported resolve callback they export.
    case Code.ensure_loaded(resolver) do
      {:module, _} ->
        cond do
          function_exported?(resolver, :resolve, 3) -> resolver.resolve(agent_id, workspace_id, profile_opts)
          function_exported?(resolver, :resolve, 2) -> resolver.resolve(agent_id, workspace_id)
          true -> {:error, {:invalid_profile_resolver, resolver}}
        end

      {:error, reason} ->
        {:error, {:resolver_not_loadable, resolver, reason}}
    end
  end

  defp normalize_error({:error, :not_found}), do: {:idle, :config_missing, %{status: :idle_awaiting_config}}
  defp normalize_error({:error, :credential_missing}), do: {:idle, :credential_missing, %{status: :idle_awaiting_credential}}

  defp normalize_error({:error, {:credential_unresolved, reason}}),
    do: {:idle, :credential_unresolved, %{status: :idle_awaiting_credential, reason: inspect(reason)}}

  defp normalize_error({:error, {:provider_unsupported, provider}}),
    do: {:idle, :provider_unsupported, %{status: :idle_awaiting_config, provider: provider}}

  defp normalize_error({:error, reason}), do: {:error, reason, %{status: :error}}
  defp normalize_error(other), do: other

  defp runner_config(profile) do
    %{
      "agent_id" => profile.agent_id,
      "workspace_id" => profile.workspace_id,
      "provider" => profile.provider,
      "model" => profile.model,
      "credential_id" => Map.get(profile, :credential_id),
      "credential_alias" => Map.get(profile, :credential_alias),
      "api_key" => Map.get(profile, :api_key),
      "user_id" => Map.get(profile, :user_id),
      "agent_type" => "manager",
      "tool_bundle" => "manager",
      "agent_context" => Map.get(profile, :context),
      "base_url" => base_url(profile),
      "trace_id" => Process.get(:symphony_trace_id)
    }
    |> put_tool_definitions(profile)
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp put_tool_definitions(config, profile) do
    case tool_definitions(profile) do
      definitions when is_list(definitions) and definitions != [] -> Map.put(config, "tool_definitions", definitions)
      _ -> config
    end
  end

  defp tool_definitions(profile) do
    case Map.get(profile, :tool_definitions) || Map.get(profile, "tool_definitions") do
      definitions when is_list(definitions) and definitions != [] -> definitions
      _ -> resolve_tool_definitions(profile.agent_id)
    end
  end

  defp resolve_tool_definitions(agent_id) when is_binary(agent_id) and agent_id != "" do
    resolver = Application.get_env(:symphony_elixir, :manager_tool_definition_resolver, ToolRegistry)

    case resolver.resolve_for_agent(agent_id) do
      {:ok, %{tool_definitions: definitions}} when is_list(definitions) -> definitions
      _ -> []
    end
  rescue
    _ -> []
  end

  defp resolve_tool_definitions(_agent_id), do: []

  defp base_url(%{provider: "openai_compatible"}) do
    System.get_env("MANAGER_OPENAI_COMPATIBLE_BASE_URL") ||
      System.get_env("LOCAL_MODEL_BASE_URL") ||
      "http://127.0.0.1:11434/v1"
  end

  defp base_url(_profile), do: nil

  defp details(profile) do
    %{
      status: :running,
      agent_id: profile.agent_id,
      credential_id: Map.get(profile, :credential_id),
      credential_alias: Map.get(profile, :credential_alias),
      provider: profile.provider,
      model: profile.model,
      agent_context: Map.get(profile, :context),
      tool_definitions_hash: tool_definitions_hash(tool_definitions(profile)),
      routing_rule_id: get_in(profile, [:source_metadata, "routing_rule_id"])
    }
  end

  defp tool_definitions_hash(definitions) when is_list(definitions) do
    definitions |> :erlang.term_to_binary() |> then(&:crypto.hash(:sha256, &1)) |> Base.encode16(case: :lower)
  end

  defp tool_definitions_hash(_definitions), do: nil

  defp same_details?(current, next) when is_map(current) and is_map(next) do
    Map.take(current, identity_keys()) == Map.take(next, identity_keys())
  end

  defp identity_keys do
    [:agent_id, :credential_id, :provider, :model, :agent_context, :tool_definitions_hash, :config_hash, :config_version]
  end

  defp stop(%{runner: runner} = session) when is_atom(runner) do
    if function_exported?(runner, :stop_session, 1), do: runner.stop_session(session)
  catch
    :exit, _reason -> :ok
  end

  defp stop(_session), do: :ok

  defp default_resolver do
    Application.get_env(:symphony_elixir, :manager_scheduler_session_resolver, AgentExecutionProfile)
  end
end
