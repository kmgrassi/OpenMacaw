defmodule SymphonyElixir.Runner.ClaudeCode.EventMapper do
  @moduledoc """
  Maps Claude Agent SDK bridge messages into the stable runner event contract.

  The Node bridge remains provider-specific. This module is the boundary that
  turns bridge protocol messages into backend-neutral runtime events consumed by
  broker logging, dashboards, and token accounting.
  """

  alias SymphonyElixir.Runner.Contract

  @type bridge_message :: map()
  @type normalized_event :: Contract.event()

  @doc """
  Normalizes one bridge message.

  Unknown bridge messages are surfaced as `:notification` events so the runner
  can preserve observability without leaking provider-specific event names into
  the runner contract.
  """
  @spec normalize(bridge_message(), keyword()) :: {:ok, normalized_event()} | {:error, term()}
  def normalize(message, opts \\ []) when is_map(message) do
    message
    |> do_normalize(opts)
    |> Contract.normalize_event()
  end

  @doc """
  Normalizes a list of bridge messages, returning the first contract error.
  """
  @spec normalize_many([bridge_message()], keyword()) :: {:ok, [normalized_event()]} | {:error, term()}
  def normalize_many(messages, opts \\ []) when is_list(messages) do
    Enum.reduce_while(messages, {:ok, []}, fn message, {:ok, events} ->
      case normalize(message, opts) do
        {:ok, event} -> {:cont, {:ok, events ++ [event]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp do_normalize(%{"method" => "message/delta"} = message, opts) do
    params = params(message)
    text = string_value(params, ["textDelta", "text_delta", "text", "delta"]) || ""

    event(:notification, message, opts,
      message: text,
      payload:
        payload("item/agentMessage/delta", params, %{
          "text" => text,
          "text_delta" => text
        })
    )
  end

  defp do_normalize(%{"method" => "tool/started"} = message, opts) do
    params = params(message)

    event(:tool_call_started, message, opts,
      payload:
        tool_payload("tool.started", params, %{
          "status" => "started"
        })
    )
  end

  defp do_normalize(%{"method" => "tool/can_use_tool"} = message, opts) do
    params = params(message)

    event(:tool_call_started, message, opts,
      payload:
        tool_payload("tool.can_use_tool", params, %{
          "status" => "requested",
          "phase" => "request",
          "decision" => string_value(params, ["decision"]) || "allow"
        })
    )
  end

  defp do_normalize(%{"method" => "tool/completed"} = message, opts) do
    params = params(message)

    event(:tool_call_completed, message, opts,
      payload:
        tool_payload("tool.completed", params, %{
          "status" => "completed"
        })
    )
  end

  defp do_normalize(%{"method" => method} = message, opts) when method in ["tool/failed", "tool/error"] do
    params = params(message)
    reason = string_value(params, ["reason", "error", "message"])

    event(:tool_call_failed, message, opts,
      message: reason,
      payload:
        tool_payload("tool.failed", params, %{
          "status" => "failed",
          "reason" => reason
        })
    )
  end

  defp do_normalize(%{"method" => "usage/updated"} = message, opts) do
    params = params(message)
    usage = normalize_usage(Map.get(params, "usage") || params)

    event(:notification, message, opts,
      usage: usage,
      payload: payload("usage.updated", params, %{"usage" => usage})
    )
  end

  defp do_normalize(%{"method" => "turn/completed"} = message, opts) do
    params = params(message)
    usage = normalize_usage(Map.get(params, "usage"))
    output = string_value(params, ["result", "output", "outputText", "output_text"])

    event(:turn_completed, message, opts,
      message: output,
      usage: usage,
      payload:
        payload("turn/completed", params, %{
          "output" => output,
          "usage" => usage
        })
    )
  end

  defp do_normalize(%{"method" => method} = message, opts) when method in ["turn/failed", "turn/error"] do
    params = params(message)
    reason = string_value(params, ["reason", "error", "message"]) || "Claude Code turn failed"

    event(:turn_ended_with_error, message, opts,
      message: reason,
      payload:
        payload("turn/failed", params, %{
          "reason" => reason,
          "retryable" => retryable?(params)
        })
    )
  end

  defp do_normalize(%{"method" => method} = message, opts)
       when method in ["approval/input-required", "approval/required", "input/required", "permission/requested"] do
    params = params(message)

    event(:approval_requested, message, opts, payload: payload("approval.requested", params))
  end

  defp do_normalize(%{"method" => method} = message, opts)
       when method in ["approval/resolved", "permission/resolved"] do
    params = params(message)

    event(:approval_resolved, message, opts, payload: payload("approval.resolved", params))
  end

  defp do_normalize(%{"result" => %{} = result} = message, opts) do
    event(:session_started, message, opts, payload: payload("session.started", result))
  end

  defp do_normalize(%{"method" => method} = message, opts) do
    event(:notification, message, opts, payload: payload(method, params(message)))
  end

  defp do_normalize(message, opts) do
    event(:notification, message, opts, payload: %{"method" => "bridge.message", "params" => stringify_keys(message)})
  end

  defp event(event_name, bridge_message, opts, extra) do
    base = %{
      event: event_name,
      timestamp: timestamp(opts),
      metadata:
        %{
          runner: "claude_code",
          provider: Keyword.get(opts, :provider),
          model: Keyword.get(opts, :model),
          bridge_id: Map.get(bridge_message, "id") || Map.get(bridge_message, :id)
        }
        |> reject_nil_values()
    }

    extra
    |> Enum.reduce(base, fn
      {_key, nil}, acc -> acc
      {key, value}, acc -> Map.put(acc, key, value)
    end)
  end

  defp payload(method, params, extra \\ []) do
    normalized_params =
      params
      |> stringify_keys()
      |> Map.merge(extra |> Enum.reject(fn {_key, value} -> is_nil(value) end) |> Map.new())
      |> reject_nil_values()

    %{"method" => method, "params" => normalized_params}
  end

  defp tool_payload(method, params, extra) do
    tool_name = string_value(params, ["tool", "name", "toolName", "tool_name"])
    tool_call_id = string_value(params, ["toolUseId", "tool_use_id", "toolCallId", "tool_call_id", "id"])
    input = Map.get(params, "input") || Map.get(params, :input) || Map.get(params, "arguments") || Map.get(params, :arguments)
    output = Map.get(params, "output") || Map.get(params, :output)

    tool_params =
      %{
        "tool_name" => tool_name,
        "tool_call_id" => tool_call_id,
        "name" => tool_name,
        "callId" => tool_call_id,
        "input" => stringify_nested(input),
        "output" => stringify_nested(output)
      }
      |> Map.merge(extra)

    payload(method, params, tool_params)
    |> put_in(["params", "source"], "claude_code")
  end

  defp params(%{"params" => params}) when is_map(params), do: params
  defp params(%{params: params}) when is_map(params), do: params
  defp params(_message), do: %{}

  defp timestamp(opts) do
    Keyword.get_lazy(opts, :timestamp, &DateTime.utc_now/0)
  end

  defp normalize_usage(usage) when is_map(usage) do
    %{
      "input_tokens" => int_value(usage, ["input_tokens", "inputTokens", "input"]),
      "output_tokens" => int_value(usage, ["output_tokens", "outputTokens", "output"]),
      "total_tokens" => int_value(usage, ["total_tokens", "totalTokens", "total"])
    }
    |> reject_nil_values()
  end

  defp normalize_usage(_usage), do: %{}

  defp retryable?(params) do
    case Map.get(params, "retryable") || Map.get(params, :retryable) do
      value when is_boolean(value) -> value
      _ -> false
    end
  end

  defp string_value(map, keys) do
    Enum.find_value(keys, fn key ->
      case fetch_value(map, key) do
        value when is_binary(value) and value != "" -> value
        value when is_atom(value) and not is_nil(value) -> Atom.to_string(value)
        _ -> nil
      end
    end)
  rescue
    ArgumentError -> nil
  end

  defp int_value(map, keys) do
    Enum.find_value(keys, fn key ->
      map |> fetch_value(key) |> parse_int()
    end)
  rescue
    ArgumentError -> nil
  end

  defp fetch_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        value

      :error when is_binary(key) ->
        Map.get(map, String.to_atom(key))

      :error ->
        nil
    end
  end

  defp parse_int(value) when is_integer(value), do: value

  defp parse_int(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp parse_int(_value), do: nil

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), stringify_nested(value)}
      {key, value} -> {key, stringify_nested(value)}
    end)
  end

  defp stringify_keys(_value), do: %{}

  defp stringify_nested(value) when is_map(value), do: stringify_keys(value)
  defp stringify_nested(value) when is_list(value), do: Enum.map(value, &stringify_nested/1)
  defp stringify_nested(value), do: value

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
