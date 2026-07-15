defmodule SymphonyElixir.MessageLog.ToolCalls do
  @moduledoc """
  Persists assistant tool call details associated with message log rows.
  """

  alias SymphonyElixir.{MapUtils, RuntimeLog}
  alias SymphonyElixir.PostgRESTClient

  @tool_call_table "tool_call"
  @agent_tool_call_event_table "agent_tool_call_event"

  @spec record(map(), map(), String.t(), String.t(), String.t() | nil, [map()], keyword()) :: :ok
  def record(config, scope, session_thread_id, message_id, run_id, tool_calls, req_options)
      when is_map(config) and is_map(scope) and is_binary(session_thread_id) and
             is_binary(message_id) and is_list(tool_calls) and is_list(req_options) do
    record_tool_calls(config, scope, session_thread_id, message_id, run_id, tool_calls, req_options)

    record_agent_tool_call_events(
      config,
      scope,
      session_thread_id,
      message_id,
      run_id,
      tool_calls,
      req_options
    )

    :ok
  end

  defp record_tool_calls(config, scope, session_thread_id, message_id, run_id, tool_calls, req_options) do
    rows =
      tool_calls
      |> Enum.map(&tool_call_row(message_id, &1))
      |> Enum.reject(&is_nil/1)

    if rows != [] do
      case PostgRESTClient.post(client(config, req_options), @tool_call_table, rows,
             prefer: "return=minimal",
             log_metadata:
               scope_log_metadata(scope, "message_log.record_tool_calls", @tool_call_table,
                 session_thread_id: session_thread_id,
                 run_id: run_id,
                 message_id: message_id
               )
           ) do
        {:ok, _body} ->
          :ok

        {:error, reason} ->
          log_tool_call_persistence_failed(scope, reason, session_thread_id, run_id, message_id)
          :ok
      end
    end
  end

  defp record_agent_tool_call_events(
         config,
         scope,
         session_thread_id,
         message_id,
         run_id,
         tool_calls,
         req_options
       ) do
    rows =
      tool_calls
      |> Enum.with_index()
      |> Enum.map(fn {call, index} ->
        agent_tool_call_event_row(scope, run_id, call, index)
      end)
      |> Enum.reject(&is_nil/1)

    if rows != [] do
      case PostgRESTClient.post(client(config, req_options), @agent_tool_call_event_table, rows,
             prefer: "return=minimal",
             log_metadata:
               scope_log_metadata(
                 scope,
                 "message_log.record_agent_tool_call_events",
                 @agent_tool_call_event_table,
                 session_thread_id: session_thread_id,
                 run_id: run_id,
                 message_id: message_id
               )
           ) do
        {:ok, _body} ->
          :ok

        {:error, reason} ->
          log_tool_call_persistence_failed(scope, reason, session_thread_id, run_id, message_id)
          :ok
      end
    end
  end

  defp agent_tool_call_event_row(scope, run_id, call, index)
       when is_map(scope) and is_binary(run_id) and is_map(call) do
    tool_name = map_value(call, :tool_name)
    call_id = map_value(call, :call_id)
    run_uuid = uuid_or_nil(run_id)
    output = map_value(call, :output) || %{}
    status = map_value(call, :status) || "ok"
    completed_at = DateTime.utc_now() |> DateTime.to_iso8601()

    %{
      "workspace_id" => Map.get(scope, :workspace_id) || Map.get(scope, "workspace_id"),
      "agent_id" => Map.get(scope, :agent_id) || Map.get(scope, "agent_id"),
      "run_id" => run_uuid,
      "tool_call_id" => uuid_or_nil(call_id),
      "correlation_id" => call_id,
      "sequence" => index,
      "event_type" => if(status == "ok", do: "tool_call_completed", else: "tool_call_failed"),
      "message_kind" => "assistant_tool_call",
      "tool_slug" => tool_name,
      "status" => status,
      "approval_state" => map_value(call, :approval_state),
      "arguments" => tool_arguments(call),
      "result" => json_map(output),
      "output_summary" => output_summary(output),
      "error_code" => map_value(call, :error_code),
      "error_message" => error_message(output),
      "completed_at" => completed_at
    }
    |> MapUtils.drop_nil_values()
    |> case do
      %{"workspace_id" => _, "agent_id" => _, "run_id" => _, "tool_slug" => _} = row -> row
      _row -> nil
    end
  end

  defp agent_tool_call_event_row(_scope, _run_id, _call, _index), do: nil

  defp tool_call_row(message_id, call) when is_map(call) do
    %{
      "message_id" => message_id,
      "tool_id" => map_value(call, :tool_id),
      "input" => encode_tool_call_input(call),
      "output" => encode_tool_call_output(call)
    }
    |> MapUtils.drop_nil_values()
    |> case do
      %{"message_id" => ^message_id} = row when map_size(row) > 1 -> row
      _row -> nil
    end
  end

  defp tool_call_row(_message_id, _call), do: nil

  defp encode_tool_call_input(call) do
    data =
      %{
        "call_id" => map_value(call, :call_id),
        "tool_name" => map_value(call, :tool_name),
        "input" => map_value(call, :input)
      }
      |> MapUtils.drop_nil_values()

    if map_size(data) == 0, do: nil, else: Jason.encode!(data)
  end

  defp encode_tool_call_output(call) do
    data =
      %{
        "status" => map_value(call, :status),
        "output" => map_value(call, :output),
        "error_code" => map_value(call, :error_code),
        "retryable" => map_value(call, :retryable)
      }
      |> MapUtils.drop_nil_values()

    if map_size(data) == 0, do: nil, else: Jason.encode!(data)
  end

  defp tool_arguments(call) do
    call
    |> map_value(:input)
    |> case do
      %{} = input -> map_value(input, :arguments) || %{}
      _ -> %{}
    end
    |> json_map()
  end

  defp json_map(%{} = value), do: value
  defp json_map(_value), do: %{}

  defp output_summary(%{} = output) do
    case map_value(output, :output) || map_value(output, :message) || map_value(output, :result) do
      value when is_binary(value) ->
        String.slice(value, 0, 500)

      value when is_map(value) or is_list(value) ->
        value |> Jason.encode!() |> String.slice(0, 500)

      value when not is_nil(value) ->
        value |> to_string() |> String.slice(0, 500)

      _ ->
        nil
    end
  end

  defp output_summary(_output), do: nil

  defp error_message(%{} = output) do
    case map_value(output, :error_message) || map_value(output, :message) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp error_message(_output), do: nil

  defp uuid_or_nil(value) when is_binary(value) do
    case Ecto.UUID.cast(value) do
      {:ok, uuid} -> uuid
      :error -> nil
    end
  end

  defp uuid_or_nil(_value), do: nil

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, to_string(key))
    end
  end

  defp log_tool_call_persistence_failed(scope, reason, session_thread_id, run_id, message_id) do
    RuntimeLog.log(
      :warning,
      :gateway_message_persistence_failed,
      RuntimeLog.scope_fields(scope)
      |> Map.merge(%{
        session_thread_id: session_thread_id,
        run_id: run_id,
        message_id: message_id,
        operation: "message_log.record_tool_calls",
        error_code: "message_persistence_failed",
        non_fatal: true,
        reason: inspect(reason),
        retryable: retryable_persistence_failure?(reason)
      })
    )
  end

  defp retryable_persistence_failure?({:http_error, 429, _body}), do: true
  defp retryable_persistence_failure?({:http_error, status, _body}) when status >= 500, do: true
  defp retryable_persistence_failure?({:request_failed, _reason}), do: true
  defp retryable_persistence_failure?(_reason), do: false

  defp client(config, req_options), do: PostgRESTClient.new(config, req_options)

  defp scope_log_metadata(scope, caller, table, extra) do
    base =
      %{
        caller: caller,
        action: caller,
        table: table,
        agent_id: Map.get(scope, :agent_id) || Map.get(scope, "agent_id"),
        workspace_id: Map.get(scope, :workspace_id) || Map.get(scope, "workspace_id"),
        session_key: Map.get(scope, :session_key) || Map.get(scope, "session_key")
      }

    extra
    |> Map.new()
    |> Map.merge(base)
    |> MapUtils.drop_nil_values()
  end
end
