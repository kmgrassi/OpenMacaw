defmodule SymphonyElixir.ScheduledTask.LearningSampler do
  @moduledoc """
  Provides bounded transcript samples for scheduled learning-agent reviews.
  """

  alias SymphonyElixir.MessageLog

  @default_fetch_limit 100
  @default_message_window 10

  @spec sample(String.t(), map(), keyword()) :: {:ok, map() | nil} | {:error, term()}
  def sample(workspace_id, sampling, opts \\ [])

  def sample(workspace_id, sampling, opts) when is_binary(workspace_id) and is_map(sampling) do
    fetch_limit =
      sampling |> integer_value("fetchLimit", @default_fetch_limit) |> min(200) |> max(1)

    message_window =
      sampling |> integer_value("messageWindow", @default_message_window) |> min(50) |> max(1)

    message_log = Keyword.get(opts, :message_log, MessageLog)

    case message_log.list_workspace_messages(workspace_id, limit: fetch_limit) do
      {:ok, messages, _pagination} when is_list(messages) ->
        messages
        |> reject_learning_scheduler_messages()
        |> group_messages()
        |> Enum.filter(&(length(elem(&1, 1)) > 0))
        |> case do
          [] ->
            {:ok, nil}

          candidates ->
            {group, group_messages} = Enum.random(candidates)

            {:ok,
             %{
               "group" => group,
               "workspace_id" => workspace_id,
               "message_window" => message_window,
               "messages" =>
                 group_messages
                 |> Enum.reverse()
                 |> Enum.take(-message_window)
                 |> Enum.map(&sample_message/1)
             }}
        end

      :disabled ->
        {:ok, nil}

      {:error, _reason} = error ->
        error
    end
  end

  def sample(_workspace_id, _sampling, _opts), do: {:ok, nil}

  defp reject_learning_scheduler_messages(messages) do
    Enum.reject(messages, fn message ->
      metadata = Map.get(message, "metadata") || %{}

      Map.get(metadata, "source") == "scheduled_task" and
        Map.get(metadata, "kind") == "scheduled_agent_message"
    end)
  end

  defp group_messages(messages) do
    messages
    |> Enum.group_by(&group_key/1)
    |> Enum.reject(fn {key, _messages} -> is_nil(key) end)
  end

  defp group_key(message) do
    cond do
      string_value(message, "run_id") -> "run:#{string_value(message, "run_id")}"
      string_value(message, "session_id") -> "session:#{string_value(message, "session_id")}"
      true -> nil
    end
  end

  defp sample_message(message) do
    %{
      "id" => Map.get(message, "id"),
      "role" => Map.get(message, "role"),
      "content" => truncate(Map.get(message, "content")),
      "created_at" => Map.get(message, "created_at"),
      "agent_id" => Map.get(message, "agent_id"),
      "run_id" => Map.get(message, "run_id"),
      "session_id" => Map.get(message, "session_id")
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp integer_value(map, key, default) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_integer(value) ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {parsed, ""} -> parsed
          _ -> default
        end

      _ ->
        default
    end
  end

  defp string_value(map, key) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp truncate(value) when is_binary(value), do: String.slice(value, 0, 4_000)
  defp truncate(value), do: value
end
