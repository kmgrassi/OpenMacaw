defmodule SymphonyElixir.WorkerBridge.ClientTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.WorkerBridge.Client

  setup do
    put_system_env("LAUNCHER_BASE_URL", "http://launcher.test")
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    put_app_env(:symphony_elixir, :worker_bridge_client_req_options, plug: {Req.Test, __MODULE__})
    :ok
  end

  test "starts sessions through the launcher worker bridge endpoint" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:request, conn.method, conn.request_path})

      assert conn.method == "POST"
      assert conn.request_path == "/worker-bridge/sessions"
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer service-role-test-key"]
      assert Plug.Conn.get_req_header(conn, "content-type") == ["application/json"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      assert Jason.decode!(body)["kind"] == "codex"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!(%{"data" => %{"id" => "worker-1", "status" => "running"}}))
    end)

    assert {:ok, %{"id" => "worker-1", "status" => "running"}} =
             Client.start_session(%{"kind" => "codex", "cwd" => "/tmp/workspace"})

    assert_received {:request, "POST", "/worker-bridge/sessions"}
  end

  test "heartbeats and stops sessions through launcher endpoints" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:request, conn.method, conn.request_path})
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer service-role-test-key"]

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(%{"data" => %{"id" => "worker-1", "status" => "running"}}))
    end)

    assert {:ok, %{"id" => "worker-1"}} = Client.heartbeat_session("worker-1")
    assert {:ok, %{"id" => "worker-1"}} = Client.stop_session("worker-1")

    assert_received {:request, "POST", "/worker-bridge/sessions/worker-1/heartbeat"}
    assert_received {:request, "DELETE", "/worker-bridge/sessions/worker-1"}
  end

  test "maps missing launcher sessions to not_found" do
    Req.Test.stub(__MODULE__, fn conn ->
      Plug.Conn.send_resp(conn, 404, "not found")
    end)

    assert {:error, :not_found} = Client.stop_session("missing")
  end
end
