defmodule SymphonyElixir.Runner.ToolCallingLoop.ToolExecutionDispatcher do
  @moduledoc false

  require Logger

  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Runner.ToolCallingLoop.ToolCallNormalization
  alias SymphonyElixir.{PolicyGate, ToolAdapter, ToolExecutionContext, ToolRegistry}

  @spec dispatch_cloud(session :: map(), config :: map(), state :: map(), raw_tool_calls :: [map()]) ::
          {:ok, map()} | {:error, term()}
  def dispatch_cloud(session, config, state, raw_tool_calls) do
    raw_tool_calls
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, state}, fn {raw_call, index}, {:ok, state} ->
      call = ToolCallNormalization.normalize_tool_call(raw_call, index, session)
      started_at = monotonic_ms()
      emit_tool_started(session, state, call)

      result =
        case ToolCallNormalization.validate_tool_call(call, ToolCallNormalization.tool_definitions(session)) do
          :ok -> request_tool_execution(session, config, call)
          {:error, message} -> {:ok, invalid_tool_result(call, message)}
        end

      case result do
        {:ok, result_frame} ->
          emit_tool_finished(session, state, call, result_frame, started_at)
          {:cont, {:ok, append_tool_result(state, call, result_frame)}}

        {:error, reason} ->
          result_frame = failed_tool_result(call, reason)
          emit_tool_finished(session, state, call, result_frame, started_at)
          {:cont, {:ok, append_tool_result(state, call, result_frame)}}
      end
    end)
  end

  @spec execute_direct_tool_calls(session :: map(), state :: map(), tool_calls :: [map()]) :: [map()]
  def execute_direct_tool_calls(session, state, tool_calls) do
    Enum.map(tool_calls, fn call ->
      started_at = monotonic_ms()
      emit_tool_started(session, state, call)

      result =
        case validate_direct_tool_call(call, ToolCallNormalization.tool_definitions(session)) do
          :ok ->
            execute_direct_tool(session, call)

          {:error, message} ->
            emit_event(session, %{
              event: :unsupported_tool_call,
              payload: tool_event_payload(session, state, call) |> Map.put("error", message),
              message: message
            })

            {:ok, %{"success" => false, "output" => message}}
        end

      normalized_result = normalize_direct_tool_result(result)
      emit_tool_finished(session, state, call, normalized_result, started_at)

      direct_tool_result_message(session, call, normalized_result)
    end)
  end

  @spec normalize_direct_tool_result(term()) :: map()
  def normalize_direct_tool_result({:ok, result}) when is_map(result) do
    result
    |> stringify_keys()
    |> Map.put_new("success", true)
    |> Map.put_new("output", "")
  end

  def normalize_direct_tool_result({:ok, output}) do
    %{"success" => true, "output" => to_string(output)}
  end

  def normalize_direct_tool_result({:error, reason}) do
    %{"success" => false, "output" => inspect(reason), "error" => inspect(reason)}
  end

  def normalize_direct_tool_result(result) when is_map(result) do
    result
    |> stringify_keys()
    |> Map.put_new("success", true)
    |> Map.put_new("output", "")
  end

  def normalize_direct_tool_result(output), do: %{"success" => true, "output" => to_string(output)}

  @spec runtime_context(map()) :: map()
  def runtime_context(session), do: ToolExecutionContext.from_session(session)

  @spec emit_event(map(), map()) :: term()
  def emit_event(%{on_message: on_message}, event) when is_function(on_message, 1) do
    case Contract.normalize_event(event) do
      {:ok, normalized} -> on_message.(normalized)
      {:error, reason} -> Logger.warning("tool_calling_loop_dropped_event reason=#{inspect(reason)} event=#{inspect(event)}")
    end
  end

  def emit_event(_session, _event), do: :ok

  defp request_tool_execution(session, config, call) do
    with :allow <- evaluate_policy(session, call) do
      tool = ToolCallNormalization.tool_definition(call.name, ToolCallNormalization.tool_definitions(session))

      case ToolCallNormalization.tool_execution_kind(tool) do
        "runtime" ->
          request_runtime_tool_execution(session, Map.get(session, :tool_executor, :registry), call)

        _other ->
          request_helper_tool_execution(session, config, call)
      end
    end
  end

  defp request_helper_tool_execution(session, config, call) do
    correlation_id = Map.fetch!(session, :correlation_id)
    tool = ToolCallNormalization.tool_definition(call.name, ToolCallNormalization.tool_definitions(session))

    frame =
      %{
        "type" => "tool_execution_request",
        "correlation_id" => correlation_id,
        "tool_call_id" => call.id,
        "name" => call.name,
        "arguments" => ToolExecutionContext.inject_arguments(call.arguments, tool, runtime_context(session)),
        "execution_kind" => ToolCallNormalization.map_value(tool, :execution_kind),
        "execution_config" => ToolCallNormalization.map_value(tool, :execution_config) || %{},
        # Bound the helper command to the same window we will wait below, so a
        # slow git/gh command cancels on the user's machine when we time out
        # rather than mutating the repo / calling GitHub after we have moved on.
        "timeout_ms" => config.timeout_per_tool_ms,
        "context" => runtime_context(session)
      }
      |> reject_nil_values()

    with :ok <- Registry.send_tool_execution_request(correlation_id, frame) do
      receive do
        {:local_relay_tool_call_result, ^correlation_id, %{"type" => "tool_call_result", "tool_call_id" => tool_call_id} = result}
        when tool_call_id == call.id ->
          {:ok, result}

        {:local_relay_tool_call_result, ^correlation_id, %{"event" => "tool_call_result", "tool_call_id" => tool_call_id} = result}
        when tool_call_id == call.id ->
          {:ok, result}
      after
        config.timeout_per_tool_ms ->
          {:error, :tool_execution_timeout}
      end
    end
  end

  defp request_runtime_tool_execution(session, executor, call) do
    result =
      cond do
        executor == :registry -> execute_runtime_registry_tool(session, call)
        is_function(executor, 2) -> executor.(call.name, call.arguments)
        is_function(executor, 3) -> executor.(call.name, call.arguments, session)
        is_atom(executor) -> executor.execute(call.name, call.arguments, session)
      end

    {:ok,
     result
     |> normalize_direct_tool_result()
     |> Map.put("type", "tool_call_result")
     |> Map.put("tool_call_id", call.id)}
  rescue
    error -> {:error, Exception.message(error)}
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  defp execute_runtime_registry_tool(session, call) do
    allowed = Enum.map(ToolCallNormalization.tool_definitions(session), &(ToolCallNormalization.map_value(&1, :name) || ToolCallNormalization.map_value(&1, :slug)))

    case ToolRegistry.execute(call.name, call.arguments, runtime_context(session), allowed) do
      {:ok, %{output: output}} -> {:ok, %{"output" => encode_runtime_tool_output(output)}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp execute_direct_tool(session, call) do
    with :allow <- evaluate_policy(session, call) do
      case workspace_status(session) do
        :ok ->
          execute_direct_tool_with_workspace(session, call)

        {:error, message} ->
          {:ok, %{"success" => false, "output" => message, "error" => "workspace_unavailable"}}
      end
    end
  end

  defp evaluate_policy(session, call) do
    case PolicyGate.evaluate(%{type: :tool_call, target: call.name, data: call.arguments, session: session}) do
      :allow -> :allow
      {:deny, reason} -> {:error, {:policy_denied, reason}}
      {:ask, escalation} -> {:error, {:policy_ask, escalation}}
    end
  end

  defp execute_direct_tool_with_workspace(session, call) do
    case Map.get(session, :tool_executor) do
      executor when is_function(executor, 2) ->
        executor.(call.name, call.arguments)

      executor when is_function(executor, 3) ->
        executor.(call.name, call.arguments, session)

      executor when is_atom(executor) and not is_nil(executor) ->
        executor.execute(call.name, call.arguments, session)

      _ ->
        execute_direct_registry_tool(session, call)
    end
  end

  defp execute_direct_registry_tool(session, call) do
    allowed = Enum.map(ToolCallNormalization.tool_definitions(session), &(ToolCallNormalization.map_value(&1, :name) || ToolCallNormalization.map_value(&1, :slug)))

    case ToolRegistry.execute(call.name, call.arguments, direct_tool_context(session), allowed) do
      {:ok, %{output: output}} -> {:ok, output}
      {:error, :not_allowed} -> {:error, {:unsupported_local_model_coding_tool, call.name}}
      {:error, :unknown_tool} -> {:error, {:unsupported_local_model_coding_tool, call.name}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp direct_tool_context(session) do
    metadata = Map.get(session, :metadata, %{})
    runtime = runtime_context(session)

    %{
      workspace_root: Map.fetch!(session, :workspace),
      metadata: metadata,
      workspace_id: map_value(runtime, :workspace_id),
      agent_id: map_value(runtime, :agent_id),
      on_event: fn event -> emit_event(session, event) end
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp workspace_status(session) do
    case Map.get(session, :workspace) do
      path when is_binary(path) and path != "" ->
        if File.dir?(path) do
          :ok
        else
          {:error,
           "This tool needs a workspace directory to run. The configured path " <>
             "(`" <>
             path <>
             "`) does not exist or is not a directory. " <>
             "Update the Coding Agent's workspace directory in agent settings before retrying."}
        end

      _ ->
        {:error,
         "This tool needs a workspace directory to run. No workspace directory is configured for this agent. " <>
           "Set one in the Coding Agent's settings before retrying."}
    end
  end

  defp validate_direct_tool_call(%{malformed_arguments?: true, raw_arguments: raw_arguments}, _tools) do
    {:error, "Malformed arguments for tool call: #{inspect(raw_arguments)}"}
  end

  defp validate_direct_tool_call(%{name: name}, tools), do: ToolCallNormalization.validate_tool_call(%{name: name}, tools)

  defp direct_tool_result_message(session, call, result) do
    call.id
    |> ToolAdapter.format_tool_result(result, session.provider)
    |> Map.put_new("name", call.name)
  end

  defp append_tool_result(state, call, result) do
    %{state | messages: state.messages ++ [tool_result_content(call, result)]}
  end

  defp tool_result_content(call, result) do
    result =
      if Map.get(result, "success") == false do
        Map.put(result, "output", Map.get(result, "error") || Map.get(result, "output") || "Tool execution failed")
      else
        result
      end

    call.id
    |> ToolAdapter.format_tool_result(result, :openai_compatible)
    |> Map.put_new("name", call.name)
  end

  defp invalid_tool_result(call, message), do: %{"type" => "tool_call_result", "tool_call_id" => call.id, "success" => false, "output" => message}

  defp failed_tool_result(call, {:policy_ask, escalation}) do
    %{
      "type" => "tool_call_result",
      "tool_call_id" => call.id,
      "success" => false,
      "output" => "Tool call is waiting for policy approval",
      "error" => "policy_ask",
      "error_code" => "policy_ask",
      "approval_state" => "requested",
      "escalation" => escalation
    }
  end

  defp failed_tool_result(call, {:policy_denied, reason}) do
    %{
      "type" => "tool_call_result",
      "tool_call_id" => call.id,
      "success" => false,
      "output" => policy_reason_message(reason),
      "error" => "policy_denied",
      "error_code" => "policy_denied",
      "approval_state" => Map.get(reason, "approval_state"),
      "policy" => reason
    }
    |> reject_nil_values()
  end

  defp failed_tool_result(call, reason) do
    %{"type" => "tool_call_result", "tool_call_id" => call.id, "success" => false, "output" => inspect(reason)}
  end

  defp emit_tool_started(session, state, call) do
    emit_event(session, %{event: :tool_call_started, payload: tool_event_payload(session, state, call)})
  end

  defp emit_tool_finished(session, state, call, result, started_at) do
    success? = Map.get(result, "success") != false
    event = if success?, do: :tool_call_completed, else: :tool_call_failed

    payload =
      session
      |> tool_event_payload(state, call)
      |> Map.merge(%{
        "success" => success?,
        "duration_ms" => max(monotonic_ms() - started_at, 0),
        # Helper-delegated tools (e.g. git.run) return structured map output, so
        # encode rather than to_string/1, which raises Protocol.UndefinedError on
        # a map. Matches how the model-facing tool result is serialized.
        "result_size_bytes" => byte_size(encode_runtime_tool_output(Map.get(result, "output") || ""))
      })
      |> maybe_put("approval_state", Map.get(result, "approval_state"))
      |> maybe_put("error_code", Map.get(result, "error_code"))
      |> maybe_put("error_message", Map.get(result, "error"))
      |> maybe_put("escalation", Map.get(result, "escalation"))

    emit_event(session, %{event: event, payload: payload})
  end

  defp tool_event_payload(session, state, call) do
    %{
      "correlation_id" => Map.get(session, :correlation_id),
      "iteration" => state.iteration,
      "tool_name" => call.name,
      "tool_call_id" => call.id,
      "arguments" => call.arguments,
      "provider" => Map.get(session, :provider),
      "model" => Map.get(session, :model),
      "is_prompt_based" => Map.get(session, :provider) in ["prompt_based", :prompt_based]
    }
    |> reject_nil_values()
  end

  defp encode_runtime_tool_output(output) when is_binary(output), do: output
  defp encode_runtime_tool_output(output) when is_map(output) or is_list(output), do: Jason.encode!(output)
  defp encode_runtime_tool_output(output), do: to_string(output)

  defp monotonic_ms, do: System.monotonic_time(:millisecond)
  defp stringify_keys(map) when is_map(map), do: Map.new(map, fn {key, value} -> {to_string(key), value} end)

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(_map, _key), do: nil

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp policy_reason_message(%{"reason" => reason}) when is_binary(reason), do: reason
  defp policy_reason_message(reason), do: inspect(reason)
end
