defmodule SymphonyElixir.Gateway.ChatRunner do
  @moduledoc """
  Default gateway chat runner. Resolves the agent's runner kind from the
  routing rules and dispatches to the matching runner module:

    * planning agent type   -> `Runner.Planner`
    * manager agent type    -> `Runner.LlmToolRunner`
    * `local_model_coding`  -> `Runner.LocalModelCoding`
    * `local_relay`         -> `Runner.LocalRelay`
    * everything else       -> `Codex.AppServer`
  """

  require Logger

  alias SymphonyElixir.{AgentInventory, AgentInventory.Agent, Codex.AppServer, ExecutionProfile, Runner, ToolRegistry, WorkItem, Workspace}
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Gateway.AgentExecutionProfile
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @spec run(map(), map(), String.t(), String.t(), pid()) :: :ok
  def run(agent, scope, prompt, run_id, owner_pid) when is_map(scope) and is_binary(prompt) do
    cond do
      Agent.planning?(agent) ->
        Logger.info("ChatRunner.dispatch agent_id=#{scope.agent_id} branch=planner")
        run_planner(agent, scope, prompt, run_id, owner_pid)

      Agent.kind?(agent, "manager") ->
        Logger.info("ChatRunner.dispatch agent_id=#{scope.agent_id} branch=manager")
        run_manager(agent, scope, prompt, run_id, owner_pid)

      true ->
        kind = resolved_runner_kind(scope)
        Logger.info("ChatRunner.dispatch agent_id=#{scope.agent_id} resolved_runner_kind=#{inspect(kind)}")

        case kind do
          "local_model_coding" ->
            run_local_model_coding(agent, scope, prompt, run_id, owner_pid)

          "local_relay" ->
            run_local_relay(agent, scope, prompt, run_id, owner_pid)

          _ ->
            run_codex(agent, scope, prompt, run_id, owner_pid)
        end
    end

    :ok
  end

  defp resolved_runner_kind(%{agent_id: agent_id, workspace_id: workspace_id})
       when is_binary(agent_id) and is_binary(workspace_id) do
    case AgentExecutionProfile.resolve(agent_id, workspace_id) do
      {:ok, %{runner_kind: kind}} when is_binary(kind) ->
        kind

      {:error, reason} ->
        Logger.warning("ChatRunner.resolved_runner_kind agent=#{agent_id} workspace=#{workspace_id} fallback_to=codex reason=#{inspect(reason)}")

        nil
    end
  end

  defp resolved_runner_kind(_scope), do: nil

  defp run_codex(agent, scope, prompt, run_id, owner_pid) do
    issue = %{
      id: agent.id || scope.agent_id,
      identifier: agent.slug || agent.id || scope.agent_id,
      title: agent.name || "Chat Session",
      description: agent.context
    }

    with {:ok, workspace} <- Workspace.create_for_issue(issue.identifier),
         {:ok, result} <-
           AppServer.run(
             workspace,
             prompt,
             issue,
             trace_id: Process.get(:symphony_trace_id),
             on_message: fn message ->
               send(owner_pid, {:gateway_runner_event, scope.session_key, run_id, message})
             end
           ) do
      # AppServer.run's result map doesn't surface the model/provider
      # the Codex worker used. Fall back to the agent's configured
      # model_settings so the gateway socket can persist them on the
      # assistant message row instead of writing model=null/provider=null.
      enriched =
        result
        |> Map.put_new("model", agent_model(agent))
        |> Map.put_new("provider", agent_provider(agent) || "openai")

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, enriched}})
    else
      {:error, reason} ->
        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
    end
  end

  defp run_planner(agent, scope, prompt, run_id, owner_pid) do
    on_message = fn message ->
      send(owner_pid, {:gateway_runner_event, scope.session_key, run_id, message})
    end

    work_item = %WorkItem{
      id: scope.session_key,
      identifier: agent.slug || agent.id || scope.agent_id,
      title: agent.name || "Planning Session",
      description: agent.context,
      source: "gateway",
      runner_type: "planner"
    }

    config =
      %{
        agent: agent,
        trace_id: Process.get(:symphony_trace_id),
        on_message: on_message
      }
      |> inject_planner_credentials(agent)

    with {:ok, session} <- Runner.Planner.start_session(config, nil),
         {:ok, result} <- Runner.Planner.run_turn(session, prompt, work_item),
         :ok <- Runner.Planner.stop_session(session) do
      # The planner client's response_result/1 only returns
      # status/response_id/output_text — annotate the result so the
      # gateway socket can persist model + provider on the assistant
      # message row instead of writing model=null/provider=null.
      enriched =
        result
        |> Map.put_new("model", Map.get(session, :model) || agent_model(agent))
        |> Map.put_new("provider", agent_provider(agent) || "openai")

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, enriched}})
    else
      {:error, reason} ->
        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
    end
  end

  defp run_manager(agent, scope, prompt, run_id, owner_pid) do
    work_item = %WorkItem{
      id: scope.session_key,
      identifier: agent.slug || agent.id || scope.agent_id,
      title: agent.name || "Manager Session",
      description: agent.context,
      source: "gateway",
      runner_type: "manager",
      metadata: %{"run_id" => run_id}
    }

    forward = fn message ->
      send(owner_pid, {:gateway_runner_event, scope.session_key, run_id, message})
    end

    case manager_session(scope) do
      {:ok, session, _details, ownership} ->
        # Compose: preserve any configured on_message hook and forward each
        # event to the gateway owner so websocket and scheduler callers can
        # collect deltas/tool metadata through the shared chat gateway.
        existing_on_message = Map.get(session, :on_message)

        wrapped = fn message ->
          if is_function(existing_on_message, 1) do
            existing_on_message.(message)
          end

          forward.(message)
        end

        session = Map.put(session, :on_message, wrapped)
        provider = Map.get(session, :provider)
        model = Map.get(session, :model)

        try do
          case manager_runner(session).run_turn(session, prompt, work_item) do
            {:ok, result} ->
              enriched =
                result
                |> Map.put_new("model", model)
                |> Map.put_new("provider", provider)

              send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, enriched}})

            {:error, reason} ->
              send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
          end
        after
          maybe_stop_manager_session(session, ownership)
        end

      {:idle, reason, _details} ->
        Logger.warning("ChatRunner.run_manager idle agent=#{scope.agent_id} workspace=#{scope.workspace_id} reason=#{inspect(reason)}")

        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, {:agent_idle, reason}})

      {:error, reason, _details} ->
        Logger.warning("ChatRunner.run_manager error agent=#{scope.agent_id} workspace=#{scope.workspace_id} reason=#{inspect(reason)}")

        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
    end
  end

  defp manager_session(%{manager_session: session}) when is_map(session) do
    {:ok, session, %{}, :caller_owned}
  end

  defp manager_session(scope) do
    case Application.get_env(:symphony_elixir, :gateway_manager_session_resolver) do
      resolver when is_atom(resolver) and not is_nil(resolver) ->
        case resolver.resolve(scope.workspace_id) do
          {:ok, session, details} -> {:ok, session, details, :chat_runner_owned}
          other -> other
        end

      _ ->
        resolve_manager_session_from_profile(scope)
    end
  end

  defp resolve_manager_session_from_profile(scope) do
    with {:ok, profile} <- AgentExecutionProfile.resolve(scope.agent_id, scope.workspace_id),
         config <- llm_tool_runner_config(profile, scope),
         {:ok, session} <- Runner.LlmToolRunner.start_session(config, nil) do
      session =
        session
        |> Map.put(:runner, Runner.LlmToolRunner)
        |> Map.put(:workspace_id, scope.workspace_id)
        |> Map.put(:session_key, scope.session_key)

      {:ok, session, profile, :chat_runner_owned}
    else
      {:error, :not_found} ->
        {:idle, :config_missing, %{status: :idle_awaiting_config}}

      {:error, :credential_missing} ->
        {:idle, :credential_missing, %{status: :idle_awaiting_credential}}

      {:error, {:credential_unresolved, reason}} ->
        {:idle, :credential_unresolved, %{status: :idle_awaiting_credential, reason: inspect(reason)}}

      {:error, {:provider_unsupported, provider}} ->
        {:idle, :provider_unsupported, %{status: :idle_awaiting_config, provider: provider}}

      {:error, reason} ->
        {:error, reason, %{status: :error}}
    end
  end

  defp manager_runner(session) do
    Map.get(session, :runner) || Runner.LlmToolRunner
  end

  defp maybe_stop_manager_session(session, :chat_runner_owned) do
    runner = manager_runner(session)

    if function_exported?(runner, :stop_session, 1) do
      runner.stop_session(session)
    else
      :ok
    end
  end

  defp maybe_stop_manager_session(_session, :caller_owned), do: :ok

  defp maybe_stop_manager_session(_session, _ownership), do: :ok

  defp inject_planner_credentials(config, agent) do
    with agent_id when is_binary(agent_id) and agent_id != "" <- agent_id(agent),
         {:ok, credentials} <- AgentInventory.list_credentials(agent_id),
         {:ok, resolved} <- resolve_stored_credentials(credentials) do
      merge_credentials_map(config, resolved)
    else
      nil ->
        config

      "" ->
        config

      {:error, reason} ->
        Logger.warning("ChatRunner could not resolve planner credentials agent=#{inspect(agent_id(agent))} reason=#{inspect(reason)}")

        config
    end
  end

  defp resolve_stored_credentials(credentials) when is_list(credentials) do
    Enum.reduce(credentials, {:ok, %{}}, fn %StoredCredential{} = credential, {:ok, acc} ->
      case SecretResolver.resolve(credential) do
        {:ok, env_map} when is_map(env_map) ->
          {:ok, Map.merge(env_map, acc)}

        {:error, reason} ->
          Logger.warning("ChatRunner skipped planner credential #{inspect(credential.id)} env_var=#{inspect(credential.env_var)} reason=#{inspect(reason)}")

          {:ok, acc}
      end
    end)
  end

  defp resolve_stored_credentials(_credentials), do: {:error, :invalid_credentials}

  defp merge_credentials_map(config, credentials) when is_map(credentials) do
    existing =
      case Map.get(config, :credentials) || Map.get(config, "credentials") do
        %{} = map -> map
        _ -> %{}
      end

    Map.put(config, :credentials, Map.merge(credentials, existing))
  end

  defp llm_tool_runner_config(profile, scope) do
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
      "base_url" => default_base_url(profile),
      "trace_id" => Process.get(:symphony_trace_id),
      "history_window" => Map.get(scope, :history_window) || Map.get(scope, "history_window"),
      message_recorder_scope: scope
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp default_base_url(%{provider: "openai_compatible"}) do
    System.get_env("MANAGER_OPENAI_COMPATIBLE_BASE_URL") ||
      System.get_env("LOCAL_MODEL_BASE_URL") ||
      "http://127.0.0.1:11434/v1"
  end

  defp default_base_url(_profile), do: nil

  defp run_local_model_coding(agent, scope, prompt, run_id, owner_pid) do
    on_message = fn message ->
      send(owner_pid, {:gateway_runner_event, scope.session_key, run_id, message})
    end

    work_item = %WorkItem{
      id: scope.session_key,
      identifier: agent.slug || agent.id || scope.agent_id,
      title: agent.name || "Coding Session",
      description: agent.context,
      source: "gateway",
      runner_type: "local_model_coding"
    }

    # The agent's tool_policy carries the user-chosen workspace_root for
    # local coding. We only ever pass a real, existing directory through
    # to the runner — if the user hasn't set one (or the directory was
    # removed), we run the chat with workspace=nil and let the tool
    # calling loop surface a friendly "no workspace" error per tool call
    # instead of crashing the whole turn.
    workspace = resolve_agent_workspace(agent)

    with {:ok, profile} <- AgentExecutionProfile.resolve(scope.agent_id, scope.workspace_id),
         {:ok, session} <-
           Runner.LocalModelCoding.start_session(
             local_model_coding_config(profile, on_message),
             workspace
           ),
         {:ok, result} <- Runner.LocalModelCoding.run_turn(session, prompt, work_item),
         :ok <- Runner.LocalModelCoding.stop_session(session) do
      # Annotate the result with model + provider so the gateway socket
      # can persist them on the assistant message row (otherwise the
      # MessageLog row ends up with model=null/provider=null and the
      # dashboard can't tell which model served the response).
      enriched =
        result
        |> Map.put_new("model", Map.get(session, :model))
        |> Map.put_new("provider", Map.get(session, :provider))

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, enriched}})
    else
      {:error, reason} ->
        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
    end
  end

  defp local_model_coding_config(profile, on_message) do
    # Routing rules for local_model_coding agents typically carry no
    # credential (Ollama et al. don't need one). The openai_compatible
    # provider still requires base_url + bearer_token to be non-empty,
    # so synthesize dev defaults from env when the profile doesn't
    # override them.
    base_url = local_chat_base_url()
    api_key = local_chat_api_key()

    # Intentionally omit :tool_definitions so Runner.LocalModelCoding
    # falls through to its default coding-bundle tools (apply_patch,
    # shell.exec, repo.list, repo.read_file, repo.search) with the
    # local-coding schema stripping already applied. Agent-grant-driven
    # tool filtering can layer on top via ToolRegistry.resolve_for_agent
    # in a follow-up.
    %{
      provider: Map.get(profile, :provider) || "openai_compatible",
      model: Map.get(profile, :model),
      base_url: base_url,
      api_key: api_key,
      on_message: on_message,
      metadata:
        %{
          "trace_id" => Process.get(:symphony_trace_id),
          "source" => "gateway_chat",
          "agent_id" => Map.get(profile, :agent_id),
          "workspace_id" => Map.get(profile, :workspace_id)
        }
        |> Enum.reject(fn {_key, value} -> is_nil(value) end)
        |> Map.new()
    }
  end

  defp run_local_relay(agent, scope, prompt, run_id, owner_pid) do
    on_message = fn message ->
      send(owner_pid, {:gateway_runner_event, scope.session_key, run_id, message})
    end

    work_item = %WorkItem{
      id: scope.session_key,
      identifier: agent.slug || agent.id || scope.agent_id,
      title: agent.name || "Local Relay Session",
      description: agent.context,
      source: "gateway",
      runner_type: "local_relay",
      # Runner.LocalRelay reads run_id/session_id for the dispatch frame
      # from work item metadata rather than from the session.
      metadata: %{"run_id" => run_id, "session_id" => scope.session_key}
    }

    with {:ok, profile} <- AgentExecutionProfile.resolve(scope.agent_id, scope.workspace_id),
         {:ok, session} <- Runner.LocalRelay.start_session(local_relay_config(profile, scope, on_message), nil),
         {:ok, result} <- Runner.LocalRelay.run_turn(session, prompt, work_item),
         :ok <- Runner.LocalRelay.stop_session(session) do
      # Annotate the result with model + provider so the gateway socket
      # can persist them on the assistant message row.
      enriched =
        result
        |> Map.put_new("model", Map.get(session, :model))
        |> Map.put_new("provider", Map.get(session, :provider))

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, {:ok, enriched}})
    else
      {:error, reason} ->
        send(owner_pid, {:gateway_runner_failed, scope.session_key, run_id, reason})
    end
  end

  # CLI tools whose execution + auth must follow the local model onto the
  # user's machine: the helper shells out to git/gh with the laptop's own CLI
  # session. The cloud loop delegates these by execution_kind (see
  # ToolCallingLoop.ToolExecutionDispatcher); everything else stays runtime-side.
  @local_helper_cli_tools ["git.run"]

  defp local_relay_config(profile, scope, on_message) do
    # The helper owns the model turn; the runtime owns the tool-calling loop
    # (tool_calling_mode "cloud_managed" -> Runner.ToolCallingLoop). Most tools
    # still execute runtime-side, but CLI tools are marked execution_kind
    # "helper" so a local model runs git/gh on the user's machine with local
    # auth.
    %{
      "workspace_id" => profile.workspace_id,
      "agent_id" => profile.agent_id,
      "user_id" => Map.get(profile, :user_id) || Map.get(scope, :user_id),
      "session_id" => scope.session_key,
      "provider" => Map.get(profile, :provider) || "local",
      "model" => Map.get(profile, :model),
      # A provider naming a helper-advertisable runtime (openclaw et al.)
      # selects which registered helper runner serves the dispatch; nil
      # falls back to Runner.LocalRelay's "openai_compatible" default.
      "target_runner_kind" => ExecutionProfile.local_relay_target_runner_kind(Map.get(profile, :provider)),
      "credential_ref" => Map.get(profile, :credential_ref),
      "tool_definitions" => local_relay_tool_definitions(profile),
      "tool_calling_mode" => "cloud_managed",
      "trace_id" => Process.get(:symphony_trace_id),
      "on_message" => on_message
    }
  end

  # The tools the local model is offered, with CLI tools marked execution_kind
  # "helper" so they run on the user's machine. Primary source is the agent's
  # granted tools (`agent_tool_grant`), so a local-model agent gets exactly the
  # tools it was granted (repo.*, shell.exec, scheduled_task.*, git.run, ...).
  # Falls back to the universal bundle + git.run for agents with no grants, to
  # preserve prior behavior.
  defp local_relay_tool_definitions(profile) do
    profile
    |> agent_granted_definitions()
    |> mark_local_helper_tools()
  end

  defp agent_granted_definitions(profile) do
    with agent_id when is_binary(agent_id) and agent_id != "" <- Map.get(profile, :agent_id),
         {:ok, %{tool_definitions: definitions}} when is_list(definitions) and definitions != [] <-
           ToolRegistry.resolve_for_agent(agent_id) do
      definitions
    else
      _ ->
        ToolRegistry.definitions(ToolRegistry.bundle(:universal)) ++
          ToolRegistry.definitions(@local_helper_cli_tools)
    end
  end

  defp mark_local_helper_tools(definitions) do
    Enum.map(definitions, fn definition ->
      if is_map(definition) and tool_definition_name(definition) in @local_helper_cli_tools do
        Map.put(definition, "execution_kind", "helper")
      else
        definition
      end
    end)
  end

  defp tool_definition_name(definition) do
    Map.get(definition, "name") || Map.get(definition, :name) ||
      Map.get(definition, "slug") || Map.get(definition, :slug)
  end

  defp local_chat_base_url do
    System.get_env("GATEWAY_LOCAL_CHAT_BASE_URL") ||
      System.get_env("LOCAL_MODEL_BASE_URL") ||
      "http://localhost:11434/v1"
  end

  defp local_chat_api_key do
    # Ollama ignores the bearer token entirely; the provider just needs
    # something non-empty so its `bearer_token/1` check passes. Real
    # local-coding deployments that *do* need an API key should set
    # GATEWAY_LOCAL_CHAT_API_KEY (or LOCAL_MODEL_API_KEY) explicitly.
    System.get_env("GATEWAY_LOCAL_CHAT_API_KEY") ||
      System.get_env("LOCAL_MODEL_API_KEY") ||
      "ollama"
  end

  defp resolve_agent_workspace(agent) do
    tool_policy = Map.get(agent, :tool_policy) || Map.get(agent, "tool_policy") || %{}

    execution_target =
      Map.get(tool_policy, "executionTarget") ||
        Map.get(tool_policy, :executionTarget) ||
        %{}

    raw =
      Map.get(execution_target, "workspace_root") ||
        Map.get(execution_target, :workspace_root)

    case raw do
      path when is_binary(path) and path != "" ->
        expanded = Path.expand(path)
        if File.dir?(expanded), do: expanded, else: nil

      _ ->
        nil
    end
  end

  defp agent_model(agent), do: model_settings_value(agent, "model")
  defp agent_provider(agent), do: model_settings_value(agent, "provider")

  defp agent_id(%Agent{id: id}), do: id
  defp agent_id(%{id: id}), do: id
  defp agent_id(%{"id" => id}), do: id
  defp agent_id(_agent), do: nil

  defp model_settings_value(agent, key) do
    settings = Map.get(agent, :model_settings) || Map.get(agent, "model_settings") || %{}

    case Map.get(settings, key) || Map.get(settings, String.to_atom(key)) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end
end
