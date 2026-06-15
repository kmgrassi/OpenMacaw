defmodule SymphonyElixirWeb.GatewayControllerTest do
  use SymphonyElixir.TestSupport

  import Plug.Conn
  import Plug.Test

  alias SymphonyElixirWeb.GatewayController

  @service_role_key "service-role-test-key"

  setup do
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", @service_role_key)
    :ok
  end

  test "rejects unauthenticated gateway websocket upgrades" do
    conn =
      :get
      |> conn("/ws?agent_id=agent-1&workspace_id=workspace-1&user_id=user-1")
      |> fetch_query_params()
      |> GatewayController.upgrade(%{})

    assert conn.halted
    assert conn.status == 401
    assert %{"error" => %{"code" => "auth_required", "message" => "Service-role bearer token is required"}} =
             Jason.decode!(conn.resp_body)
  end

  test "accepts authenticated gateway websocket upgrades" do
    conn =
      :get
      |> conn("/ws?agent_id=agent-1&workspace_id=workspace-1&user_id=user-1")
      |> put_req_header("authorization", "Bearer #{@service_role_key}")
      |> fetch_query_params()
      |> GatewayController.upgrade(%{})

    refute conn.halted
    assert conn.status in [nil, 200, 101]
  end
end
