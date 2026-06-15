defmodule SymphonyElixir.WorkspaceSettings.RepositoryTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.WorkspaceSettings.Repository

  setup do
    put_app_envs(:symphony_elixir,
      workspace_settings_repository: [
        endpoint: "https://test.supabase.co",
        api_key: "secret"
      ],
      workspace_settings_repository_req_options: [plug: {Req.Test, __MODULE__}]
    )

    :ok
  end

  test "read returns default settings when no row exists" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["workspace_id"] == "eq.workspace-1"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:ok,
            %{
              "workspace_id" => "workspace-1",
              "learning_enabled" => false,
              "tracker_kind" => "database",
              "tracker_credential_id" => nil,
              "max_concurrent_agents" => 10,
              "exists" => false
            }} = Repository.read("workspace-1")
  end

  test "learning_enabled? defaults to false when no row exists" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["select"] == "learning_enabled"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:ok, false} = Repository.learning_enabled?("workspace-1")
  end

  test "max_concurrent_agents returns the default when no row exists" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["select"] == "max_concurrent_agents"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:ok, 10} = Repository.max_concurrent_agents("workspace-1")
  end

  test "max_concurrent_agents rejects malformed and out-of-range rows" do
    Req.Test.stub(__MODULE__, fn conn ->
      value =
        case URI.decode_query(conn.query_string)["workspace_id"] do
          "eq.low" -> 0
          "eq.high" -> 51
          "eq.malformed" -> "2"
        end

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"max_concurrent_agents" => value}]))
    end)

    assert {:error, {:invalid_max_concurrent_agents, 0, :below_minimum, 1}} =
             Repository.max_concurrent_agents("low")

    assert {:error, {:invalid_max_concurrent_agents, 51, :above_maximum, 50}} =
             Repository.max_concurrent_agents("high")

    assert {:error, {:invalid_max_concurrent_agents, "2", :not_integer}} =
             Repository.max_concurrent_agents("malformed")
  end

  test "upsert writes supported settings fields and returns the row" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["on_conflict"] == "workspace_id"

      prefer = Plug.Conn.get_req_header(conn, "prefer") |> List.first()
      assert prefer =~ "resolution=merge-duplicates"
      assert prefer =~ "return=representation"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload["workspace_id"] == "workspace-1"
      assert payload["learning_enabled"] == false
      assert payload["tracker_kind"] == "memory"
      assert payload["tracker_credential_id"] == nil
      assert payload["max_concurrent_agents"] == 12
      assert payload["max_concurrent_agents"] == 12
      assert payload["updated_by_user_id"] == "user-1"
      assert is_binary(payload["updated_at"])
      refute Map.has_key?(payload, "ignored")

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([payload]))
    end)

    assert {:ok,
            %{
              "workspace_id" => "workspace-1",
              "learning_enabled" => false,
              "tracker_kind" => "memory",
              "tracker_credential_id" => nil,
              "max_concurrent_agents" => 12,
              "exists" => true
            }} =
             Repository.upsert(
               "workspace-1",
               %{
                 "learning_enabled" => false,
                 "tracker_kind" => "memory",
                 "tracker_credential_id" => nil,
                 "max_concurrent_agents" => 12,
                 "ignored" => true
               },
               updated_by_user_id: "user-1"
             )
  end

  test "upsert rejects invalid max_concurrent_agents values before writing" do
    assert {:error, {:invalid_workspace_settings_fields, %{"max_concurrent_agents" => "must be greater than or equal to 1"}}} =
             Repository.upsert("workspace-1", %{"max_concurrent_agents" => 0})

    assert {:error, {:invalid_workspace_settings_fields, %{"max_concurrent_agents" => "must be less than or equal to 50"}}} =
             Repository.upsert("workspace-1", %{"max_concurrent_agents" => 51})

    assert {:error, {:invalid_workspace_settings_fields, %{"max_concurrent_agents" => "must be an integer"}}} =
             Repository.upsert("workspace-1", %{"max_concurrent_agents" => "10"})
  end

  test "upsert truncates updated_at to whole seconds" do
    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert {:ok, datetime, 0} = DateTime.from_iso8601(payload["updated_at"])
      assert datetime.microsecond == {0, 0}

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([payload]))
    end)

    assert {:ok, %{"exists" => true}} =
             Repository.upsert(
               "workspace-1",
               %{"learning_enabled" => false},
               updated_by_user_id: "user-1"
             )
  end

  test "update_tracker_kind writes tracker settings and updated_by_user_id" do
    credential_id = "123e4567-e89b-12d3-a456-426614174000"

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["on_conflict"] == "workspace_id"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      assert payload["workspace_id"] == "workspace-1"
      assert payload["tracker_kind"] == "linear"
      assert payload["tracker_credential_id"] == credential_id
      assert payload["updated_by_user_id"] == "user-1"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([payload]))
    end)

    assert {:ok,
            %{
              "workspace_id" => "workspace-1",
              "tracker_kind" => "linear",
              "tracker_credential_id" => ^credential_id,
              "exists" => true
            }} =
             Repository.update_tracker_kind("workspace-1", "linear", credential_id, updated_by_user_id: "user-1")
  end

  test "update_tracker_kind rejects invalid tracker values before writing" do
    assert {:error, {:unsupported_tracker_kind, "jira", _supported}} =
             Repository.update_tracker_kind("workspace-1", "jira", nil)

    assert {:error, {:missing_tracker_credential_id, "github"}} =
             Repository.update_tracker_kind("workspace-1", "github", nil)

    assert {:error, {:tracker_credential_not_supported, "database"}} =
             Repository.update_tracker_kind(
               "workspace-1",
               "database",
               "123e4567-e89b-12d3-a456-426614174000"
             )
  end

  test "delete removes the workspace settings row" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "DELETE"
      assert conn.request_path == "/rest/v1/workspace_settings"
      assert URI.decode_query(conn.query_string)["workspace_id"] == "eq.workspace-1"
      assert {"prefer", "return=representation"} in conn.req_headers

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!([%{"workspace_id" => "workspace-1", "learning_enabled" => false}])
      )
    end)

    assert {:ok, %{"deleted" => true, "settings" => %{"workspace_id" => "workspace-1"}}} =
             Repository.delete("workspace-1")
  end

  test "workspace_settings.manage is executable through the planner allowlist" do
    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([payload]))
    end)

    assert {:ok,
            %{
              output: %{
                "operation" => "upsert",
                "workspace_id" => "workspace-1",
                "learning_enabled" => false,
                "max_concurrent_agents" => 25
              }
            }} =
             ToolRegistry.execute(
               "workspace_settings.manage",
               %{
                 "operation" => "upsert",
                 "settings" => %{"learning_enabled" => false, "max_concurrent_agents" => 25}
               },
               %{workspace_id: "workspace-1", updated_by_user_id: "user-1"},
               ["workspace_settings.manage"]
             )
  end

  test "workspace_settings.update_tracker_kind is executable through the planner allowlist" do
    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = Jason.decode!(body)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([payload]))
    end)

    assert {:ok,
            %{
              output: %{
                "operation" => "update_tracker_kind",
                "workspace_id" => "workspace-1",
                "tracker_kind" => "memory",
                "tracker_credential_id" => nil
              }
            }} =
             ToolRegistry.execute(
               "workspace_settings.update_tracker_kind",
               %{"tracker_kind" => "memory"},
               %{workspace_id: "workspace-1", updated_by_user_id: "user-1"},
               ["workspace_settings.update_tracker_kind"]
             )
  end

  test "workspace_settings.manage rejects workspace_id that does not match the session workspace" do
    assert {:error, {:workspace_id_mismatch, "workspace-1", "workspace-2"}} =
             ToolRegistry.execute(
               "workspace_settings.manage",
               %{
                 "operation" => "read",
                 "workspace_id" => "workspace-2"
               },
               %{workspace_id: "workspace-1", updated_by_user_id: "user-1"},
               ["workspace_settings.manage"]
             )
  end

  test "workspace_settings.manage requires the session workspace context" do
    assert {:error, :missing_workspace_id} =
             ToolRegistry.execute(
               "workspace_settings.manage",
               %{
                 "operation" => "read",
                 "workspace_id" => "workspace-2"
               },
               %{},
               ["workspace_settings.manage"]
             )
  end
end
