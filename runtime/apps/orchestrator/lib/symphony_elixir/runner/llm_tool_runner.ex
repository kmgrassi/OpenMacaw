defmodule SymphonyElixir.Runner.LlmToolRunner do
  @moduledoc """
  Generic LLM runner for agents whose turn loop is model + runtime tools.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.{AgentInventory, Attention, Cutover, MessageHistory, ToolExecutionContext, ToolRegistry, WorkItem}
  alias SymphonyElixir.LocalRelay.Registry, as: LocalRelayRegistry
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Manager.Prompt, as: ManagerPrompt
  alias SymphonyElixir.Manager.ModelClient
  alias SymphonyElixir.Planner.ToolNameMapping
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @responses_url "https://api.openai.com/v1/responses"
  @openai_compatible_base_url "http://127.0.0.1:11434/v1"
  @default_model "gpt-5.1"
  @default_max_tool_iterations 8

  # CLI tools the relay helper executes on the user's machine (with local
  # git/gh auth) instead of the orchestrator. Only relevant for local-relay
  # managers, where a helper is present to delegate to.
  @local_helper_cli_tools ["git.run"]

  @impl true
  def start_session(config, _workspace) when is_map(config) do
    if probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "manager"}}
      end
    else
      model_client = model_client(config)
      tool_specs = config |> tool_specs(model_client) |> mark_helper_cli_tools(model_client)
      allowed_tools = ToolRegistry.definition_names(tool_specs)
      provider_tool_name_map = ToolNameMapping.runtime_to_provider(allowed_tools)

      with {:ok, credential} <- resolve_credential(config, model_client),
           {:ok, state} <-
             Agent.start_link(fn ->
               %{previous_response_id: config_value(config, "previous_response_id")}
             end) do
        {:ok,
         %{
           api_key: credential.api_key,
           agent_id: config_value(config, "agent_id"),
           credential_id: credential.credential_id,
           credential_ref: credential_ref(config),
           credential_scope: Map.get(credential, :credential_scope),
           workspace_id: config_value(config, "workspace_id"),
           model: provider_model(config_value(config, "model")) || @default_model,
           model_tier_floor: model_tier_floor(config),
           fallbacks: fallback_links(config),
           prompt: runtime_prompt(config),
           state: state,
           tool_specs: tool_specs,
           allowed_tools: allowed_tools,
           provider_tool_name_map: provider_tool_name_map,
           model_client: model_client,
           provider: provider(config),
           target_runner_kind: config_value(config, "target_runner_kind") || "openai_compatible",
           capability_requirements: capability_requirements(config),
           timeout_ms: config_integer(config, "timeout_ms", 300_000),
           max_tool_iterations: config_integer(config, "max_tool_iterations", @default_max_tool_iterations),
           base_url: config_value(config, "base_url") || default_base_url(model_client),
           req_options: req_options(config, model_client),
           credentials: credentials(config),
           history_window: config_non_negative_integer(config, "history_window", MessageHistory.default_limit()),
           user_id: config_value(config, "user_id"),
           trace_id: config_value(config, "trace_id") || Process.get(:symphony_trace_id),
           on_message: Map.get(config, :on_message),
           message_recorder_scope: Map.get(config, :message_recorder_scope)
         }}
      end
    end
  end

  @impl true
  def run_turn(session, due_tasks_payload, %WorkItem{} = work_item)
      when is_map(session) and is_binary(due_tasks_payload) do
    run_id = work_item_run_id(work_item)

    session =
      session
      |> Map.put(:previous_response_id, previous_response_id(session))
      |> Map.put(:history, fetch_chat_history(session, run_id))
      |> Map.put(:current_speaker_label, MessageHistory.current_speaker_label(Map.get(session, :message_recorder_scope)))

    request =
      model_client_initial_request(
        session,
        MessageHistory.user_content(due_tasks_payload, Map.get(session, :current_speaker_label)),
        work_item
      )

    run_model_loop(session, request, 0, run_id)
  end

  defp fetch_chat_history(session, current_run_id) do
    MessageHistory.fetch(
      Map.get(session, :message_recorder_scope),
      limit: Map.get(session, :history_window, MessageHistory.default_limit()),
      exclude_run_id: current_run_id
    )
  end

  defp work_item_run_id(%WorkItem{metadata: metadata}) when is_map(metadata) do
    case Map.get(metadata, "run_id") || Map.get(metadata, :run_id) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp work_item_run_id(_work_item), do: nil

  @impl true
  def stop_session(%{state: state}) when is_pid(state) do
    Agent.stop(state, :normal)
  catch
    :exit, _reason -> :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    case resolve_credential(config, model_client(config)) do
      {:ok, _credential} -> :ok
      {:error, :no_credential} -> {:error, :no_credential}
    end
  end

  @impl true
  def requires_workspace?, do: false

  defp runtime_prompt(config) do
    base =
      case agent_type(config) do
        "manager" ->
          ManagerPrompt.load!() <>
            "\n\nCurrent time: #{DateTime.utc_now() |> DateTime.to_iso8601()}. Workspace timezone: Etc/UTC. When a user asks to pause or defer a work_item to a specific time, call snooze with until set to the resolved absolute ISO timestamp."

        _other ->
          config_value(config, "prompt") || "You are a helpful agent. Use the available tools when needed."
      end

    append_agent_context(base, config)
  end

  defp append_agent_context(prompt, config) do
    case config_value(config, "agent_context") do
      context when is_binary(context) ->
        case String.trim(context) do
          "" -> prompt
          trimmed -> prompt <> "\n\nAgent instructions:\n" <> trimmed
        end

      _ ->
        prompt
    end
  end

  defp run_model_loop(session, request, iteration, run_id) do
    attempt = iteration + 1

    with {:ok, response} <- model_client_create_response(session, request, attempt) do
      remember_response_id(session, response)
      emit_response_messages(session, response, run_id)

      case model_client_tool_calls(session, response) do
        [] ->
          emit_turn_completed(session, response, run_id)
          {:ok, response_result(session, response)}

        calls when iteration < session.max_tool_iterations ->
          outputs = execute_tool_calls(session, calls, run_id, relay_correlation_id(request))
          follow_up = model_client_follow_up_request(session, response, outputs)
          run_model_loop(session, follow_up, iteration + 1, run_id)

        _calls ->
          {:error, {:fatal, :tool_iteration_limit_exceeded}}
      end
    end
  end

  defp execute_tool_calls(session, calls, run_id, correlation_id) do
    Enum.map(calls, fn call ->
      started_at = System.monotonic_time(:millisecond)
      tool = Map.get(call, "name")
      tool_call_id = Map.get(call, "call_id")
      arguments = decode_arguments(Map.get(call, "arguments"))

      result =
        execute_tool(tool, arguments, session, tool_call_id, correlation_id)
        |> Observability.classify_tool_result(
          %{tool_name: tool, tool_call_id: tool_call_id, attempt: 1},
          duration_since(started_at)
        )
        |> Observability.log_tool_result()

      event = if Map.get(result, "success"), do: :tool_call_completed, else: :tool_call_failed

      emit_message(session, event, %{
        run_id: run_id,
        payload: %{
          "params" =>
            %{"tool" => tool, "callId" => tool_call_id}
            |> maybe_put_payload_field("errorCode", Map.get(result, "error_code"))
            |> maybe_put_payload_field("retryable", Map.get(result, "retryable"))
        },
        details: result
      })

      %{
        "type" => "function_call_output",
        "call_id" => tool_call_id,
        "output" => Map.get(result, "output", Jason.encode!(result))
      }
    end)
  end

  # The relay session correlation for the current turn. Local-relay requests
  # carry it (RuntimeManaged sets the response id equal to it, so it is stable
  # across the model turn and the follow-up). Other model clients have none.
  defp relay_correlation_id(request) when is_map(request) do
    Map.get(request, "correlation_id") || Map.get(request, :correlation_id)
  end

  defp relay_correlation_id(_request), do: nil

  defp decode_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> arguments
    end
  end

  defp decode_arguments(arguments) when is_map(arguments), do: arguments
  defp decode_arguments(_arguments), do: %{}

  defp tool_specs(config, model_client) do
    ToolRegistry.effective_definitions(config, fallback_tool_names(config, model_client))
  end

  defp fallback_tool_names(config, ModelClient.LocalRelay) do
    tool_bundle(config)
    |> ToolRegistry.bundle()
    |> Enum.reject(&(&1 in @local_helper_cli_tools))
  end

  defp fallback_tool_names(config, _model_client) do
    ToolRegistry.bundle(tool_bundle(config))
  end

  # Mark CLI tools as helper-executed for local-relay managers so they run on
  # the user's machine. This is the single source of truth: the dispatched tool
  # definitions and helper_executed_tool?/2 both read these marked specs.
  # Non-relay managers keep the registry execution_kind and execute in-process.
  defp mark_helper_cli_tools(tool_specs, ModelClient.LocalRelay) when is_list(tool_specs) do
    Enum.map(tool_specs, fn spec ->
      if is_map(spec) and tool_spec_name(spec) in @local_helper_cli_tools do
        Map.put(spec, "execution_kind", "helper")
      else
        spec
      end
    end)
  end

  defp mark_helper_cli_tools(tool_specs, _model_client), do: tool_specs

  # Tools whose execution_kind is "helper" run on the relay helper (the user's
  # machine, with local git/gh auth) rather than in the orchestrator. Requires
  # an active relay correlation; without one (non-relay managers), fall through
  # to in-orchestrator execution.
  defp execute_tool(tool, arguments, session, tool_call_id, correlation_id)
       when is_binary(correlation_id) and is_binary(tool_call_id) do
    if helper_executed_tool?(tool, session) do
      delegate_tool_to_helper(tool, arguments, tool_call_id, correlation_id, session)
    else
      execute_runtime_tool(tool, arguments, session)
    end
  end

  defp execute_tool(tool, arguments, session, _tool_call_id, _correlation_id) do
    execute_runtime_tool(tool, arguments, session)
  end

  defp helper_executed_tool?(tool, session) do
    session
    |> Map.get(:tool_specs, [])
    |> Enum.any?(fn definition ->
      is_map(definition) and tool_spec_name(definition) == tool and
        (Map.get(definition, "execution_kind") || Map.get(definition, :execution_kind)) == "helper"
    end)
  end

  defp tool_spec_name(definition) do
    Map.get(definition, "name") || Map.get(definition, :name) ||
      Map.get(definition, "slug") || Map.get(definition, :slug)
  end

  # Delegate a helper-kind tool to the relay helper over the still-open session
  # the helper is awaiting follow-up on, mirroring ToolCallingLoop's
  # request_helper_tool_execution. The result is routed back to this process by
  # the relay registry.
  defp delegate_tool_to_helper(tool, arguments, tool_call_id, correlation_id, session) do
    timeout_ms = config_integer(session, "tool_execution_timeout_ms", 120_000)

    frame = %{
      "type" => "tool_execution_request",
      "correlation_id" => correlation_id,
      "tool_call_id" => tool_call_id,
      "name" => tool,
      "arguments" => arguments,
      "execution_kind" => "helper",
      "timeout_ms" => timeout_ms,
      "context" => tool_execution_context(session)
    }

    case LocalRelayRegistry.send_tool_execution_request(correlation_id, frame) do
      :ok -> await_helper_tool_result(tool, correlation_id, tool_call_id, timeout_ms)
      {:error, reason} -> helper_tool_error(tool, reason)
    end
  end

  defp await_helper_tool_result(tool, correlation_id, tool_call_id, timeout_ms) do
    receive do
      {:local_relay_tool_call_result, ^correlation_id, %{"tool_call_id" => ^tool_call_id} = frame} ->
        normalize_helper_tool_result(frame)
    after
      timeout_ms -> helper_tool_error(tool, :tool_execution_timeout)
    end
  end

  defp normalize_helper_tool_result(frame) do
    success? = Map.get(frame, "success") != false
    output = Map.get(frame, "output")

    %{
      "success" => success?,
      "output" => encode_tool_output(output)
    }
    |> maybe_put_payload_field("error", unless(success?, do: "helper_tool_failed"))
  end

  defp helper_tool_error(tool, reason) do
    %{
      "success" => false,
      "error" => error_code(reason),
      "output" => Jason.encode!(%{"error" => "helper_tool_failed", "tool" => tool, "reason" => inspect(reason)})
    }
  end

  defp encode_tool_output(output) when is_binary(output), do: output
  defp encode_tool_output(output) when is_map(output) or is_list(output), do: Jason.encode!(output)
  defp encode_tool_output(nil), do: ""
  defp encode_tool_output(output), do: to_string(output)

  defp execute_runtime_tool(tool, arguments, session) do
    context =
      session
      |> tool_execution_context()
      |> Map.put("session", session)

    case ToolRegistry.execute(tool, arguments, context, Map.get(session, :allowed_tools, [])) do
      {:ok, %{output: output} = result} ->
        %{
          "success" => true,
          "output" => output
        }
        |> maybe_put_payload_field("usage", Map.get(result, :usage))
        |> maybe_put_payload_field("metadata", Map.get(result, :metadata))

      {:error, %{"success" => false} = result} ->
        result

      {:error, reason} ->
        error = error_code(reason)

        %{
          "success" => false,
          "error" => error,
          "output" => Jason.encode!(%{"error" => error, "reason" => inspect(reason)})
        }
    end
  end

  defp tool_execution_context(session), do: ToolExecutionContext.from_session(session)

  defp error_code(:not_allowed), do: "not_allowed"
  defp error_code(:unknown_tool), do: "unknown_tool"
  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(_reason), do: "tool_error"

  defp emit_response_messages(session, response, run_id) do
    response
    |> model_client_output_texts(session)
    |> Enum.each(fn text ->
      emit_message(session, :notification, %{
        run_id: run_id,
        payload: %{
          "method" => "codex/event/agent_message_delta",
          "params" => %{"textDelta" => text}
        }
      })
    end)
  end

  defp emit_turn_completed(session, response, run_id) do
    emit_message(session, :turn_completed, %{
      run_id: run_id,
      payload: %{
        "id" => response_id(session, response),
        "usage" => Map.get(response, "usage", %{})
      },
      usage: Map.get(response, "usage")
    })
  end

  defp response_result(session, response) do
    %{
      "status" => Map.get(response, "status", "completed"),
      "response_id" => response_id(session, response),
      "output_text" => Enum.join(model_client_output_texts(response, session), "")
    }
  end

  defp response_id(session, response) do
    client = session.model_client
    client.response_id(response)
  end

  defp previous_response_id(%{state: state}) when is_pid(state) do
    Agent.get(state, &Map.get(&1, :previous_response_id))
  catch
    :exit, _reason -> nil
  end

  defp previous_response_id(_session), do: nil

  defp remember_response_id(session, response) do
    case response_id(session, response) do
      id when is_binary(id) ->
        update_session_state(session, :previous_response_id, id)

      _ ->
        :ok
    end
  end

  defp update_session_state(%{state: state}, key, value) when is_pid(state) do
    Agent.update(state, &Map.put(&1, key, value))
  catch
    :exit, _reason -> :ok
  end

  defp update_session_state(_session, _key, _value), do: :ok

  defp emit_message(%{on_message: on_message}, event, details) when is_function(on_message, 1) do
    on_message.(details |> Map.put(:event, event) |> Map.put(:timestamp, DateTime.utc_now()))
  end

  defp emit_message(_session, _event, _details), do: :ok

  defp maybe_put_payload_field(map, _key, nil), do: map
  defp maybe_put_payload_field(map, key, value), do: Map.put(map, key, value)

  defp duration_since(started_at) do
    System.monotonic_time(:millisecond) - started_at
  end

  defp resolve_credential(config, ModelClient.LocalRelay) do
    credential_id = config_value(config, "credential_id")
    {:ok, %{api_key: config_value(config, "api_key") || "local-runtime", credential_id: credential_id}}
  end

  defp resolve_credential(config, ModelClient.OpenAICompatibleChat) do
    credential_id = config_value(config, "credential_id")
    {:ok, %{api_key: config_value(config, "api_key"), credential_id: credential_id}}
  end

  defp resolve_credential(config, _model_client) do
    credential_id = config_value(config, "credential_id")

    case config_value(config, "api_key") || credentials_api_key(config) ||
           System.get_env("OPENAI_API_KEY") do
      value when is_binary(value) and value != "" ->
        {:ok, %{api_key: value, credential_id: credential_id}}

      _ ->
        {:error, :no_credential}
    end
  end

  defp credentials_api_key(config) do
    case config_value(config, "credentials") do
      %{} = credentials -> Map.get(credentials, "OPENAI_API_KEY") || Map.get(credentials, :OPENAI_API_KEY)
      _ -> nil
    end
  end

  defp credentials(config) do
    case config_value(config, "credentials") do
      %{} = credentials -> credentials
      _ -> %{}
    end
  end

  defp config_value(config, key) when is_map(config) do
    Map.get(config, key) || Map.get(config, String.to_atom(key))
  end

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false

  defp provider(config), do: config_value(config, "provider") || config_value(config, "model_provider") || "openai"

  defp agent_type(config), do: config_value(config, "agent_type") || config_value(config, "type") || "manager"

  defp tool_bundle(config) do
    case config_value(config, "tool_bundle") || agent_type(config) do
      "manager" -> :manager
      "planning" -> :planner
      "planner" -> :planner
      value when is_atom(value) -> value
      _other -> :manager
    end
  end

  defp model_client(config) do
    case config_value(config, "model_client") || config_value(config, "manager_model_client") || provider(config) do
      "local_relay" -> ModelClient.LocalRelay
      "local" -> ModelClient.LocalRelay
      "openai_compatible_chat" -> ModelClient.OpenAICompatibleChat
      "openai_compatible" -> ModelClient.OpenAICompatibleChat
      _ -> ModelClient.OpenAIResponses
    end
  end

  defp capability_requirements(config) do
    case config_value(config, "capability_requirements") || config_value(config, "capabilityRequirements") do
      requirements when is_map(requirements) -> requirements
      _ -> %{}
    end
  end

  defp model_tier_floor(config) do
    case config_value(config, "model_tier_floor") || config_value(config, "modelTierFloor") do
      floor when floor in ["frontier", "mid", "local"] -> floor
      _ -> "any"
    end
  end

  defp fallback_links(config) do
    config
    |> config_value("fallbacks")
    |> List.wrap()
    |> Enum.filter(&is_map/1)
    |> Enum.map(&normalize_fallback_link/1)
  end

  defp normalize_fallback_link(link) do
    credential_ref = credential_ref(link)

    %{
      "provider" => config_value(link, "provider"),
      "model" => provider_model(config_value(link, "model")),
      "credential_ref" => credential_ref
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp credential_ref(config) do
    cond do
      ref = config_value(config, "credential_ref") ->
        ref

      id = config_value(config, "credential_id") ->
        %{"type" => "credential_id", "value" => id}

      true ->
        nil
    end
  end

  defp model_client_initial_request(session, due_tasks_payload, work_item) do
    client = session.model_client
    client.initial_request(session, due_tasks_payload, work_item)
  end

  defp model_client_create_response(session, request, attempt) do
    if cutover_enabled?(session) do
      model_client_create_response_with_cutover(session, request, attempt)
    else
      client = session.model_client
      client.create_response(session, request, attempt)
    end
  end

  defp model_client_create_response_with_cutover(session, request, attempt) do
    context = %{
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      work_item_id: get_in(request, ["metadata", "work_item_id"]),
      run_id: Map.get(session, :run_id),
      trace_id: Map.get(session, :trace_id)
    }

    case Cutover.walk(session, context, fn link ->
           with {:ok, link_session} <- session_for_cutover_link(session, link) do
             client = link_session.model_client

             link_session
             |> client.create_response(request_for_cutover_link(request, link_session), attempt + link.position)
             |> normalize_cutover_call_result()
           end
         end) do
      {:ok, response, _decision} ->
        {:ok, response}

      {:error, :floor_exhausted, decision} ->
        Attention.escalate(:cutover_floor_exhausted, decision, session)

      {:error, :exhausted, decision} ->
        Attention.escalate(:cutover_exhausted, decision, session)

      {:error, {:non_retryable, reason}, _decision} ->
        passthrough_provider_error(reason)
    end
  end

  defp cutover_enabled?(session) do
    Map.get(session, :fallbacks, []) != [] or Map.get(session, :model_tier_floor, "any") != "any"
  end

  defp passthrough_provider_error({kind, _classification} = error) when kind in [:fatal, :retryable], do: {:error, error}
  defp passthrough_provider_error(reason), do: {:error, {:fatal, reason}}

  defp normalize_cutover_call_result({:error, {_kind, classification}}) when is_map(classification), do: {:error, classification}
  defp normalize_cutover_call_result(result), do: result

  defp session_for_cutover_link(session, %Cutover.CutoverLink{} = link) do
    provider = link.provider || session.provider
    model_client = model_client(%{"provider" => provider})

    with {:ok, credential} <- resolve_cutover_credential(session, link, model_client) do
      {:ok,
       session
       |> Map.put(:provider, provider)
       |> Map.put(:model, provider_model(link.model) || session.model)
       |> Map.put(:credential_ref, link.credential_ref)
       |> Map.put(:model_client, model_client)
       |> Map.put(:base_url, default_base_url(model_client))
       |> Map.put(:api_key, credential.api_key)
       |> Map.put(:credential_id, credential.credential_id)
       |> Map.put(:credential_scope, Map.get(credential, :credential_scope))}
    end
  end

  defp request_for_cutover_link(request, session) when is_map(request), do: Map.put(request, "model", session.model)

  defp resolve_cutover_credential(session, %Cutover.CutoverLink{source: :primary}, _model_client) do
    {:ok,
     %{
       api_key: Map.get(session, :api_key),
       credential_id: Map.get(session, :credential_id),
       credential_scope: Map.get(session, :credential_scope)
     }}
  end

  defp resolve_cutover_credential(_session, %Cutover.CutoverLink{} = link, ModelClient.LocalRelay) do
    {:ok, %{api_key: "local-runtime", credential_id: link.credential_id}}
  end

  defp resolve_cutover_credential(session, %Cutover.CutoverLink{} = link, ModelClient.OpenAICompatibleChat) do
    case resolve_stored_cutover_credential(session, link) do
      {:ok, credential} -> {:ok, credential}
      {:error, _reason} -> {:ok, %{api_key: nil, credential_id: link.credential_id}}
    end
  end

  defp resolve_cutover_credential(session, %Cutover.CutoverLink{} = link, _model_client) do
    resolve_stored_cutover_credential(session, link)
  end

  defp resolve_stored_cutover_credential(session, %Cutover.CutoverLink{} = link) do
    cond do
      same_credential?(session, link) ->
        {:ok,
         %{
           api_key: Map.get(session, :api_key),
           credential_id: Map.get(session, :credential_id),
           credential_scope: Map.get(session, :credential_scope)
         }}

      not is_binary(Map.get(session, :agent_id)) ->
        {:error, credential_failure(link, :missing_agent_id)}

      true ->
        with {:ok, credentials} <- AgentInventory.list_credentials(Map.fetch!(session, :agent_id)),
             {:ok, %StoredCredential{} = credential} <- find_cutover_credential(credentials, link),
             {:ok, env} <- SecretResolver.resolve(credential),
             {:ok, api_key} <- api_key_from_env(env, link.provider) do
          {:ok, %{api_key: api_key, credential_id: credential.id, credential_scope: credential.provider}}
        else
          {:error, reason} -> {:error, credential_failure(link, reason)}
          nil -> {:error, credential_failure(link, :credential_not_found)}
        end
    end
  end

  defp same_credential?(session, %Cutover.CutoverLink{credential_id: credential_id}) when is_binary(credential_id) do
    credential_id == Map.get(session, :credential_id)
  end

  defp same_credential?(_session, _link), do: false

  defp find_cutover_credential(credentials, %Cutover.CutoverLink{} = link) when is_list(credentials) do
    credentials
    |> Enum.find(&credential_matches_link?(&1, link))
    |> case do
      %StoredCredential{} = credential -> {:ok, credential}
      nil -> nil
    end
  end

  defp credential_matches_link?(%StoredCredential{} = credential, %Cutover.CutoverLink{} = link) do
    id = link.credential_id

    (is_binary(id) and (credential.id == id or credential_row_id(credential.id) == id)) or
      credential_alias(link.credential_ref) in credential.aliases
  end

  defp credential_row_id(id) when is_binary(id), do: id |> String.split(":", parts: 2) |> List.first()
  defp credential_row_id(_id), do: nil

  defp credential_alias(%{"type" => "credential_alias", "value" => value}), do: value
  defp credential_alias(%{"type" => "credential_alias", "credential_alias" => value}), do: value
  defp credential_alias(%{type: "credential_alias", value: value}), do: value
  defp credential_alias(%{type: :credential_alias, value: value}), do: value
  defp credential_alias(_ref), do: nil

  defp api_key_from_env(env, provider) when is_map(env) do
    candidates =
      case provider do
        "openai_compatible" -> ["OPENAI_COMPATIBLE_API_KEY", "LOCAL_MODEL_API_KEY", "OPENAI_API_KEY"]
        "local" -> ["LOCAL_MODEL_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"]
        "anthropic" -> ["ANTHROPIC_API_KEY"]
        _ -> ["OPENAI_API_KEY"]
      end

    candidates
    |> Enum.map(&Map.get(env, &1))
    |> Enum.find(&(is_binary(&1) and &1 != ""))
    |> case do
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, :credential_secret_missing}
    end
  end

  defp credential_failure(%Cutover.CutoverLink{} = link, reason) do
    %{
      error_code: "provider_auth_failed",
      retryable: false,
      provider: link.provider,
      model: link.model,
      credential_id: link.credential_id,
      reason: inspect(reason)
    }
  end

  defp model_client_follow_up_request(session, response, tool_outputs) do
    client = session.model_client
    client.follow_up_request(session, response, tool_outputs)
  end

  defp model_client_tool_calls(session, response) do
    client = session.model_client
    client.tool_calls(response)
  end

  defp model_client_output_texts(response, session) do
    client = session.model_client
    client.output_texts(response)
  end

  defp provider_model(model) when is_binary(model) do
    model
    |> String.trim()
    |> String.split("/", parts: 2)
    |> List.last()
    |> case do
      "" -> nil
      value -> value
    end
  end

  defp provider_model(_model), do: nil

  defp config_integer(config, key, default) do
    case config_value(config, key) do
      value when is_integer(value) and value > 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer > 0 -> integer
          _ -> default
        end

      _ ->
        default
    end
  end

  defp config_non_negative_integer(config, key, default) do
    case config_value(config, key) do
      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer >= 0 -> integer
          _ -> default
        end

      _ ->
        default
    end
  end

  defp default_base_url(ModelClient.OpenAICompatibleChat), do: @openai_compatible_base_url
  defp default_base_url(_model_client), do: @responses_url

  defp req_options(config, ModelClient.OpenAICompatibleChat) do
    configured = config_value(config, "req_options") || []
    env_options = Application.get_env(:symphony_elixir, :manager_openai_compatible_req_options, [])

    # Req's default `receive_timeout` is 15s, which is too tight for
    # local OpenAI-compatible backends (e.g. Ollama serving a 30B MoE
    # model with manager tool definitions). Default to 120s so the
    # first non-trivial turn doesn't time out before the model finishes.
    # Explicit config/env values still win via Keyword.merge.
    defaults = [receive_timeout: 120_000]

    defaults
    |> Keyword.merge(List.wrap(configured))
    |> Keyword.merge(env_options)
  end

  defp req_options(config, _model_client) do
    configured = config_value(config, "req_options") || []
    env_options = Application.get_env(:symphony_elixir, :manager_responses_req_options, [])

    Keyword.merge(List.wrap(configured), env_options)
  end
end
