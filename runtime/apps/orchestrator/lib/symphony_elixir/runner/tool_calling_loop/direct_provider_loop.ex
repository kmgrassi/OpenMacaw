defmodule SymphonyElixir.Runner.ToolCallingLoop.DirectProviderLoop do
  @moduledoc false

  alias SymphonyElixir.Runner.ToolCallingLoop.ToolCallNormalization
  alias SymphonyElixir.Runner.ToolCallingLoop.ToolExecutionDispatcher

  @default_config %{
    max_iterations: 10,
    timeout_per_tool_ms: 30_000,
    total_timeout_ms: 300_000
  }

  @spec run_direct(session :: map(), config :: map()) :: {:ok, map()} | {:error, term()}
  def run_direct(session, config) when is_map(session) and is_map(config) do
    initial_messages = Map.get(config, :initial_messages) || Map.get(config, "initial_messages") || []

    config =
      config
      |> Map.put_new(:max_iterations, Map.get(session, :max_iterations))
      |> normalize_config()

    state = %{
      iteration: 0,
      messages: initial_messages,
      output: "",
      usage: %{},
      repeated_calls: %{},
      started_at: monotonic_ms()
    }

    direct_loop(session, config, state)
  end

  defp direct_loop(session, config, state) do
    case start_direct_provider_turn(session, state.messages) do
      {:ok, turn} ->
        emit_direct_provider_events(session, turn)
        handle_direct_provider_turn(session, config, state, turn)

      {:error, {:retryable, reason}} ->
        emit_provider_turn_failed(session, reason)
        {:error, {:retryable, reason}}

      {:error, {:fatal, reason}} ->
        emit_provider_turn_failed(session, reason)
        {:error, {:fatal, reason}}

      {:error, reason} ->
        emit_provider_turn_failed(session, reason)
        {:error, {:fatal, reason}}
    end
  end

  defp handle_direct_provider_turn(session, config, state, turn) do
    output = Map.get(turn, :output_text) || Map.get(turn, "output_text") || ""

    tool_calls =
      turn
      |> ToolCallNormalization.direct_provider_tool_calls(output, session)
      |> ToolCallNormalization.normalize_direct_tool_calls(session)

    usage = Map.get(turn, :usage) || Map.get(turn, "usage") || %{}

    cond do
      tool_calls == [] ->
        ToolExecutionDispatcher.emit_event(session, %{
          event: :turn_completed,
          payload: %{"runner" => Map.get(session, :runner)},
          message: output,
          usage: usage
        })

        {:ok,
         %{
           "status" => "completed",
           "output_text" => output,
           "usage" => usage,
           "metadata" => %{"runner" => Map.get(session, :runner), "iterations" => state.iteration}
         }}

      state.iteration >= config.max_iterations ->
        reason = {:max_tool_call_iterations_exceeded, config.max_iterations}

        ToolExecutionDispatcher.emit_event(session, %{
          event: :turn_ended_with_error,
          payload: %{"reason" => inspect(reason)},
          message: "Tool-call iteration limit exceeded"
        })

        {:error, {:fatal, reason}}

      true ->
        repeated_calls = repeated_call_counts(state.repeated_calls, tool_calls)

        with :ok <- ensure_no_repeated_calls(%{repeated_calls: repeated_calls}) do
          with {:ok, tool_messages} <- ToolExecutionDispatcher.execute_direct_tool_calls(session, state, tool_calls) do
            next_state = %{
              state
              | iteration: state.iteration + 1,
                output: output,
                usage: usage,
                repeated_calls: repeated_calls,
                messages:
                  state.messages ++
                    direct_assistant_tool_call_messages(output, tool_calls) ++ tool_messages
            }

            direct_loop(session, config, next_state)
          end
        end
    end
  end

  defp start_direct_provider_turn(session, messages) do
    provider = Map.fetch!(session, :provider_module)

    provider.start_turn(
      session.profile,
      messages,
      session.provider_tool_definitions,
      session.provider_opts
    )
  end

  defp direct_assistant_tool_call_messages(output, calls) do
    [
      %{
        "role" => "assistant",
        "content" => output,
        "tool_calls" =>
          Enum.map(calls, fn call ->
            %{
              "id" => call.id,
              "type" => "function",
              "function" => %{"name" => call.name, "arguments" => Jason.encode!(call.arguments)}
            }
          end)
      }
    ]
  end

  defp emit_direct_provider_events(session, turn) do
    turn
    |> Map.get(:events, Map.get(turn, "events", []))
    |> Enum.reject(&runtime_owned_event?/1)
    |> Enum.each(&ToolExecutionDispatcher.emit_event(session, &1))
  end

  defp emit_provider_turn_failed(session, reason) do
    ToolExecutionDispatcher.emit_event(session, %{
      event: :turn_ended_with_error,
      payload: %{"reason" => inspect(reason)},
      message: "Provider turn failed"
    })
  end

  defp runtime_owned_event?(%{event: event})
       when event in [
              :tool_call_started,
              :tool_call_completed,
              :tool_call_failed,
              :turn_completed
            ],
       do: true

  defp runtime_owned_event?(%{"event" => event})
       when event in [
              "tool_call_started",
              "tool_call_completed",
              "tool_call_failed",
              "turn_completed"
            ],
       do: true

  defp runtime_owned_event?(_event), do: false

  defp ensure_no_repeated_calls(%{repeated_calls: repeated_calls}) do
    case Enum.find(repeated_calls, fn {_key, count} -> count >= 3 end) do
      nil -> :ok
      {{name, arguments}, count} -> {:error, {:fatal, {:repeated_tool_call_detected, name, display_arguments(arguments), count}}}
    end
  end

  defp repeated_call_counts(existing, calls) do
    Enum.reduce(calls, existing, fn call, acc ->
      Map.update(acc, {call.name, SymphonyElixir.ToolCall.canonical_arguments(call.arguments)}, 1, &(&1 + 1))
    end)
  end

  defp normalize_config(config) do
    Map.merge(@default_config, %{
      max_iterations: positive_integer(ToolCallNormalization.map_value(config, :max_iterations), @default_config.max_iterations),
      timeout_per_tool_ms: positive_integer(ToolCallNormalization.map_value(config, :timeout_per_tool_ms), @default_config.timeout_per_tool_ms),
      total_timeout_ms: positive_integer(ToolCallNormalization.map_value(config, :total_timeout_ms), @default_config.total_timeout_ms)
    })
  end

  defp positive_integer(value, _default) when is_integer(value) and value > 0, do: value
  defp positive_integer(_value, default), do: default
  defp monotonic_ms, do: System.monotonic_time(:millisecond)

  defp display_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> arguments
    end
  end

  defp display_arguments(arguments), do: arguments
end
