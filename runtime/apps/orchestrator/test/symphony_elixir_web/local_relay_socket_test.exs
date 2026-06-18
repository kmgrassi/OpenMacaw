defmodule SymphonyElixirWeb.LocalRelaySocketTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.{Presence, Registry, TokenValidator}
  alias SymphonyElixirWeb.LocalRelaySocket

  defmodule CaptureHeartbeatRecorder do
    @behaviour SymphonyElixir.LocalRelay.MachineHeartbeatRecorder

    @impl true
    def record_register(machine_id, fields) do
      send(self(), {:record_register, machine_id, fields})
      :ok
    end

    @impl true
    def record_heartbeat(machine_id, fields) do
      send(self(), {:record_heartbeat, machine_id, fields})
      :ok
    end

    @impl true
    def record_disconnect(machine_id) do
      send(self(), {:record_disconnect, machine_id})
      :ok
    end
  end

  @workspace_id "22222222-2222-4222-8222-222222222222"
  @machine_id "machine-local-1"
  @token "local-runtime-token"

  setup do
    original_hashes = Application.get_env(:symphony_elixir, :local_relay_token_hashes)
    original_validator = Application.get_env(:symphony_elixir, :local_relay_token_validator)

    original_recorder =
      Application.get_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder)

    Application.put_env(
      :symphony_elixir,
      :local_relay_machine_heartbeat_recorder,
      CaptureHeartbeatRecorder
    )

    ensure_presence!()
    Registry.reset!()

    Application.put_env(:symphony_elixir, :local_relay_token_hashes, %{
      TokenValidator.hash_token(@token) => %{
        workspace_id: @workspace_id,
        machine_id: @machine_id,
        token_id: "token-1",
        revoked?: false
      },
      TokenValidator.hash_token("revoked-token") => %{
        workspace_id: @workspace_id,
        machine_id: "revoked-machine",
        token_id: "token-revoked",
        revoked?: true
      }
    })

    on_exit(fn ->
      if original_hashes,
        do: Application.put_env(:symphony_elixir, :local_relay_token_hashes, original_hashes),
        else: Application.delete_env(:symphony_elixir, :local_relay_token_hashes)

      if original_validator,
        do: Application.put_env(:symphony_elixir, :local_relay_token_validator, original_validator),
        else: Application.delete_env(:symphony_elixir, :local_relay_token_validator)

      if original_recorder,
        do:
          Application.put_env(
            :symphony_elixir,
            :local_relay_machine_heartbeat_recorder,
            original_recorder
          ),
        else: Application.delete_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder)

      Registry.reset!()
    end)

    :ok
  end

  test "register authenticates helper and records advertised runner state" do
    {:ok, state} = init_socket()

    {:push, [{:text, reply_json}], state} =
      LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    reply = Jason.decode!(reply_json)

    assert reply["type"] == "registered"
    assert reply["protocol"] == 1
    # The register ack is pushed via text_frame (not versioned_frame), so it
    # must still carry schema_version or the helper drops it.
    assert reply["schema_version"] == "1"
    assert reply["heartbeat_interval_ms"] == 30_000
    assert state.registered?

    assert {:ok, presence} = Presence.get(@workspace_id, @machine_id)
    assert presence.token_id == "token-1"
    assert presence.runner_kinds == ["openai_compatible"]
    assert [%{runner_kind: "openai_compatible", provider: "ollama"}] = presence.runners

    assert {:ok, helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert helper.machine_id == @machine_id
  end

  test "register identifies the machine from the token, not the frame machine_id" do
    {:ok, state} = init_socket()
    # The helper presents a display-name-style machine_id that differs from the
    # token's bound machine_id. Pre-fix this was rejected with machine_mismatch;
    # now identity comes from the token.
    frame = register_frame(%{machine_id: "qwen3-coder:30b@localhost:11434"})

    {:push, [{:text, reply_json}], state} =
      LocalRelaySocket.handle_in({encode(frame), []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["type"] == "registered"
    # Ack, socket state, presence, registry, and heartbeat record all use the
    # token's machine id — never the frame's.
    assert reply["machine_id"] == @machine_id
    assert state.machine_id == @machine_id
    assert {:ok, _presence} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :not_found} = Presence.get(@workspace_id, "qwen3-coder:30b@localhost:11434")
    assert {:ok, helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert helper.machine_id == @machine_id
    assert_received {:record_register, @machine_id, _fields}
  end

  test "heartbeat refreshes online state after registration" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)
    {:ok, before_heartbeat} = Presence.get(@workspace_id, @machine_id)

    heartbeat = %{
      type: "heartbeat",
      correlation_id: "hb-1",
      ts: 123,
      metadata: %{"battery" => "ac"}
    }

    {:push, [{:text, reply_json}], _state} =
      LocalRelaySocket.handle_in({encode(heartbeat), []}, state)

    reply = Jason.decode!(reply_json)

    assert reply["type"] == "heartbeat_ack"
    assert reply["correlation_id"] == "hb-1"
    assert state.registered?

    assert {:ok, after_heartbeat} = Presence.get(@workspace_id, @machine_id)
    assert after_heartbeat.last_seen_ms >= before_heartbeat.last_seen_ms
    assert after_heartbeat.metadata == %{"battery" => "ac"}

    assert {:ok, helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert helper.metadata == %{"battery" => "ac"}
  end

  test "cancel_ack after registration is accepted and ignored" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    frame = %{
      type: "cancel_ack",
      correlation_id: "dispatch-1",
      outcome: "cancelled"
    }

    assert {:ok, ^state} = LocalRelaySocket.handle_in({encode(frame), []}, state)
    assert {:ok, helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert helper.machine_id == @machine_id
  end

  test "structured error detail is routed unchanged" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    correlation_id = "dispatch-with-detail"

    assert {:ok, ^correlation_id, _helper} =
             Registry.dispatch(
               @workspace_id,
               "openai_compatible",
               %{"type" => "dispatch", "correlation_id" => correlation_id},
               caller: self()
             )

    frame = %{
      type: "error",
      correlation_id: correlation_id,
      code: "endpoint_unreachable",
      message: "local endpoint refused connection",
      retryable: true,
      detail: %{
        "dial_error" => "connect: connection refused",
        "endpoint" => "http://127.0.0.1:11434/v1/chat/completions"
      }
    }

    assert {:ok, _state} = LocalRelaySocket.handle_in({encode(frame), []}, state)

    assert_receive {:local_relay_error, ^correlation_id, routed}
    assert routed["detail"]["dial_error"] == "connect: connection refused"
    assert routed["detail"]["endpoint"] == "http://127.0.0.1:11434/v1/chat/completions"
  end

  test "missed heartbeat closes socket and removes relay presence" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    stale_state = %{state | last_heartbeat_ms: System.monotonic_time(:millisecond) - 61_000}

    assert {:stop, {:shutdown, :heartbeat_timeout}, stopped_state} =
             LocalRelaySocket.handle_info(:local_relay_heartbeat_timeout, stale_state)

    refute stopped_state.registered?
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :local_runtime_offline} = Registry.lookup(@workspace_id, "openai_compatible")
  end

  test "evicted socket closes and removes only its own relay presence" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    assert {:stop, {:shutdown, :duplicate_token}, stopped_state} =
             LocalRelaySocket.handle_info({:local_relay_evicted, :duplicate_token}, state)

    refute stopped_state.registered?
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :local_runtime_offline} = Registry.lookup(@workspace_id, "openai_compatible")
  end

  test "server-draining eviction preserves persisted heartbeat for reconnect wait" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)
    assert_received {:record_register, @machine_id, _fields}

    assert {:stop, {:shutdown, :server_draining}, stopped_state} =
             LocalRelaySocket.handle_info({:local_relay_evicted, :server_draining}, state)

    refute stopped_state.registered?
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :local_runtime_offline} = Registry.lookup(@workspace_id, "openai_compatible")
    refute_received {:record_disconnect, @machine_id}
  end

  test "invalid tokens fail registration and do not mark helper online" do
    {:ok, state} = init_socket()
    frame = register_frame(%{auth: %{token: "wrong-token"}})

    assert {:stop, {:shutdown, :invalid_token}, {1008, _close_reason}, [{:text, reply_json}], ^state} =
             LocalRelaySocket.handle_in({encode(frame), []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["type"] == "error"
    assert reply["error"]["code"] == "invalid_token"
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
  end

  test "register rejects non-list runner_kinds instead of silently clearing advertised capabilities" do
    {:ok, state} = init_socket()
    frame = register_frame(%{runner_kinds: "openai_compatible"})

    assert {:push, [{:text, reply_json}], ^state} =
             LocalRelaySocket.handle_in({encode(frame), []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["type"] == "error"
    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] =~ "runner_kinds"
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
  end

  test "revoked tokens fail registration with typed local relay error" do
    {:ok, state} = init_socket()

    frame =
      register_frame(%{
        machine_id: "revoked-machine",
        auth: %{token: "revoked-token"}
      })

    assert {:stop, {:shutdown, :local_runtime_token_revoked}, {1008, _close_reason}, [{:text, reply_json}], ^state} =
             LocalRelaySocket.handle_in({encode(frame), []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["error"]["code"] == "local_runtime_token_revoked"
    assert {:error, :not_found} = Presence.get(@workspace_id, "revoked-machine")
  end

  test "heartbeat before register is rejected as protocol error" do
    {:ok, state} = init_socket()

    {:push, [{:text, reply_json}], ^state} =
      LocalRelaySocket.handle_in(
        {encode(%{type: "heartbeat", correlation_id: "hb-early"}), []},
        state
      )

    reply = Jason.decode!(reply_json)
    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] == "register before heartbeat"
  end

  test "cancel ack before register is rejected as protocol error" do
    {:ok, state} = init_socket()

    {:push, [{:text, reply_json}], ^state} =
      LocalRelaySocket.handle_in(
        {encode(%{type: "cancel_ack", correlation_id: "cancel-early", outcome: "cancelled"}), []},
        state
      )

    reply = Jason.decode!(reply_json)
    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] == "cancel_ack is not supported before relay dispatch"
  end

  test "malformed JSON is rejected with an encodable protocol error" do
    {:ok, state} = init_socket()

    {:push, [{:text, reply_json}], ^state} = LocalRelaySocket.handle_in({"{", []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] == "invalid JSON payload"
  end

  test "terminate removes online presence" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    assert {:ok, _presence} = Presence.get(@workspace_id, @machine_id)
    assert {:ok, _helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert :ok = LocalRelaySocket.terminate(:normal, state)
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :local_runtime_offline} = Registry.lookup(@workspace_id, "openai_compatible")
  end

  test "stale terminate does not unregister or record disconnect for a newer reconnect" do
    {:ok, stale_state} = init_socket()

    {:push, [_reply], stale_state} =
      LocalRelaySocket.handle_in({encode(register_frame()), []}, stale_state)

    assert_received {:record_register, @machine_id, _fields}

    new_pid = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(new_pid, :kill) end)

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               connection_pid: new_pid,
               runner_kinds: ["openai_compatible"]
             })

    {:ok, _helper} =
      Registry.register(%{
        workspace_id: @workspace_id,
        machine_id: @machine_id,
        pid: new_pid,
        runners: ["openai_compatible"]
      })

    assert :ok = LocalRelaySocket.terminate(:normal, stale_state)

    assert {:ok, helper} = Registry.lookup(@workspace_id, "openai_compatible")
    assert helper.machine_id == @machine_id
    assert {:ok, %{connection_pid: ^new_pid}} = Presence.get(@workspace_id, @machine_id)
    refute_received {:record_disconnect, @machine_id}
  end

  test "registry registration failure keeps an existing healthy connection online" do
    existing_pid = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(existing_pid, :kill) end)

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               token_id: "token-1",
               token_hash: TokenValidator.hash_token(@token),
               connection_pid: existing_pid,
               runner_kinds: ["openai_compatible"]
             })

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               pid: existing_pid,
               runners: ["openai_compatible"]
             })

    {:ok, state} = init_socket()
    frame = register_frame(%{runner_kinds: [], runners: []})

    assert {:push, [{:text, reply_json}], ^state} =
             LocalRelaySocket.handle_in({encode(frame), []}, state)

    reply = Jason.decode!(reply_json)
    assert reply["type"] == "error"
    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert {:ok, %{connection_pid: ^existing_pid}} = Presence.get(@workspace_id, @machine_id)
    assert {:ok, %{machine_id: @machine_id}} = Registry.lookup(@workspace_id, "openai_compatible")
  end

  test "bridges registry dispatch, tool execution, and helper result frames over the socket" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)
    assert_received {:record_register, @machine_id, _fields}

    dispatch = %{
      "type" => "dispatch",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "prompt" => "read"
    }

    assert {:ok, "corr-1", _helper} =
             Registry.dispatch(@workspace_id, "openai_compatible", dispatch, caller: self())

    assert_receive {:local_relay_dispatch, ^dispatch}

    assert {:push, [{:text, dispatch_json}], ^state} =
             LocalRelaySocket.handle_info({:local_relay_dispatch, dispatch}, state)

    # schema_version is required by the Go helper's DecodeFrame; without it the
    # helper rejects (and silently drops) every frame the orchestrator pushes.
    assert %{
             "type" => "dispatch",
             "protocol" => 1,
             "schema_version" => "1",
             "correlation_id" => "corr-1"
           } =
             Jason.decode!(dispatch_json)

    tool_request = %{
      "type" => "tool_call_request",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "tool_calls" => [
        %{"id" => "call-1", "name" => "shell.exec", "arguments" => %{"argv" => ["pwd"]}}
      ]
    }

    assert {:ok, ^state} = LocalRelaySocket.handle_in({encode(tool_request), []}, state)
    assert_receive {:local_relay_tool_call_request, "corr-1", ^tool_request}

    execution_request = %{
      "type" => "tool_execution_request",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "tool_call_id" => "call-1",
      "name" => "shell.exec",
      "arguments" => %{"argv" => ["pwd"]}
    }

    assert :ok = Registry.send_tool_execution_request("corr-1", execution_request)
    assert_receive {:local_relay_tool_execution_request, ^execution_request}

    assert {:push, [{:text, execution_json}], ^state} =
             LocalRelaySocket.handle_info(
               {:local_relay_tool_execution_request, execution_request},
               state
             )

    assert %{"type" => "tool_execution_request", "protocol" => 1, "tool_call_id" => "call-1"} =
             Jason.decode!(execution_json)

    tool_result = %{
      "type" => "tool_call_result",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "tool_call_id" => "call-1",
      "success" => true,
      "output" => "/workspace"
    }

    assert {:ok, ^state} = LocalRelaySocket.handle_in({encode(tool_result), []}, state)
    assert_receive {:local_relay_tool_call_result, "corr-1", ^tool_result}

    follow_up = %{
      "type" => "dispatch",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "tool_outputs" => []
    }

    assert :ok = Registry.send_frame("corr-1", follow_up)
    assert_receive {:local_relay_frame, ^follow_up}

    complete = %{
      "type" => "complete",
      "protocol" => 1,
      "correlation_id" => "corr-1",
      "output_text" => "done"
    }

    assert {:ok, ^state} = LocalRelaySocket.handle_in({encode(complete), []}, state)
    assert_receive {:local_relay_complete, "corr-1", ^complete}
  end

  test "routes cancel_ack frames without treating them as unknown" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    dispatch = %{
      "type" => "dispatch",
      "protocol" => 1,
      "correlation_id" => "corr-cancel",
      "prompt" => "cancel"
    }

    assert {:ok, "corr-cancel", _helper} = Registry.dispatch(@workspace_id, "openai_compatible", dispatch, caller: self())
    assert_receive {:local_relay_dispatch, ^dispatch}

    cancel_ack = %{
      "type" => "cancel_ack",
      "protocol" => 1,
      "correlation_id" => "corr-cancel",
      "outcome" => "canceled"
    }

    assert {:ok, ^state} = LocalRelaySocket.handle_in({encode(cancel_ack), []}, state)
    assert_receive {:local_relay_cancel_ack, "corr-cancel", ^cancel_ack}
  end

  test "register writes machine presence with helper_version + advertised runner kinds" do
    {:ok, state} = init_socket()

    {:push, [_reply], _state} =
      LocalRelaySocket.handle_in(
        {encode(register_frame(%{helper_version: "0.4.2"})), []},
        state
      )

    assert_received {:record_register, @machine_id, fields}
    assert fields.helper_version == "0.4.2"
    assert fields.advertised_runner_kinds == ["openai_compatible"]
  end

  test "register accepts a frame without helper_version and records nil" do
    {:ok, state} = init_socket()

    {:push, [_reply], _state} =
      LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    assert_received {:record_register, @machine_id, fields}
    assert is_nil(fields.helper_version)
    assert fields.advertised_runner_kinds == ["openai_compatible"]
  end

  test "heartbeat writes machine presence with current advertised runner kinds" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    heartbeat = %{
      type: "heartbeat",
      correlation_id: "hb-1",
      ts: 123,
      helper_version: "0.4.3",
      runner_kinds: ["openai_compatible", "openclaw"]
    }

    {:push, [_reply], _state} = LocalRelaySocket.handle_in({encode(heartbeat), []}, state)

    assert_received {:record_heartbeat, @machine_id, fields}
    assert fields.helper_version == "0.4.3"
    assert fields.advertised_runner_kinds == ["openai_compatible", "openclaw"]
  end

  test "heartbeat without runner_kinds leaves persisted advertised runner kinds unchanged" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    heartbeat = %{
      type: "heartbeat",
      correlation_id: "hb-1",
      ts: 123,
      helper_version: "0.4.3"
    }

    {:push, [_reply], _state} = LocalRelaySocket.handle_in({encode(heartbeat), []}, state)

    assert_received {:record_heartbeat, @machine_id, fields}
    assert fields.helper_version == "0.4.3"
    refute Map.has_key?(fields, :advertised_runner_kinds)
  end

  test "heartbeat rejects non-list runner_kinds instead of silently clearing capabilities" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    heartbeat = %{
      type: "heartbeat",
      correlation_id: "hb-bad-kinds",
      runner_kinds: "openai_compatible"
    }

    {:push, [{:text, reply_json}], _state} =
      LocalRelaySocket.handle_in({encode(heartbeat), []}, state)

    reply = Jason.decode!(reply_json)

    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] =~ "runner_kinds"
    assert {:ok, presence} = Presence.get(@workspace_id, @machine_id)
    assert presence.runner_kinds == ["openai_compatible"]
    refute_received {:record_heartbeat, @machine_id, _fields}
  end

  test "heartbeat rejects malformed runners and metadata instead of mutating presence" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)

    heartbeat = %{
      type: "heartbeat",
      correlation_id: "hb-bad-runners",
      metadata: "battery",
      runners: [%{runner_kind: "", provider: "ollama"}]
    }

    {:push, [{:text, reply_json}], _state} =
      LocalRelaySocket.handle_in({encode(heartbeat), []}, state)

    reply = Jason.decode!(reply_json)

    assert reply["error"]["code"] == "local_runner_protocol_error"
    assert reply["error"]["message"] =~ "metadata"
    assert reply["error"]["message"] =~ "runners"
    assert {:ok, presence} = Presence.get(@workspace_id, @machine_id)
    assert [%{runner_kind: "openai_compatible", provider: "ollama"}] = presence.runners
    refute_received {:record_heartbeat, @machine_id, _fields}
  end

  test "cleanup on terminate records disconnect for the machine" do
    {:ok, state} = init_socket()
    {:push, [_reply], state} = LocalRelaySocket.handle_in({encode(register_frame()), []}, state)
    # drain the register write so the disconnect assertion isn't ambiguous
    assert_received {:record_register, @machine_id, _fields}

    assert :ok = LocalRelaySocket.terminate(:normal, state)
    assert_received {:record_disconnect, @machine_id}
  end

  defp init_socket do
    LocalRelaySocket.init(%{
      query_params: %{},
      request_headers: %{},
      peer_data: {127, 0, 0, 1}
    })
  end

  defp register_frame(overrides \\ %{}) do
    Map.merge(
      %{
        type: "register",
        workspace_id: @workspace_id,
        machine_id: @machine_id,
        auth: %{token: @token},
        runner_kinds: ["openai_compatible"],
        runners: [
          %{
            runner_kind: "openai_compatible",
            provider: "ollama",
            model: "qwen2.5-coder:latest",
            capabilities: %{
              streaming: true,
              tool_calls: false,
              structured_output: "best_effort",
              json_mode: true,
              context_window: 32_768
            }
          }
        ]
      },
      overrides
    )
  end

  defp encode(frame), do: Jason.encode!(frame)

  defp ensure_presence! do
    case Process.whereis(Presence) do
      nil ->
        start_supervised!(Presence)

      pid when is_pid(pid) ->
        Enum.each(Presence.list(), fn presence ->
          Presence.offline(presence.workspace_id, presence.machine_id)
        end)
    end
  end
end
