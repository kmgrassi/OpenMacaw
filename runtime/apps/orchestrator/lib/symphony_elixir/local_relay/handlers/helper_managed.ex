defmodule SymphonyElixir.LocalRelay.Handlers.HelperManaged do
  @moduledoc """
  Session handler for helper-managed local relay turns.

  The helper owns model/tool orchestration and the runtime forwards tool
  execution requests plus progress events until a terminal frame arrives.
  """

  require Logger

  @behaviour SymphonyElixir.LocalRelay.Session

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Registry, Session}
  alias SymphonyElixir.Runner.Contract

  @impl true
  def init(context) do
    %{
      correlation_id: Map.fetch!(context, :correlation_id),
      timeout_ms: Map.fetch!(context, :timeout_ms),
      on_message: Map.get(context, :on_message),
      tool_definitions: Map.get(context, :tool_definitions, []),
      tool_execution_context: Map.get(context, :tool_execution_context, %{}),
      output: ""
    }
  end

  @impl true
  def timeout_ms(state), do: state.timeout_ms

  @impl true
  def handle_frame(:started, frame, state) do
    emit_event(state, %{event: :turn_started, payload: frame})
    {:continue, state}
  end

  def handle_frame(:progress, frame, state) do
    case normalize_progress(frame) do
      {:event, event, delta} ->
        emit_event(state, event)
        {:continue, %{state | output: state.output <> delta}}

      {:failed, retryable?, reason} ->
        if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}

      :ignore ->
        {:continue, state}
    end
  end

  def handle_frame(:complete, frame, state) do
    output_text = Session.complete_output(frame, state.output)
    usage = Session.frame_usage(frame)
    emit_usage_updated(state, usage)
    emit_event(state, run_completed_event(frame, output_text, usage))

    {:ok,
     %{
       "status" => "completed",
       "correlation_id" => state.correlation_id,
       "output_text" => output_text,
       "usage" => usage,
       "metadata" => Session.frame_metadata(frame)
     }}
  end

  def handle_frame(:error, frame, state) do
    {retryable?, reason} = Session.classify_error(frame)
    emit_event(state, %{event: :turn_ended_with_error, payload: frame, message: to_string(reason)})
    if retryable?, do: {:error, {:retryable, reason}}, else: {:error, {:fatal, reason}}
  end

  def handle_frame(:tool_call_request, frame, state) do
    dispatch_tool_execution_requests(state, frame)
    {:continue, state}
  end

  def handle_frame(:tool_call_result, frame, state) do
    emit_tool_result_event(state, frame)
    {:continue, state}
  end

  def handle_frame(:cancel_ack, _frame, state), do: {:continue, state}

  defp normalize_progress(%{"type" => "progress", "event" => event} = frame), do: normalize_backend_event(event, frame)
  defp normalize_progress(%{"event" => event} = frame), do: normalize_backend_event(event, frame)
  defp normalize_progress(%{event: event} = frame), do: normalize_backend_event(to_string(event), stringify_keys(frame))
  defp normalize_progress(_frame), do: :ignore

  defp normalize_backend_event("run.started", frame), do: {:event, %{event: :turn_started, payload: frame}, ""}

  defp normalize_backend_event("message.delta", frame) do
    text = Map.get(frame, "text") || get_in(frame, ["payload", "text"]) || ""
    {:event, %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => text}}}, text}
  end

  defp normalize_backend_event("message.completed", frame) do
    text = Map.get(frame, "text") || get_in(frame, ["payload", "text"]) || ""
    {:event, %{event: :turn_completed, payload: frame, message: text}, text}
  end

  defp normalize_backend_event("tool.started", frame), do: {:event, %{event: :tool_call_started, payload: frame}, ""}
  defp normalize_backend_event("tool.completed", frame), do: {:event, %{event: :tool_call_completed, payload: frame}, ""}

  defp normalize_backend_event("usage.updated", frame) do
    usage = Session.frame_usage(frame) || %{}
    {:event, usage_updated_event(usage), ""}
  end

  defp normalize_backend_event("run.completed", _frame), do: :ignore

  defp normalize_backend_event("run.failed", frame) do
    {retryable?, reason} = Session.classify_error(frame)
    {:failed, retryable?, reason}
  end

  defp normalize_backend_event("warning", frame), do: {:event, %{event: :notification, payload: frame, message: Map.get(frame, "message")}, ""}

  defp normalize_backend_event("error", frame) do
    {retryable?, reason} = Session.classify_error(frame)
    {:failed, retryable?, reason}
  end

  defp normalize_backend_event(_event, _frame), do: :ignore

  defp dispatch_tool_execution_requests(state, frame) do
    frame
    |> ProtocolExtensions.normalize_tool_calls()
    |> Enum.each(fn tool_call ->
      emit_event(state, %{
        event: :tool_call_started,
        payload: Map.merge(frame, %{"tool_call" => tool_call, "tool_call_id" => Map.get(tool_call, "id"), "tool_name" => Map.get(tool_call, "name")})
      })

      request =
        ProtocolExtensions.tool_execution_request(
          state.correlation_id,
          tool_call,
          tool_definition_for(state, Map.get(tool_call, "name")),
          state.tool_execution_context
        )

      case Registry.send_tool_execution_request(state.correlation_id, request) do
        :ok -> :ok
        {:error, reason} -> emit_event(state, %{event: :tool_call_failed, payload: request, message: to_string(reason)})
      end
    end)
  end

  defp emit_tool_result_event(state, frame) do
    success? = Map.get(frame, "success") || Map.get(frame, :success)
    event = if success?, do: :tool_call_completed, else: :tool_call_failed
    emit_event(state, %{event: event, payload: stringify_keys(frame)})
  end

  defp tool_definition_for(state, name) do
    Enum.find(state.tool_definitions, fn tool ->
      map_value(tool, :name) == name or map_value(tool, :slug) == name
    end)
  end

  defp emit_event(%{on_message: on_message}, event) when is_function(on_message, 1) do
    case Contract.normalize_event(event) do
      {:ok, normalized} -> on_message.(normalized)
      {:error, reason} -> Logger.warning("local_relay_dropped_event reason=#{inspect(reason)} event=#{inspect(event)}")
    end
  end

  defp emit_event(_state, _event), do: :ok

  defp emit_usage_updated(_state, usage) when usage in [nil, %{}], do: :ok
  defp emit_usage_updated(state, usage) when is_map(usage), do: emit_event(state, usage_updated_event(usage))
  defp emit_usage_updated(_state, _usage), do: :ok

  defp usage_updated_event(usage) do
    %{
      event: :notification,
      usage: usage,
      payload: %{"method" => "usage.updated", "params" => %{"usage" => usage}}
    }
  end

  defp run_completed_event(frame, output_text, usage) do
    %{
      event: :turn_completed,
      payload: %{"method" => "run.completed", "params" => %{"output" => output_text, "usage" => usage}},
      message: output_text,
      usage: usage,
      metadata: Session.frame_metadata(frame)
    }
  end

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        value

      :error ->
        string_key = to_string(key)
        Enum.find_value(map, fn {candidate_key, value} -> if to_string(candidate_key) == string_key, do: value end)
    end
  end

  defp map_value(_map, _key), do: nil

  defp stringify_keys(map) when is_map(map), do: Map.new(map, fn {key, value} -> {to_string(key), value} end)
end
