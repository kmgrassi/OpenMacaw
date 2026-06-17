defmodule SymphonyElixir.Launcher.AgentStarter do
  @moduledoc """
  Builds and validates agent launch configs for `SymphonyElixir.Launcher.Server`.

  Owns the read-only side of "start an agent": fetching gateway config, layering
  in stored credentials and stored agent metadata, normalizing the execution
  profile, and asserting required fields are present. Pure functions — no
  GenServer state, no process spawning.

  ## Outputs

  - `resolve_and_validate_agent_config/2` — full agent launch path. Returns
    `{:ok, config, resolution}` (resolution may be `nil` for the local
    template fallback) or `{:error, reason}`.
  - `normalize_execution_profile/1` — used for both the agent path and the
    legacy `start_orchestrator` path.
  - `inject_plan_handoff/2` — small helper used by the server after resolution.
  """

  require Logger

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Launcher.GatewayConfig
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @spec resolve_and_validate_agent_config(Agent.t(), map()) ::
          {:ok, map(), map() | nil} | {:error, term()}
  def resolve_and_validate_agent_config(%Agent{} = agent, launch_params) do
    case resolve_and_validate_agent_config_with_metadata(agent, launch_params) do
      {:ok, config, resolution, _metadata} -> {:ok, config, resolution}
      {:error, _reason} = error -> error
    end
  end

  @spec resolve_and_validate_agent_config_with_metadata(Agent.t(), map()) ::
          {:ok, map(), map() | nil, map()} | {:error, term()}
  def resolve_and_validate_agent_config_with_metadata(%Agent{} = agent, launch_params) do
    result =
      with {:ok, base, resolution} <- resolve_launch_config(agent, launch_params) do
        {merged, credential_refresh} =
          base
          |> inject_stored_agent(agent)
          |> inject_stored_credentials(agent.id)

        with {:ok, merged, _profile} <- normalize_agent_execution_profile(merged) do
          case get_in(merged, ["tracker", "kind"]) do
            kind when is_binary(kind) and kind != "" ->
              {:ok, merged, resolution, %{credential_refresh: credential_refresh}}

            _ ->
              {:error,
               {:invalid_agent_config, "agent launch config tracker.kind is required",
                %{
                  error_code: "missing_tracker_kind",
                  required_config: ["tracker.kind"],
                  resolution_hint: "Create a gateway_config with tracker settings for this agent"
                }}}
          end
        end
      end

    annotate_invalid_agent_config(result, agent)
  end

  @spec normalize_execution_profile(map()) ::
          {:ok, map(), map()} | {:error, term()}
  def normalize_execution_profile(config) when is_map(config) do
    case ExecutionProfile.normalize_from_config(config) do
      {:ok, profile} ->
        config =
          if explicit_execution_profile?(config) do
            Map.put(config, "execution_profile", profile)
          else
            config
          end

        {:ok, config, profile}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec inject_plan_handoff(map(), map() | nil) :: map()
  def inject_plan_handoff(config, nil), do: config

  def inject_plan_handoff(config, handoff) when is_map(handoff),
    do: Map.put(config, "plan_handoff", handoff)

  # --- Private ---

  defp annotate_invalid_agent_config(
         {:error, {:invalid_agent_config, message, details}},
         %Agent{id: agent_id, workspace_id: workspace_id}
       )
       when is_map(details) do
    annotated =
      details
      |> Map.put_new(:agent_id, agent_id)
      |> Map.put_new(:workspace_id, workspace_id)

    {:error, {:invalid_agent_config, message, annotated}}
  end

  defp annotate_invalid_agent_config(result, _agent), do: result

  defp resolve_launch_config(%Agent{} = agent, launch_params) when is_map(launch_params) do
    case forwarded_execution_profile(launch_params) do
      %{} = profile ->
        with {:ok, base, resolution} <- resolve_launch_config(agent) do
          base =
            base
            |> maybe_put("trace_id", launch_trace_id(launch_params))
            |> Map.put("resolved_execution_profile", profile)

          {:ok, base, resolution}
        end

      nil ->
        resolve_launch_config(agent)
    end
  end

  defp resolve_launch_config(%Agent{} = agent, _launch_params), do: resolve_launch_config(agent)

  defp resolve_launch_config(%Agent{id: agent_id, workspace_id: workspace_id}) do
    with {:error, agent_reason} <- fetch_gateway_config("agent", agent_id),
         :continue <- fall_through(agent_reason),
         {:error, workspace_reason} <- fetch_gateway_config("workspace", workspace_id),
         :continue <- fall_through(workspace_reason) do
      local_template_fallback()
    else
      {:ok, _resolved, _resolution} = ok -> ok
      {:error, _} = error -> error
    end
  end

  defp normalize_agent_execution_profile(config) when is_map(config) do
    case normalize_execution_profile(config) do
      {:ok, _config, _profile} = ok ->
        ok

      {:error, reason} ->
        {:error,
         {:invalid_agent_config, "agent launch execution profile is invalid",
          %{
            error_code: "invalid_execution_profile",
            required_config: execution_profile_required_config(reason),
            resolution_hint: "Check model, provider, and runner settings",
            reason: reason
          }}}
    end
  end

  defp execution_profile_required_config({:missing_execution_profile_field, field})
       when is_binary(field),
       do: ["execution_profile.#{field}"]

  defp execution_profile_required_config(_reason), do: ["execution_profile"]

  defp explicit_execution_profile?(config) when is_map(config) do
    config = normalize_map(config)

    Enum.any?(["execution_profile", "resolved_execution_profile"], fn key ->
      case Map.get(config, key) do
        value when is_map(value) and map_size(value) > 0 -> true
        _ -> false
      end
    end) ||
      case get_in(config, ["runtime", "execution_profile"]) do
        value when is_map(value) and map_size(value) > 0 -> true
        _ -> false
      end
  end

  defp fetch_gateway_config(_scope_type, nil), do: {:error, :missing_scope_id}
  defp fetch_gateway_config(_scope_type, ""), do: {:error, :missing_scope_id}

  defp fetch_gateway_config(scope_type, scope_id)
       when is_binary(scope_type) and is_binary(scope_id) do
    case GatewayConfig.fetch(scope_type, scope_id) do
      {:ok, %Resolved{} = resolved} ->
        {:ok, normalize_map(resolved.config_json),
         %{
           scope_type: resolved.scope_type,
           scope_id: resolved.scope_id,
           config_hash: resolved.config_hash,
           version: resolved.version
         }}

      {:error, _reason} = error ->
        error
    end
  end

  defp fall_through(reason)
       when reason in [:not_found, :not_configured, :missing_scope_id, :invalid_scope],
       do: :continue

  defp fall_through(reason), do: {:error, reason}

  defp local_template_fallback do
    {:ok, local_template(), nil}
  end

  defp local_template do
    Application.get_env(:symphony_elixir, :agent_launch_template, %{})
    |> normalize_map()
  end

  defp forwarded_execution_profile(launch_params) when is_map(launch_params) do
    launch_params
    |> normalize_map()
    |> Map.get("resolved_execution_profile")
    |> case do
      %{} = profile when map_size(profile) > 0 -> normalize_execution_profile_keys(profile)
      _ -> nil
    end
  end

  defp forwarded_execution_profile(_launch_params), do: nil

  defp launch_trace_id(launch_params) do
    launch_params
    |> normalize_map()
    |> Map.get("trace_id")
  end

  defp normalize_execution_profile_keys(profile) when is_map(profile) do
    profile
    |> normalize_map()
    |> rename_profile_key("agentId", "agent_id")
    |> rename_profile_key("workspaceId", "workspace_id")
    |> rename_profile_key("runnerKind", "runner_kind")
    |> rename_profile_key("credentialRef", "credential_ref")
    |> rename_profile_key("toolProfile", "tool_profile")
    |> rename_profile_key("adapterConfig", "adapter_config")
    |> rename_profile_key("sourceMetadata", "source_metadata")
  end

  defp rename_profile_key(profile, source, target) do
    case Map.fetch(profile, source) do
      {:ok, value} -> profile |> Map.delete(source) |> Map.put_new(target, value)
      :error -> profile
    end
  end

  defp inject_stored_agent(base, %Agent{} = agent) do
    agent_runtime =
      %{
        "id" => agent.id,
        "type" => Agent.kind(agent),
        "name" => agent.name,
        "workspace_id" => agent.workspace_id,
        "project_id" => agent.project_id,
        "model_settings" => agent.model_settings,
        "tool_policy" => agent.tool_policy
      }
      |> Enum.reject(fn {_key, value} -> is_nil(value) end)
      |> Map.new()

    Map.put(base, "stored_agent", agent_runtime)
  end

  defp inject_stored_credentials(config, agent_id) when is_binary(agent_id) do
    case fetch_agent_credentials(agent_id) do
      {:ok, credentials, status} when map_size(credentials) == 0 ->
        {config, status}

      {:ok, credentials, status} ->
        merged =
          config
          |> merge_credentials_map(credentials)
          |> maybe_inject_linear_api_key(credentials)

        {merged, status}

      {:error, reason} ->
        Logger.warning("Launcher could not list credentials for agent #{agent_id}: #{inspect(reason)}. Starting without stored credentials.")

        {config, {:incomplete, reason}}
    end
  end

  defp inject_stored_credentials(config, _agent_id), do: {config, :not_requested}

  defp fetch_agent_credentials(agent_id) do
    case AgentInventory.list_credentials(agent_id) do
      {:ok, credentials} when is_list(credentials) ->
        resolve_stored_credentials(credentials)

      {:ok, value} ->
        {:error, {:invalid_credentials_response, value}}

      {:error, _reason} = error ->
        error
    end
  end

  defp resolve_stored_credentials([]), do: {:ok, %{}, :empty}

  defp resolve_stored_credentials(credentials) do
    {resolved, failures} =
      Enum.reduce(credentials, {%{}, []}, fn %StoredCredential{} = credential, {acc, failures} ->
        case SecretResolver.resolve(credential) do
          {:ok, env_map} when is_map(env_map) ->
            # AgentInventory returns newest credentials first, so keep existing
            # values when env vars collide and only fill gaps from older rows.
            {Map.merge(env_map, acc), failures}

          {:error, reason} ->
            Logger.warning("Launcher failed to resolve stored credential #{inspect(credential.id)} (env_var=#{inspect(credential.env_var)}): #{inspect(reason)}. Skipping.")

            failure = %{id: credential.id, env_var: credential.env_var, reason: reason}
            {acc, [failure | failures]}
        end
      end)

    case failures do
      [] -> {:ok, resolved, :complete}
      failures -> {:ok, resolved, {:incomplete, {:credential_resolution_failed, Enum.reverse(failures)}}}
    end
  end

  defp merge_credentials_map(config, credentials) do
    existing =
      case Map.get(config, "credentials") do
        %{} = map -> map
        _ -> %{}
      end

    Map.put(config, "credentials", Map.merge(credentials, existing))
  end

  defp maybe_inject_linear_api_key(config, credentials) do
    tracker_kind =
      config
      |> Map.get("tracker", %{})
      |> case do
        %{} = tracker -> Map.get(tracker, "kind")
        _ -> nil
      end

    case {tracker_kind, Map.get(credentials, "LINEAR_API_KEY")} do
      {"linear", value} when is_binary(value) and value != "" ->
        tracker =
          config
          |> Map.get("tracker", %{})
          |> case do
            %{} = map -> map
            _ -> %{}
          end

        tracker =
          case Map.get(tracker, "api_key") do
            existing when is_binary(existing) and existing != "" -> tracker
            _ -> Map.put(tracker, "api_key", value)
          end

        Map.put(config, "tracker", tracker)

      _ ->
        config
    end
  end

  defp normalize_map(value) when is_map(value) do
    Map.new(value, fn {k, v} -> {to_string(k), normalize_value(v)} end)
  end

  defp normalize_map(_value), do: %{}

  defp normalize_value(value) when is_map(value), do: normalize_map(value)
  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
