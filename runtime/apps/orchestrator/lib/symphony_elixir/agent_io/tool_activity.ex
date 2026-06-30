defmodule SymphonyElixir.AgentIO.ToolActivity do
  @moduledoc false

  @summary_limit 500

  @type phase :: :request | :result

  @spec normalize(map()) :: map()
  def normalize(%{event: event} = message) do
    payload = Map.get(message, :payload) || %{}
    params = params(payload)
    result = Map.get(message, :result) || Map.get(message, "result")

    %{
      "vendor" => vendor(payload),
      "toolName" => tool_name(params, payload),
      "inputSummary" => input_summary(params, payload),
      "phase" => phase(event),
      "decision" => decision(event, result),
      "toolCallId" => tool_call_id(params, payload),
      "rawEvent" => Atom.to_string(event)
    }
    |> maybe_put("success", success(result))
    |> maybe_put("outputSummary", output_summary(result))
    |> reject_nil_values()
  end

  def normalize(%{"event" => event} = message) do
    message
    |> Map.delete("event")
    |> Map.put(:event, event)
    |> normalize()
  end

  def normalize(message) when is_map(message) do
    normalize(Map.put(message, :event, :tool_call_completed))
  end

  defp params(%{"params" => params}) when is_map(params), do: params
  defp params(%{params: params}) when is_map(params), do: params
  defp params(_payload), do: %{}

  defp vendor(%{"vendor" => vendor}) when is_binary(vendor), do: vendor
  defp vendor(%{vendor: vendor}) when is_binary(vendor), do: vendor
  defp vendor(%{"provider" => provider}) when is_binary(provider), do: provider
  defp vendor(%{provider: provider}) when is_binary(provider), do: provider
  defp vendor(%{"method" => "item/tool/call"}), do: "codex"
  defp vendor(%{method: "item/tool/call"}), do: "codex"
  defp vendor(_payload), do: "codex"

  defp tool_name(params, payload) do
    string_field(params, ["tool", :tool, "name", :name, "tool_name", :tool_name]) ||
      string_field(payload, ["toolName", :toolName, "tool_name", :tool_name, "name", :name])
  end

  defp tool_call_id(params, payload) do
    string_field(params, ["callId", :callId, "tool_call_id", :tool_call_id, "id", :id]) ||
      string_field(payload, ["callId", :callId, "toolCallId", :toolCallId, "tool_call_id", :tool_call_id, "id", :id])
  end

  defp input_summary(params, payload) do
    arguments = Map.get(params, "arguments") || Map.get(params, :arguments) || Map.get(payload, "arguments") || Map.get(payload, :arguments)
    summarize(arguments)
  end

  defp output_summary(result) when is_map(result) do
    result
    |> first_present(["output", :output, "summary", :summary, "message", :message])
    |> summarize()
  end

  defp output_summary(_result), do: nil

  defp phase(:tool_call_started), do: "request"
  defp phase("tool_call_started"), do: "request"
  defp phase(_event), do: "result"

  defp decision(:unsupported_tool_call, _result), do: "unsupported"
  defp decision("unsupported_tool_call", _result), do: "unsupported"
  defp decision(:tool_call_started, _result), do: "allowed"
  defp decision("tool_call_started", _result), do: "allowed"
  defp decision(:tool_call_failed, _result), do: "allowed"
  defp decision("tool_call_failed", _result), do: "allowed"
  defp decision(_event, %{"success" => false}), do: "allowed"
  defp decision(_event, %{success: false}), do: "allowed"
  defp decision(_event, _result), do: "allowed"

  defp success(%{"success" => success}) when is_boolean(success), do: success
  defp success(%{success: success}) when is_boolean(success), do: success
  defp success(_result), do: nil

  defp string_field(map, keys) when is_map(map) do
    Enum.find_value(keys, fn key ->
      case Map.get(map, key) do
        value when is_binary(value) ->
          value = String.trim(value)
          if value == "", do: nil, else: value

        value when is_integer(value) ->
          Integer.to_string(value)

        _ ->
          nil
      end
    end)
  end

  defp first_present(map, keys) when is_map(map) do
    Enum.find_value(keys, fn key ->
      case Map.get(map, key) do
        nil -> nil
        value -> value
      end
    end)
  end

  defp summarize(nil), do: nil
  defp summarize(value) when is_binary(value), do: truncate(value)
  defp summarize(value) when is_map(value) or is_list(value), do: value |> Jason.encode!() |> truncate()
  defp summarize(value), do: value |> to_string() |> truncate()

  defp truncate(value) when byte_size(value) <= @summary_limit, do: value

  defp truncate(value) do
    value
    |> binary_part(0, @summary_limit)
    |> Kernel.<>("...")
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
