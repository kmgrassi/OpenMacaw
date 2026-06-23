defmodule SymphonyElixirWeb.GatewaySocket do
  @moduledoc """
  Raw websocket server implementing the runtime gateway contract expected by the web client.
  """

  @behaviour WebSock

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixir.Launcher.ConfigRegistry
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.Schema.GatewayFrame
  alias SymphonyElixir.Schema.GatewayFrame.{Ping, Request}
  alias SymphonyElixir.ToolCallPersistence
  alias SymphonyElixirWeb.Gateway.{Frame, Middleware}

  alias SymphonyElixirWeb.GatewaySocket.{
    ChatHandlers,
    ConnectionMetadata,
    ConfigHandlers,
    ConnectionHandlers,
    Logging,
    MessageLogger,
    MiscHandlers,
    RunnerEventTranslation,
    SessionHandlers
  }

  @request_handlers [
    ConnectionHandlers,
    ChatHandlers,
    SessionHandlers,
    ConfigHandlers,
    MiscHandlers
  ]

  @supported_methods [
    "channels.status",
    "chat.abort",
    "chat.send",
    "config.get",
    "config.set",
    "connect",
    "models.list",
    "sessions.delete",
    "sessions.list",
    "sessions.reset",
    "sessions.usage",
    "usage.cost",
    "web.login.start",
    "web.login.wait"
  ]

  @supported_events ["chat", "connect.challenge"]
  @protocol_version 3

  @impl true
  def init(state) do
    workflow_path = Map.get(state, :workflow_path)
    scope = ConnectionMetadata.scope_from_query(state.query_params)
    request_headers = Map.get(state, :request_headers, %{})
    trace_id = RuntimeLog.ensure_trace_id(RuntimeLog.trace_id_from_headers(request_headers))
    connection_id = ConnectionMetadata.connection_id_from(state.query_params, request_headers)

    if is_binary(workflow_path) do
      ConfigRegistry.put(self(), workflow_path)
    end

    log_gateway(:info, :gateway_ws_opened, scope, trace_id, connection_id, %{
      protocol_version: @protocol_version,
      workflow_path: workflow_path
    })

    {:ok,
     %{
       scope: scope,
       query_params: state.query_params,
       request_headers: request_headers,
       peer_data: state.peer_data,
       session_thread_id: nil,
       tool_call_acc: %{},
       workflow_path: workflow_path,
       trace_id: trace_id,
       connection_id: connection_id,
       connected?: false
     }}
  end

  @impl true
  def handle_in({payload, _opts}, state) when is_binary(payload) do
    case Frame.decode(payload) do
      {:ok, %Ping{ts: ts}} ->
        {:push, [Frame.pong(ts)], state}

      {:ok, %Request{id: id, method: method, params: params}} ->
        {replies, state} = handle_request(id, method, params, state)
        {:push, replies, state}

      {:error, reason} ->
        log_rejected_gateway_frame(reason, state)
        {:ok, state}
    end
  end

  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info({:gateway_runner_event, session_key, run_id, message}, state) do
    {reply, state} = maybe_translate_runner_event(session_key, run_id, message, state)
    if reply, do: {:push, [reply], state}, else: {:ok, state}
  end

  def handle_info({:gateway_runner_complete, session_key, run_id, :ok}, state) do
    handle_runner_complete(session_key, run_id, state, [])
  end

  def handle_info({:gateway_runner_complete, session_key, run_id, {:ok, result}}, state) do
    handle_runner_complete(session_key, run_id, state,
      assistant_fallback: Map.get(result, "output_text"),
      agent_context_snapshot: Map.get(result, "agent_context_snapshot"),
      model: Map.get(result, "model"),
      provider: Map.get(result, "provider"),
      usage: Map.get(result, "usage") || %{}
    )
  end

  def handle_info({:gateway_runner_failed, session_key, run_id, reason}, state) do
    log_gateway(:error, :gateway_ws_upstream_failed, state, %{
      run_id: run_id,
      session_key: session_key,
      error_code: gateway_error_code(reason),
      reason: inspect(reason),
      retryable: false
    })

    {:ok, session} = SessionStore.fail_run(run_id)
    message = Middleware.error_message(reason)
    code = Middleware.error_code(reason)

    record_assistant_message(state, message, run_id, %{error_code: code, error_message: message})

    payload = %{
      runId: run_id,
      sessionKey: (session && session.key) || session_key,
      state: "error",
      errorMessage: message,
      errorCode: code
    }

    {:push, [Frame.event("chat", payload)], drop_tool_calls(state, run_id)}
  end

  def handle_info({:gateway_runner_down, session_key, run_id, reason}, state) do
    log_gateway(:error, :gateway_ws_upstream_failed, state, %{
      run_id: run_id,
      session_key: session_key,
      error_code: gateway_error_code(reason),
      reason: inspect(reason),
      retryable: false
    })

    {:ok, session} = SessionStore.fail_run(run_id)
    message = Middleware.error_message(reason)
    code = Middleware.error_code(reason)

    record_assistant_message(state, message, run_id, %{error_code: code, error_message: message})

    payload = %{
      runId: run_id,
      sessionKey: (session && session.key) || session_key,
      state: "error",
      errorMessage: message,
      errorCode: code
    }

    {:push, [Frame.event("chat", payload)], drop_tool_calls(state, run_id)}
  end

  def handle_info({:gateway_runner_aborted, session_key, run_id}, state) do
    # Emitted when a run's session is deleted while the run is still in
    # flight. SessionStore.delete_session/1 kills the task and
    # demonitor-flushes it, so neither a later :gateway_runner_complete
    # nor a :gateway_runner_down ever arrives — the only place that can
    # tell this run's client the turn is over is here. Without it the web
    # composer's send lifecycle never unwinds and the Send button stays
    # disabled.
    payload = %{
      runId: run_id,
      sessionKey: session_key,
      state: "aborted"
    }

    {:push, [Frame.event("chat", payload)], drop_tool_calls(state, run_id)}
  end

  def handle_info(_message, state), do: {:ok, state}

  defp handle_runner_complete(session_key, run_id, state, opts) do
    log_gateway(:info, :run_completed, state, %{run_id: run_id})

    case SessionStore.complete_run(run_id, opts) do
      {:ok, nil} ->
        # The run completed but SessionStore had no run/session to attach
        # the assistant message to — e.g. the session was deleted mid-turn,
        # the run was already cleared, or this is a duplicate completion.
        # We still owe the client a terminal frame: without one the web
        # client's send lifecycle never unwinds and the composer spins
        # forever (the Send button stays disabled). Emit a best-effort
        # `final` to release it; persistence already happened (or is moot)
        # on whichever path cleared the run.
        payload = %{
          runId: run_id,
          sessionKey: session_key,
          state: "final",
          message: %{
            role: "assistant",
            content: Keyword.get(opts, :assistant_fallback) || ""
          }
        }

        {:push, [Frame.event("chat", payload)], drop_tool_calls(state, run_id)}

      {:ok, session} ->
        metadata = assistant_message_metadata(session, opts)

        record_assistant_message(state, latest_assistant_content(session), run_id, metadata)

        payload = %{
          runId: run_id,
          sessionKey: session.key,
          state: "final",
          message: %{
            role: "assistant",
            content: latest_assistant_content(session),
            metadata: metadata
          }
        }

        {:push, [Frame.event("chat", payload)], drop_tool_calls(state, run_id)}
    end
  end

  defp assistant_message_metadata(session, opts) do
    %{
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      total_tokens: session.total_tokens,
      model: Keyword.get(opts, :model) || Map.get(session, :model),
      provider: Keyword.get(opts, :provider),
      agent_context_snapshot: Keyword.get(opts, :agent_context_snapshot)
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  @impl true
  def terminate(reason, state) do
    log_gateway(
      :info,
      :gateway_ws_closed,
      state,
      ConnectionMetadata.close_fields(reason, @protocol_version)
    )

    if is_binary(Map.get(state, :workflow_path)) do
      ConfigRegistry.delete(self())
    end

    :ok
  end

  defp handle_request(id, method, params, state) do
    context = %{
      protocol_version: @protocol_version,
      supported_methods: @supported_methods,
      supported_events: @supported_events
    }

    Enum.reduce_while(@request_handlers, :not_handled, fn handler, :not_handled ->
      case handler.handle(method, id, params, state, context) do
        {:handled, result} -> {:halt, result}
        :not_handled -> {:cont, :not_handled}
      end
    end)
    |> case do
      :not_handled -> method_not_supported(id, method, state)
      result -> result
    end
  end

  defp method_not_supported(id, method, state) do
    log_gateway(:warning, :request_failed, state, %{
      request_id: id,
      frame_method: method,
      error_code: "method_not_supported",
      retryable: false
    })

    {[
       Frame.response(id, false, nil, %{
         code: "method_not_supported",
         message: "#{method} is not supported"
       })
     ], state}
  end

  defp maybe_translate_runner_event(session_key, run_id, message, state) do
    RunnerEventTranslation.translate(session_key, run_id, message, state)
  end

  defp log_gateway(level, event, %{scope: scope} = state, fields) do
    log_gateway(level, event, scope, state.trace_id, state.connection_id, fields)
  end

  defp log_rejected_gateway_frame(reason, state) do
    detail = gateway_frame_error_detail(reason)

    :telemetry.execute(
      [:symphony_elixir, :gateway, :frame, :rejected],
      %{count: 1},
      %{reason: gateway_frame_error_atom(reason)}
    )

    log_gateway(:warning, :gateway_ws_frame_rejected, state, %{
      error_code: gateway_frame_error_code(reason),
      frame_method: frame_method_from_error(reason),
      reason: detail,
      retryable: false
    })
  end

  defp gateway_frame_error_detail({:invalid_json, message}), do: "invalid JSON: #{message}"
  defp gateway_frame_error_detail(reason), do: GatewayFrame.error_detail(reason)

  defp gateway_frame_error_code(reason),
    do: reason |> gateway_frame_error_atom() |> Atom.to_string()

  defp gateway_frame_error_atom({:invalid_json, _message}), do: :invalid_json
  defp gateway_frame_error_atom(:payload_not_object), do: :payload_not_object
  defp gateway_frame_error_atom({:missing_field, _field}), do: :missing_field
  defp gateway_frame_error_atom({:invalid_field, _field, _expected}), do: :invalid_field
  defp gateway_frame_error_atom({:unsupported_type, _type}), do: :unsupported_type

  defp frame_method_from_error({:invalid_field, "method", _expected}), do: nil
  defp frame_method_from_error(_reason), do: nil

  defp log_gateway(level, event, scope, trace_id, connection_id, fields),
    do: Logging.log(level, event, scope, trace_id, connection_id, fields)

  defp gateway_error_code(reason), do: Middleware.normalize_error(reason).code

  defp record_assistant_message(state, message, run_id, metadata) do
    MessageLogger.record(:assistant, state, %{
      message: message,
      run_id: run_id,
      metadata: metadata,
      tool_calls: tool_calls_for(state, run_id)
    })
  end

  defp tool_calls_for(state, run_id) do
    state
    |> get_in([:tool_call_acc, run_id])
    |> ToolCallPersistence.completed()
  end

  defp drop_tool_calls(state, run_id) do
    update_in(state, [:tool_call_acc], &Map.delete(&1 || %{}, run_id))
  end

  defp latest_assistant_content(session) do
    session.messages
    |> Enum.find(&(Map.get(&1, "role") == "assistant"))
    |> case do
      %{"content" => content} -> content
      _ -> ""
    end
  end
end
