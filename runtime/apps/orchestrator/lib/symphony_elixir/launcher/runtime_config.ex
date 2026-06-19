defmodule SymphonyElixir.Launcher.RuntimeConfig do
  @moduledoc """
  Helpers for comparing launcher runtime configs and detecting resolved credentials.
  """

  @spec equivalent?(term(), term()) :: boolean()
  def equivalent?(left, right) do
    comparable(left) == comparable(right)
  end

  @spec resolved_credentials?(term()) :: boolean()
  def resolved_credentials?(config) when is_map(config) do
    config = normalize_value(config)

    has_credentials_map?(config) or has_tracker_api_key?(config)
  end

  def resolved_credentials?(_config), do: false

  @spec format_error(term()) :: String.t()
  def format_error(reason) when is_binary(reason), do: reason
  def format_error({:invalid_agent_config, message, _details}) when is_binary(message), do: message
  def format_error(reason), do: inspect(reason)

  defp comparable(config) when is_map(config) do
    config
    |> normalize_value()
    |> drop_volatiles()
  end

  defp comparable(config), do: config

  defp has_credentials_map?(config) do
    case Map.get(config, "credentials") do
      credentials when is_map(credentials) -> map_size(credentials) > 0
      _ -> false
    end
  end

  defp has_tracker_api_key?(config) do
    case get_in(config, ["tracker", "api_key"]) do
      value when is_binary(value) -> value != ""
      _ -> false
    end
  end

  defp normalize_value(value) when is_map(value) do
    Map.new(value, fn {key, nested} -> {to_string(key), normalize_value(nested)} end)
  end

  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value

  defp drop_volatiles(config) when is_map(config) do
    config
    |> Map.delete("trace_id")
    |> update_in(["runtime"], fn
      runtime when is_map(runtime) -> Map.delete(runtime, "trace_id")
      runtime -> runtime
    end)
  end
end
