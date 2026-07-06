defmodule SymphonyElixir.ToolCallPersistence do
  @moduledoc false

  alias SymphonyElixir.MapUtils

  @empty %{pending: %{}, completed: []}

  @spec empty() :: map()
  def empty, do: @empty

  @spec apply_event(map(), map()) :: map()
  def apply_event(acc, %{event: event} = message)
      when event in [:tool_call_started, :tool_call_completed, :tool_call_failed] do
    apply_normalized_event(acc || empty(), event, message)
  end

  def apply_event(acc, %{"event" => event} = message)
      when event in ["tool_call_started", "tool_call_completed", "tool_call_failed"] do
    atom_event = String.to_existing_atom(event)
    apply_normalized_event(acc || empty(), atom_event, message)
  end

  def apply_event(acc, _message), do: acc || empty()

  @spec completed(map()) :: [map()]
  def completed(%{completed: completed}) when is_list(completed), do: Enum.reverse(completed)
  def completed(_acc), do: []

  @spec summary(map()) :: map()
  def summary(call) when is_map(call) do
    %{
      "tool" => call["tool_name"],
      "call_id" => call["call_id"],
      "status" => call["status"],
      "error_code" => call["error_code"],
      "retryable" => call["retryable"]
    }
    |> MapUtils.drop_nil_values()
  end

  defp apply_normalized_event(acc, :tool_call_started, message) do
    call = normalize_call(message, "started")

    case call["call_id"] do
      call_id when is_binary(call_id) and call_id != "" ->
        put_in(acc, [:pending, call_id], call)

      _ ->
        acc
    end
  end

  defp apply_normalized_event(acc, event, message)
       when event in [:tool_call_completed, :tool_call_failed] do
    status = if event == :tool_call_completed, do: "ok", else: "error"
    terminal = normalize_call(message, status)
    call_id = terminal["call_id"]
    started = if is_binary(call_id), do: get_in(acc, [:pending, call_id]) || %{}, else: %{}

    merged =
      started
      |> deep_merge(terminal)
      |> Map.put("status", status)
      |> MapUtils.drop_nil_values()

    acc
    |> update_in([:pending], &Map.delete(&1 || %{}, call_id))
    |> update_in([:completed], &[merged | &1 || []])
  end

  defp normalize_call(message, status) do
    payload = map_value(message, :payload) || %{}
    details = map_value(message, :details) || %{}
    params = map_value(payload, :params) || %{}
    tool_call = map_value(payload, :tool_call) || %{}

    call_id =
      first_present([
        map_value(payload, :tool_call_id),
        map_value(payload, :toolCallId),
        map_value(payload, :call_id),
        map_value(payload, :callId),
        map_value(params, :callId),
        map_value(params, :tool_call_id),
        map_value(tool_call, :id)
      ])

    tool_name =
      first_present([
        map_value(payload, :tool_name),
        map_value(payload, :toolName),
        map_value(payload, :tool),
        map_value(params, :tool),
        map_value(tool_call, :name)
      ])

    arguments =
      first_present([
        map_value(payload, :arguments),
        map_value(params, :arguments),
        map_value(tool_call, :arguments),
        map_value(details, :arguments)
      ])

    output = output_payload(payload, details)

    %{
      "call_id" => call_id,
      "tool_name" => tool_name,
      "status" => status,
      "input" => input_payload(call_id, tool_name, arguments),
      "output" => output,
      "tool_id" => first_present([map_value(payload, :tool_id), map_value(payload, :toolId), map_value(details, :tool_id)]),
      "approval_state" => first_present([map_value(payload, :approval_state), map_value(payload, :approvalState), map_value(details, :approval_state)]),
      "error_code" => first_present([map_value(params, :errorCode), map_value(payload, :error_code), map_value(details, :error_code)]),
      "retryable" => first_present([map_value(params, :retryable), map_value(payload, :retryable), map_value(details, :retryable)])
    }
    |> MapUtils.drop_nil_values()
  end

  defp input_payload(nil, nil, nil), do: nil

  defp input_payload(call_id, tool_name, arguments) do
    %{"id" => call_id, "name" => tool_name, "arguments" => arguments}
    |> MapUtils.drop_nil_values()
  end

  defp output_payload(_payload, details) when is_map(details) and map_size(details) > 0, do: details

  defp output_payload(payload, _details) when is_map(payload) do
    output =
      %{
        "success" => map_value(payload, :success),
        "result" => map_value(payload, :result),
        "output" => map_value(payload, :output),
        "message" => map_value(payload, :message)
      }
      |> MapUtils.drop_nil_values()

    if map_size(output) == 0, do: nil, else: output
  end

  defp output_payload(_payload, _details), do: nil

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> value
      :error -> Map.get(map, to_string(key))
    end
  end

  defp map_value(_map, _key), do: nil

  defp first_present(values) do
    Enum.find_value(values, fn
      value when value in [nil, ""] -> nil
      value -> value
    end)
  end

  defp deep_merge(left, right) when is_map(left) and is_map(right) do
    Map.merge(left, right, fn
      _key, left_value, right_value when is_map(left_value) and is_map(right_value) ->
        deep_merge(left_value, right_value)

      _key, _left_value, right_value ->
        right_value
    end)
  end
end
