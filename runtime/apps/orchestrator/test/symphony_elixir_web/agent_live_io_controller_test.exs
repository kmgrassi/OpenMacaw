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
