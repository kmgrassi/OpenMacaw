defmodule SymphonyElixirWeb.LocalRelaySocket do
  @moduledoc """
  Raw websocket endpoint for local runtime helper registration.
  """

  @behaviour WebSock

  require Logger

  alias SymphonyElixir.LocalRelay.{
    MachineHeartbeatRecorder,
    Presence,
    ProtocolExtensions,
    Registry,
    TokenValidator
  }

  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.Schema.{LocalRelayHeartbeat, LocalRelayRegister}

  @heartbeat_interval_ms 30_000
  @heartbeat_timeout_factor 2

  @impl true
  def init(state) do
    request_headers = Map.get(state, :request_headers, %{})
    trace_id = RuntimeLog.ensure_trace_id(RuntimeLog.trace_id_from_headers(request_headers))

    {:ok,
     %{
       query_params: Map.get(state, :query_params, %{}),
       request_headers: request_headers,
       peer_data: Map.get(state, :peer_data),
       trace_id: trace_id,
       registered?: false,
       workspace_id: nil,
       machine_id: nil,
       last_heartbeat_ms: nil,
       heartbeat_timer_ref: nil
     }}
  end

  @impl true
  def handle_in({payload, _opts}, state) when is_binary(payload) do
    with {:ok, frame} <- Jason.decode(payload),
         {:ok, type} <- frame_type(frame) do
      handle_frame(type, frame, state)
    else
      {:error, reason} ->
        {:push, [error_frame(nil, :local_runner_protocol_error, protocol_error_message(reason))], state}

      _ ->
        {:push, [error_frame(nil, :local_runner_protocol_error, "invalid frame")], state}
    end
  end

  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info({:local_relay_dispatch, frame}, state) do
    {:push, [text_frame(frame)], state}
  end

  def handle_info({:local_relay_tool_execution_request, frame}, state) do
    {:push, [text_frame(frame)], state}
  end

  def handle_info({:local_relay_frame, frame}, state) do
    {:push, [text_frame(frame)], state}
  end

  def handle_info({:local_relay_cancel, frame}, state) do
    {:push, [text_frame(frame)], state}
  end

  def handle_info(:local_relay_heartbeat_timeout, %{registered?: true} = state) do
    now = System.monotonic_time(:millisecond)
    timeout_ms = heartbeat_timeout_ms()
    elapsed_ms = now - state.last_heartbeat_ms

    if elapsed_ms >= timeout_ms do
      Logger.warning("local_relay_heartbeat_timeout workspace_id=#{state.workspace_id} machine_id=#{state.machine_id}")

      cleanup_registered_connection(state)

      {:stop, {:shutdown, :heartbeat_timeout}, %{state | registered?: false, heartbeat_timer_ref: nil}}
    else
      {:ok, schedule_heartbeat_timeout(state, timeout_ms - elapsed_ms)}
    end
  end

  def handle_info(:local_relay_heartbeat_timeout, state), do: {:ok, state}

  def handle_info({:local_relay_evicted, reason}, %{registered?: true} = state) do
    Logger.info("local_relay_connection_evicted reason=#{reason} workspace_id=#{state.workspace_id} machine_id=#{state.machine_id}")

    cleanup_registered_connection(state, persist_disconnect?: reason != :server_draining)
    {:stop, {:shutdown, reason}, %{state | registered?: false, heartbeat_timer_ref: nil}}
  end

  def handle_info({:local_relay_evicted, _reason}, state), do: {:ok, state}

  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{registered?: true} = state), do: cleanup_registered_connection(state)

  def terminate(_reason, _state), do: :ok

  defp handle_frame("register", frame, state) do
    token =
      bearer_token(state.request_headers) || get_in(frame, ["auth", "token"]) ||
        Map.get(frame, "token")

    with {:ok, register} <- LocalRelayRegister.validate(frame),
         {:ok, token_metadata} <-
           TokenValidator.validate(token, %{
             workspace_id: register.workspace_id,
             # machine_id is server-assigned and returned to the helper in the
             # registration ack — it cannot be known on first connect, so don't
             # match the frame's value (matching it rejected every real
             # registration with machine_mismatch). Identity comes from the token.
             machine_id: nil,
             peer_data: state.peer_data
           }) do
      # The token authoritatively identifies the machine/workspace. Use the
      # validated metadata, not the helper-presented frame values, so the
      # registry, presence, heartbeat recorder, and ack all key on the real
      # machine UUID — otherwise the platform's machine row never goes online.
      register = %{
        register
        | workspace_id: Map.get(token_metadata, :workspace_id) || register.workspace_id,
          machine_id: Map.get(token_metadata, :machine_id) || register.machine_id
      }

      registration =
        LocalRelayRegister.to_presence_registration(register, %{
          token_id: Map.get(token_metadata, :token_id),
          token_hash: TokenValidator.hash_token(token),
          connection_pid: self()
        })

      with {:ok, _helper} <- Registry.register(registry_registration(registration)),
           :ok <- Presence.register(registration) do
        :ok =
          MachineHeartbeatRecorder.record_register(register.machine_id, %{
            helper_version: register.helper_version,
            advertised_runner_kinds: register.runner_kinds
          })

        ack = %{
          type: "registered",
          protocol: ProtocolExtensions.protocol_version(),
          workspace_id: register.workspace_id,
          machine_id: register.machine_id,
          heartbeat_interval_ms: @heartbeat_interval_ms,
          reconnect: %{backoff_ms: [1_000, 2_000, 5_000, 15_000], jitter: true}
        }

        Logger.info("local_relay_registered workspace_id=#{register.workspace_id} machine_id=#{register.machine_id}")

        state =
          state
          |> Map.merge(%{
            registered?: true,
            workspace_id: register.workspace_id,
            machine_id: register.machine_id,
            last_heartbeat_ms: System.monotonic_time(:millisecond)
          })
          |> schedule_heartbeat_timeout()

        {:push, [text_frame(ack)], state}
      else
        {:error, :workspace_connection_limit_exceeded} = error ->
          :ok = Registry.unregister(register.workspace_id, register.machine_id, self())
          handle_registration_error(error, register, frame, state)

        {:error, reason} ->
          handle_registration_error({:error, reason}, register, frame, state)
      end
    else
      {:error, reason}
      when reason in [:missing_token, :invalid_token, :local_runtime_token_revoked] ->
        Logger.warning("local_relay_register_rejected reason=#{reason}")
        reply = error_frame(Map.get(frame, "correlation_id"), reason, safe_message(reason))
        # WebSock's `{:stop, reason, close_detail, messages, state}` 5-tuple is
        # the only shape that both pushes a frame AND closes. The previous
        # 4-tuple `{:stop, reason, [reply], state}` put the message list where
        # WebSock expects `close_detail :: integer() | {integer(), iodata()}`,
        # so Bandit raised FunctionClauseError on close — masking this typed
        # auth error as a generic StatusInternalError on the helper. 1008 is the
        # WebSocket "policy violation" close code, which fits a rejected token.
        {:stop, {:shutdown, reason}, {1008, safe_message(reason)}, [reply], state}

      {:error, %Ecto.Changeset{} = changeset} ->
        message = LocalRelayRegister.error_message(changeset)

        Logger.warning("local_relay_register_rejected reason=schema_validation message=#{message}")

        reply =
          error_frame(Map.get(frame, "correlation_id"), :local_runner_protocol_error, message)

        {:push, [reply], state}

      {:error, reason} ->
        {:push, [error_frame(Map.get(frame, "correlation_id"), reason, safe_message(reason))], state}
    end
  end

  defp handle_frame("heartbeat", frame, %{registered?: true} = state) do
    with {:ok, heartbeat} <- LocalRelayHeartbeat.validate(frame),
         updates = heartbeat_updates(frame, heartbeat),
         :ok <- Presence.heartbeat(state.workspace_id, state.machine_id, updates) do
      :ok = Registry.heartbeat(state.workspace_id, state.machine_id, updates)

      :ok =
        MachineHeartbeatRecorder.record_heartbeat(
          state.machine_id,
          heartbeat_record_fields(heartbeat)
        )

      reply = %{
        type: "heartbeat_ack",
        protocol: ProtocolExtensions.protocol_version(),
        correlation_id: Map.get(frame, "correlation_id"),
        ts: Map.get(frame, "ts"),
        server_ts: System.system_time(:millisecond)
      }

      state =
        state
        |> Map.put(:last_heartbeat_ms, System.monotonic_time(:millisecond))
        |> schedule_heartbeat_timeout()

      {:push, [text_frame(reply)], state}
    else
      {:error, :not_registered} ->
        reply =
          error_frame(
            Map.get(frame, "correlation_id"),
            :local_runtime_offline,
            "helper is not registered"
          )

        {:push, [reply], state}

      {:error, %Ecto.Changeset{} = changeset} ->
        reply =
          error_frame(
            Map.get(frame, "correlation_id"),
            :local_runner_protocol_error,
            LocalRelayHeartbeat.error_message(changeset)
          )

        {:push, [reply], state}
    end
  end

  defp handle_frame("heartbeat", frame, state) do
    reply =
      error_frame(
        Map.get(frame, "correlation_id"),
        :local_runner_protocol_error,
        "register before heartbeat"
      )

    {:push, [reply], state}
  end

  defp handle_frame(type, frame, %{registered?: true} = state)
       when type in ["progress", "complete", "error", "tool_call_request", "tool_call_result"] do
    correlation_id = Map.get(frame, "correlation_id")
    result = route_relay_frame(type, correlation_id, frame)

    case result do
      :ok ->
        {:ok, state}

      {:error, reason} ->
        {:push, [error_frame(correlation_id, reason, safe_message(reason))], state}
    end
  end

  defp handle_frame("cancel_ack", frame, %{registered?: true} = state) do
    Logger.debug("local_relay_cancel_ack workspace_id=#{state.workspace_id} machine_id=#{state.machine_id} correlation_id=#{Map.get(frame, "correlation_id")} outcome=#{Map.get(frame, "outcome")}")

    correlation_id = Map.get(frame, "correlation_id")

    case route_relay_frame("cancel_ack", correlation_id, frame) do
      :ok -> {:ok, state}
      {:error, reason} -> {:push, [error_frame(correlation_id, reason, safe_message(reason))], state}
    end
  end

  defp handle_frame(type, frame, state)
       when type in [
              "progress",
              "complete",
              "error",
              "tool_call_request",
              "tool_call_result",
              "cancel_ack",
              "cancel",
              "dispatch"
            ] do
    reply =
      error_frame(
        Map.get(frame, "correlation_id"),
        :local_runner_protocol_error,
        "#{type} is not supported before relay dispatch"
      )

    {:push, [reply], state}
  end

  defp handle_frame(_type, frame, state) do
    {:push,
     [
       error_frame(
         Map.get(frame, "correlation_id"),
         :local_runner_protocol_error,
         "unknown frame type"
       )
     ], state}
  end

  defp frame_type(%{"type" => type}) when is_binary(type) and type != "", do: {:ok, type}
  defp frame_type(_frame), do: {:error, "frame type is required"}

  defp bearer_token(headers) when is_map(headers) do
    headers
    |> Map.get("authorization")
    |> parse_bearer()
  end

  defp parse_bearer("Bearer " <> token), do: token
  defp parse_bearer("bearer " <> token), do: token
  defp parse_bearer(_value), do: nil

  defp maybe_put(map, _key, []), do: map
  defp maybe_put(map, _key, empty_map) when empty_map == %{}, do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp heartbeat_updates(frame, heartbeat) do
    %{}
    |> maybe_put_if_present(frame, "runner_kinds", heartbeat.runner_kinds || [])
    |> maybe_put_if_present(
      frame,
      "runners",
      Enum.map(heartbeat.runners || [], &heartbeat_runner_to_map/1)
    )
    |> maybe_put_if_present(frame, "metadata", heartbeat.metadata || %{})
  end

  defp maybe_put_if_present(map, frame, key, value) do
    if Map.has_key?(frame, key) do
      maybe_put(map, String.to_existing_atom(key), value)
    else
      map
    end
  end

  defp heartbeat_runner_to_map(runner) do
    %{
      runner_kind: runner.runner_kind,
      capabilities: runner.capabilities || %{}
    }
    |> maybe_put(:provider, runner.provider)
    |> maybe_put(:model, runner.model)
  end

  defp heartbeat_record_fields(heartbeat) do
    %{helper_version: heartbeat.helper_version}
    |> maybe_put_unless_nil(:advertised_runner_kinds, heartbeat.runner_kinds)
  end

  defp maybe_put_unless_nil(map, _key, nil), do: map
  defp maybe_put_unless_nil(map, key, value), do: Map.put(map, key, value)

  defp registry_registration(registration) do
    runners =
      case registration.runners do
        [] -> registration.runner_kinds
        runners -> runners
      end

    %{
      workspace_id: registration.workspace_id,
      machine_id: registration.machine_id,
      pid: self(),
      runners: runners,
      metadata: registration.metadata
    }
  end

  defp handle_registration_error({:error, reason}, register, frame, state) do
    _ = Presence.offline(register.workspace_id, register.machine_id, self())

    Logger.warning("local_relay_register_rejected reason=#{reason} workspace_id=#{register.workspace_id} machine_id=#{register.machine_id}")

    reply = error_frame(Map.get(frame, "correlation_id"), reason, safe_message(reason))
    {:push, [reply], state}
  end

  defp cleanup_registered_connection(state, opts \\ [])

  defp cleanup_registered_connection(%{workspace_id: workspace_id, machine_id: machine_id}, opts) do
    case Presence.offline(workspace_id, machine_id, self()) do
      :ok ->
        :ok = Registry.unregister(workspace_id, machine_id, self())

        if Keyword.get(opts, :persist_disconnect?, true) do
          :ok = MachineHeartbeatRecorder.record_disconnect(machine_id)
        end

      :stale ->
        :ok
    end
  end

  defp route_relay_frame(_type, nil, _frame), do: {:error, :local_runner_protocol_error}

  defp route_relay_frame("progress", correlation_id, frame),
    do: Registry.progress(correlation_id, frame)

  defp route_relay_frame("complete", correlation_id, frame),
    do: Registry.complete(correlation_id, frame)

  defp route_relay_frame("error", correlation_id, frame),
    do: Registry.error(correlation_id, frame)

  defp route_relay_frame("tool_call_request", correlation_id, frame),
    do: Registry.tool_call_request(correlation_id, frame)

  defp route_relay_frame("tool_call_result", correlation_id, frame),
    do: Registry.tool_call_result(correlation_id, frame)

  defp route_relay_frame("cancel_ack", correlation_id, frame),
    do: Registry.cancel_ack(correlation_id, frame)

  defp error_frame(correlation_id, code, message) do
    text_frame(%{
      type: "error",
      protocol: ProtocolExtensions.protocol_version(),
      correlation_id: correlation_id,
      error: %{code: to_string(code), message: message}
    })
  end

  defp safe_message(:missing_token), do: "local runtime token is required"
  defp safe_message(:invalid_token), do: "local runtime token is invalid"
  defp safe_message(:local_runtime_token_revoked), do: "local runtime token has been revoked"
  defp safe_message(:workspace_mismatch), do: "local runtime token workspace mismatch"
  defp safe_message(:machine_mismatch), do: "local runtime token machine mismatch"
  defp safe_message(:validator_unavailable), do: "local runtime token validator unavailable"

  defp safe_message(:workspace_connection_limit_exceeded),
    do: "local relay workspace connection limit exceeded"

  defp safe_message(reason) when is_binary(reason), do: reason
  defp safe_message(reason), do: to_string(reason)

  defp protocol_error_message(%Jason.DecodeError{}), do: "invalid JSON payload"
  defp protocol_error_message(reason) when is_binary(reason), do: reason
  defp protocol_error_message(_reason), do: "invalid frame"

  # Stamp protocol + schema_version on every outbound frame at the single
  # serialization point. The Go helper's DecodeFrame rejects (and the relay
  # readLoop drops) any inbound frame missing schema_version, so this must cover
  # registration acks, heartbeat acks, and error frames too — not just frames
  # routed through versioned_frame/1.
  defp text_frame(payload) when is_map(payload) do
    {:text, Jason.encode!(ProtocolExtensions.versioned_frame(payload))}
  end

  defp schedule_heartbeat_timeout(state, delay_ms \\ heartbeat_timeout_ms()) do
    cancel_heartbeat_timer(state.heartbeat_timer_ref)

    %{
      state
      | heartbeat_timer_ref: Process.send_after(self(), :local_relay_heartbeat_timeout, delay_ms)
    }
  end

  defp cancel_heartbeat_timer(nil), do: :ok
  defp cancel_heartbeat_timer(ref), do: Process.cancel_timer(ref)

  defp heartbeat_timeout_ms, do: @heartbeat_interval_ms * @heartbeat_timeout_factor
end
