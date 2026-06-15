defmodule SymphonyElixir.LocalRelay.ProtocolExtensions do
  @moduledoc """
  Tool-calling protocol frame helpers for the local relay.
  """

  @protocol_version 1
  # Wire frame-format version required by the Go helper's DecodeFrame
  # (internal/protocol: const SchemaVersion = "1"). The helper rejects any
  # inbound frame whose schema_version != "1", so every frame we push to the
  # helper must carry it. Distinct from @protocol_version (our own bookkeeping).
  @schema_version "1"
  @tool_frame_types ~w(tool_definitions tool_call_request tool_execution_request tool_call_result)

  @spec protocol_version() :: pos_integer()
  def protocol_version, do: @protocol_version

  @spec schema_version() :: String.t()
  def schema_version, do: @schema_version

  @spec tool_frame_types() :: [String.t()]
  def tool_frame_types, do: @tool_frame_types

  @spec tool_frame_type?(String.t()) :: boolean()
  def tool_frame_type?(type), do: type in @tool_frame_types

  @spec versioned_frame(map()) :: map()
  def versioned_frame(frame) when is_map(frame) do
    frame
    |> Map.put_new("protocol", @protocol_version)
    |> Map.put_new("schema_version", @schema_version)
  end

  @spec tool_execution_request(String.t(), map(), map() | nil, map()) :: map()
  def tool_execution_request(correlation_id, tool_call, tool_definition \\ nil, context \\ %{}) when is_map(tool_call) do
    %{
      "type" => "tool_execution_request",
      "protocol" => @protocol_version,
      "correlation_id" => correlation_id,
      "tool_call_id" => string_value(tool_call, :id) || string_value(tool_call, :tool_call_id),
      "name" => string_value(tool_call, :name),
      "arguments" => map_value(tool_call, :arguments) || %{},
      "execution_kind" => tool_definition && string_value(tool_definition, :execution_kind),
      "execution_config" => tool_definition && (map_value(tool_definition, :execution_config) || %{}),
      "context" => if(map_size(context) > 0, do: context)
    }
    |> reject_nil_values()
  end

  @spec normalize_tool_calls(map()) :: [map()]
  def normalize_tool_calls(%{"tool_calls" => calls}) when is_list(calls), do: Enum.flat_map(calls, &normalize_tool_call/1)
  def normalize_tool_calls(%{tool_calls: calls}) when is_list(calls), do: Enum.flat_map(calls, &normalize_tool_call/1)
  def normalize_tool_calls(_frame), do: []

  defp normalize_tool_call(call) when is_map(call) do
    id = string_value(call, :id) || string_value(call, :tool_call_id)
    name = string_value(call, :name)

    if present?(id) and present?(name) do
      [
        %{
          "id" => id,
          "name" => name,
          "arguments" => arguments(call)
        }
      ]
    else
      []
    end
  end

  defp normalize_tool_call(_call), do: []

  defp arguments(call) do
    case map_value(call, :arguments) do
      arguments when is_map(arguments) -> arguments
      _ -> %{}
    end
  end

  defp present?(value), do: is_binary(value) and String.trim(value) != ""

  defp string_value(map, key) do
    case map_value(map, key) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
