defmodule SymphonyElixirWeb.AgentLiveIoControllerTest do
  use SymphonyElixirWeb.GatewaySocketCase

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]
  import SymphonyElixir.TestSupport, only: [put_app_env: 3, put_system_env: 2]

  @endpoint SymphonyElixirWeb.Endpoint
  @service_role_key "service-role-test-key"
  @agent_id "11111111-1111-4111-8111-111111111111"
  @workspace_id "22222222-2222-4222-8222-222222222222"
  @user_id "33333333-3333-4333-8333-333333333333"

  defmodule BlockingRunner do
    def run(_agent, scope, prompt, run_id, owner_pid) do
      send(Application.fetch_env!(:symphony_elixir, :agent_live_io_test_owner), {
        :blocking_runner_started,
        scope,
        prompt,
        run_id,
        owner_pid
      })

      receive do
        :finish -> :ok
      after
        60_000 -> :ok
      end
    end
  end

  defmodule CodexProfileResolver do
    def resolve_route(_agent_id, _workspace_id) do
      {:ok,
       %{
         "role" => "coding",
         "runner_kind" => "codex",
         "provider" => "openai_codex",
         "model" => "fake-codex",
         "adapter_config" => %{}
       }}
    end
  end

  defmodule ClaudeProfileResolver do
    def resolve_route(_agent_id, _workspace_id) do
      {:ok,
       %{
         "role" => "coding",
         "runner_kind" => "claude_code",
         "provider" => "anthropic",
         "model" => "fake-claude",
         "adapter_config" => %{}
       }}
    end
  end

  defmodule FakeCodexRunner do
    def start_session(config, workspace) do
      send(owner(), {:fake_codex_start_session, config, workspace})
      {:ok, %{runner: "codex", session_id: "fake-codex-session", owner: owner()}}
    end

    def run_turn(session, "interrupt me", _work_item) do
      send(session.owner, :fake_codex_turn_started)

      receive do
        :release -> {:ok, %{"output_text" => "released"}}
      after
        60_000 -> {:ok, %{"output_text" => "late"}}
      end
    end

    def run_turn(session, prompt, work_item) do
      send(session.owner, {:fake_codex_run_turn, prompt, work_item})
      session.on_message.(%{event: :notification, payload: %{"params" => %{"textDelta" => "hello from codex"}}})

      session.on_message.(%{
        event: :tool_call_started,
        payload: %{
          "method" => "item/tool/call",
          "params" => %{
            "tool" => "shell.exec",
            "callId" => "call-1",
            "arguments" => %{"command" => "pwd"}
          }
        }
      })

      session.on_message.(%{
        event: :tool_call_completed,
        payload: %{
          "method" => "item/tool/call",
          "params" => %{
            "tool" => "shell.exec",
            "callId" => "call-1",
            "arguments" => %{"command" => "pwd"}
          }
        },
        result: %{"success" => true, "output" => "/tmp/workspace"}
      })

      {:ok, %{"output_text" => "hello from codex", "model" => "fake-codex", "provider" => "openai_codex"}}
    end

    def send_input(session, input, work_item, opts) do
      session
      |> Map.put(:on_message, Keyword.fetch!(opts, :on_message))
      |> run_turn(input, work_item)
    end

    def interrupt(_session, _opts), do: {:error, :interrupt_not_supported}

    def stop_session(session) do
      send(session.owner, {:fake_codex_stop_session, session.session_id})
      :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :agent_live_io_test_owner)
  end

  defmodule FakeClaudeRunner do
    def start_session(config, workspace) do
      send(owner(), {:fake_claude_start_session, config, workspace})
      {:ok, %{runner: "claude_code", session_id: "fake-claude-session", owner: owner()}}
    end

    def send_input(session, "interrupt me", _work_item, opts) do
      send(session.owner, {:fake_claude_input_started, Keyword.get(opts, :on_message)})

      receive do
        :release -> {:ok, %{"output_text" => "released"}}
      after
        60_000 -> {:ok, %{"output_text" => "late"}}
      end
    end

    def send_input(session, prompt, work_item, opts) do
      send(session.owner, {:fake_claude_send_input, prompt, work_item})
      Keyword.fetch!(opts, :on_message).(%{event: :notification, payload: %{"params" => %{"textDelta" => "hello from claude"}}})
      {:ok, %{"output_text" => "hello from claude", "model" => "fake-claude", "provider" => "anthropic"}}
    end

    def interrupt(session, _opts) do
      send(session.owner, {:fake_claude_interrupt, session.session_id})
      :ok
    end

    def stop_session(session) do
      send(session.owner, {:fake_claude_stop_session, session.session_id})
      :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :agent_live_io_test_owner)
  end

  setup do
    start_test_endpoint()
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", @service_role_key)
    :ok
  end

  test "POST /api/v1/agents/:id/input starts a live I/O run through the runtime owner" do
    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "Ping",
        "session_key" => default_session_key(),
        "metadata" => %{"source" => "test"}
      })

    assert %{
             "accepted" => true,
             "agentId" => @agent_id,
             "workspaceId" => @workspace_id,
             "sessionKey" => session_key,
             "turnId" => run_id
           } = json_response(conn, 202)

    assert session_key == default_session_key()
    assert is_binary(run_id)
    assert_received {:message_log_user_message, %{user_id: @user_id}, "thread-1", "Ping", _opts}

    eventually(fn ->
      messages = SessionStore.get_messages(default_session_key())

      assert Enum.any?(messages, &(&1["role"] == "assistant" and &1["content"] == "hello Stub Agent"))
    end)
  end

  test "Codex runner agents route through AgentIO and stream public contract events" do
    put_app_env(:symphony_elixir, :agent_live_io_profile_resolver, CodexProfileResolver)
    put_app_env(:symphony_elixir, :agent_live_io_coding_runner, FakeCodexRunner)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    session_key = default_session_key() <> ":codex"
    scope = %{agent_id: @agent_id, workspace_id: @workspace_id, user_id: @user_id, session_key: session_key}

    assert :ok = SymphonyElixir.AgentLiveIo.subscribe(scope)

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "Ping",
        "session_key" => session_key
      })

    assert %{
             "accepted" => true,
             "agentId" => @agent_id,
             "workspaceId" => @workspace_id,
             "sessionKey" => ^session_key,
             "turnId" => turn_id
           } = json_response(conn, 202)

    assert_receive {:fake_codex_start_session, %{"model" => "fake-codex", "model_provider" => "openai_codex"}, workspace}
    assert is_binary(workspace)
    assert_receive {:fake_codex_run_turn, "Ping", %{id: ^session_key, runner_type: "codex"}}

    assert_receive {:agent_io_event, ^session_key, %{event: :turn_started, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_started", "agentId" => @agent_id, "workspaceId" => @workspace_id} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :notification, turn_id: ^turn_id} = event}

    assert %{"type" => "text_delta", "payload" => %{"text" => "hello from codex"}} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :tool_call_started, turn_id: ^turn_id} = event}

    assert %{
             "type" => "tool_activity",
             "payload" => %{
               "vendor" => "codex",
               "toolName" => "shell.exec",
               "toolCallId" => "call-1",
               "inputSummary" => "{\"command\":\"pwd\"}",
               "phase" => "request",
               "decision" => "allowed",
               "rawEvent" => "tool_call_started"
             }
           } = SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :tool_call_completed, turn_id: ^turn_id} = event}

    assert %{
             "type" => "tool_activity",
             "payload" => %{
               "toolName" => "shell.exec",
               "phase" => "result",
               "success" => true,
               "outputSummary" => "/tmp/workspace"
             }
           } = SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :turn_completed, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_completed", "turnId" => ^turn_id} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    refute_received {:message_log_user_message, _, _, "Ping", _}
  end

  test "Codex runner interrupts become turn_interrupted stream events" do
    put_app_env(:symphony_elixir, :agent_live_io_profile_resolver, CodexProfileResolver)
    put_app_env(:symphony_elixir, :agent_live_io_coding_runner, FakeCodexRunner)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    session_key = default_session_key() <> ":codex-interrupt"
    scope = %{agent_id: @agent_id, workspace_id: @workspace_id, user_id: @user_id, session_key: session_key}

    assert :ok = SymphonyElixir.AgentLiveIo.subscribe(scope)

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "interrupt me",
        "session_key" => session_key
      })

    assert %{"turnId" => turn_id} = json_response(conn, 202)
    assert_receive :fake_codex_turn_started

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/interrupt", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "session_key" => session_key
      })

    assert %{"interrupted" => true, "sessionKey" => ^session_key} = json_response(conn, 202)
    assert_receive {:fake_codex_stop_session, "fake-codex-session"}
    assert_receive {:agent_io_event, ^session_key, %{event: :turn_ended_with_error, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_interrupted", "turnId" => ^turn_id, "payload" => %{"reason" => "interrupted"}} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)
  end

  test "Claude Code runner agents route through AgentIO and stream public contract events" do
    put_app_env(:symphony_elixir, :agent_live_io_profile_resolver, ClaudeProfileResolver)
    put_app_env(:symphony_elixir, :agent_live_io_coding_runner, FakeClaudeRunner)
    put_app_env(:symphony_elixir, :agent_live_io_claude_code_enabled, true)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    session_key = default_session_key() <> ":claude"
    scope = %{agent_id: @agent_id, workspace_id: @workspace_id, user_id: @user_id, session_key: session_key}

    assert :ok = SymphonyElixir.AgentLiveIo.subscribe(scope)

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "Ping",
        "session_key" => session_key
      })

    assert %{"accepted" => true, "sessionKey" => ^session_key, "turnId" => turn_id} = json_response(conn, 202)

    assert_receive {:fake_claude_start_session, %{"model" => "fake-claude", "model_provider" => "anthropic"}, workspace}
    assert is_binary(workspace)
    assert_receive {:fake_claude_send_input, "Ping", %{id: ^session_key, runner_type: "claude_code"}}

    assert_receive {:agent_io_event, ^session_key, %{event: :turn_started, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_started", "agentId" => @agent_id, "workspaceId" => @workspace_id} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :notification, turn_id: ^turn_id} = event}

    assert %{"type" => "text_delta", "payload" => %{"text" => "hello from claude"}} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    assert_receive {:agent_io_event, ^session_key, %{event: :turn_completed, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_completed", "turnId" => ^turn_id} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)

    refute_received {:message_log_user_message, _, _, "Ping", _}
  end

  test "Claude Code runner interrupts use the coding runner callback" do
    put_app_env(:symphony_elixir, :agent_live_io_profile_resolver, ClaudeProfileResolver)
    put_app_env(:symphony_elixir, :agent_live_io_coding_runner, FakeClaudeRunner)
    put_app_env(:symphony_elixir, :agent_live_io_claude_code_enabled, true)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    session_key = default_session_key() <> ":claude-interrupt"
    scope = %{agent_id: @agent_id, workspace_id: @workspace_id, user_id: @user_id, session_key: session_key}

    assert :ok = SymphonyElixir.AgentLiveIo.subscribe(scope)

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "interrupt me",
        "session_key" => session_key
      })

    assert %{"turnId" => turn_id} = json_response(conn, 202)
    assert_receive {:fake_claude_input_started, on_message}
    assert is_function(on_message, 1)

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/interrupt", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "session_key" => session_key
      })

    assert %{"interrupted" => true, "sessionKey" => ^session_key} = json_response(conn, 202)
    assert_receive {:fake_claude_interrupt, "fake-claude-session"}
    assert_receive {:fake_claude_stop_session, "fake-claude-session"}
    assert_receive {:agent_io_event, ^session_key, %{event: :turn_ended_with_error, turn_id: ^turn_id} = event}

    assert %{"type" => "turn_interrupted", "turnId" => ^turn_id, "payload" => %{"reason" => "interrupted"}} =
             SymphonyElixir.AgentLiveIo.stream_event(scope, event)
  end

  test "Claude Code runner agents stay on ChatGateway unless the persistent bridge route is enabled" do
    put_app_env(:symphony_elixir, :agent_live_io_profile_resolver, ClaudeProfileResolver)
    put_app_env(:symphony_elixir, :agent_live_io_coding_runner, FakeClaudeRunner)
    put_app_env(:symphony_elixir, :agent_live_io_claude_code_enabled, false)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "Ping",
        "session_key" => default_session_key()
      })

    assert %{"accepted" => true} = json_response(conn, 202)
    assert_received {:message_log_user_message, %{user_id: @user_id}, "thread-1", "Ping", _opts}
    refute_received {:fake_claude_start_session, _config, _workspace}
  end

  test "POST /api/v1/agents/:id/interrupt aborts the active live I/O run" do
    put_app_env(:symphony_elixir, :gateway_chat_runner, BlockingRunner)
    put_app_env(:symphony_elixir, :agent_live_io_test_owner, self())

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/input", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "message" => "Wait",
        "session_key" => default_session_key()
      })

    assert %{"turnId" => run_id} = json_response(conn, 202)
    assert_receive {:blocking_runner_started, %{session_key: session_key}, "Wait", ^run_id, owner_pid}
    assert owner_pid == Process.whereis(SymphonyElixir.AgentLiveIo)
    assert session_key == default_session_key()

    conn =
      authed_conn()
      |> post("/api/v1/agents/#{@agent_id}/interrupt", %{
        "workspace_id" => @workspace_id,
        "user_id" => @user_id,
        "session_key" => default_session_key()
      })

    assert %{
             "interrupted" => true,
             "agentId" => @agent_id,
             "workspaceId" => @workspace_id,
             "sessionKey" => ^session_key
           } = json_response(conn, 202)

    assert {:error, :run_not_found} = SymphonyElixir.Gateway.SessionStore.abort_run(default_session_key(), run_id)
  end

  test "rejects unauthenticated live I/O requests" do
    conn = post(build_conn(), "/api/v1/agents/#{@agent_id}/input", %{})

    assert %{"error" => %{"code" => "auth_required"}} = json_response(conn, 401)
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64))

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end

  defp authed_conn do
    build_conn()
    |> put_req_header("authorization", "Bearer #{@service_role_key}")
  end

  defp eventually(fun, attempts \\ 20)

  defp eventually(fun, attempts) when attempts > 0 do
    fun.()
  rescue
    error ->
      if attempts == 1 do
        reraise error, __STACKTRACE__
      else
        Process.sleep(25)
        eventually(fun, attempts - 1)
      end
  end
end
