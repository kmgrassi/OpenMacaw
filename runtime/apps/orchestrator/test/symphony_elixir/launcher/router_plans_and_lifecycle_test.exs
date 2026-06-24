defmodule SymphonyElixir.Launcher.RouterPlansAndLifecycleTest do
  use SymphonyElixir.Launcher.RouterTestSupport

  alias SymphonyElixir.Launcher.RouterTestSupport.TestMessageLog

  test "POST /agents/:id/runtime/api/v1/plans/draft-from-prompt drafts through the selected planning agent" do
    conn =
      conn(:post, "/agents/planner-1/runtime/api/v1/plans/draft-from-prompt", %{
        "workspace_id" => "workspace-1",
        "prompt" => "Plan a change"
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["draft"]["title"] == "Draft"
    assert [%{"id" => "t-01"}] = body["draft"]["tasks"]

    assert_received {:draft_for_agent, "planner-1", %{"workspace_id" => "workspace-1", "prompt" => "Plan a change"}}
  end

  test "POST /agents/:id/runtime/api/v1/plans/draft-from-prompt returns planner validation errors" do
    conn =
      conn(:post, "/agents/planner-1/runtime/api/v1/plans/draft-from-prompt", %{
        "workspace_id" => "workspace-1",
        "prompt" => "bad"
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 422
    body = Jason.decode!(conn.resp_body)
    assert body["errors"] == [%{"path" => "/tasks", "message" => "At least one task is required"}]
  end

  test "POST /orchestrators with valid params creates orchestrator" do
    conn =
      conn(:post, "/orchestrators", %{"tracker" => %{"kind" => "memory"}})
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["id"] =~ ~r/^orch_/
    assert body["data"]["port"] == 18_000
    assert body["data"]["status"] == "running"
  end

  test "POST /orchestrators without tracker returns 400" do
    conn =
      conn(:post, "/orchestrators", %{"repository" => "https://github.com/test/repo"})
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "tracker is required"
  end

  test "POST /orchestrators without tracker.kind returns 400" do
    conn =
      conn(:post, "/orchestrators", %{"tracker" => %{"endpoint" => "http://localhost"}})
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "tracker.kind is required"
  end

  test "POST /orchestrators with empty tracker.kind returns 400" do
    conn =
      conn(:post, "/orchestrators", %{"tracker" => %{"kind" => ""}})
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 400
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "tracker.kind is required"
  end

  test "POST /orchestrators keeps concrete execution profile errors" do
    conn =
      conn(:post, "/orchestrators", %{
        "tracker" => %{"kind" => "memory"},
        "execution_profile" => %{"runner_kind" => "codex"}
      })
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 422
    body = Jason.decode!(conn.resp_body)
    assert body["error"] =~ "missing_execution_profile_field"
    assert body["error"] =~ "provider"
    refute Map.has_key?(body, "error_code")
  end

  test "GET /orchestrators returns list" do
    conn(:post, "/orchestrators", %{"tracker" => %{"kind" => "memory"}})
    |> put_req_header("content-type", "application/json")
    |> call()

    conn =
      conn(:get, "/orchestrators")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert length(body["data"]) == 1
  end

  test "GET /orchestrators returns empty list when none created" do
    conn =
      conn(:get, "/orchestrators")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["data"] == []
  end

  test "GET /agents returns database inventory without exposing raw credentials" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        status: "ready",
        model_settings: %{"primary" => "openai/gpt-5"},
        has_credentials: true
      }
    ])

    conn =
      conn(:get, "/agents")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert [
             %{
               "id" => "agent-1",
               "has_credentials" => true,
               "type" => "coding",
               "model_settings" => %{"primary" => "openai/gpt-5"}
             }
           ] = body["data"]
  end

  test "POST /agents/:id/start returns structured 404 when agent is missing" do
    conn =
      conn(:post, "/agents/missing/start")
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "agent not found"
    assert body["error_code"] == "agent_not_found"
    assert body["required_config"] == ["agent"]
    assert body["resolution_hint"] == "Agent must exist in the agent table"
  end

  test "GET /agents/:id/credentials returns redacted stored credentials" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-1:OPENAI_API_KEY",
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        provider: "openai",
        label: "OpenAI API key ••••1234",
        env_var: "OPENAI_API_KEY",
        updated_at: "2026-04-14T00:00:00Z",
        launchable_kind: "codex",
        has_secret: true
      }
    ])

    conn =
      conn(:get, "/agents/agent-1/credentials")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert [%{"env_var" => "OPENAI_API_KEY", "launchable_kind" => "codex", "has_secret" => true}] =
             body["data"]
  end

  test "POST /agents/:id/start starts an orchestrator from agent inventory" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    conn =
      conn(:post, "/agents/agent-1/start")
      |> put_req_header("content-type", "application/json")
      |> call()

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["agent_id"] == "agent-1"
    assert body["data"]["type"] == "coding"
    assert body["data"]["workspace_id"] == "workspace-1"
    assert body["data"]["project_id"] == "project-1"
  end

  test "POST /agents/:id/start defaults to a database tracker when none is configured" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
    ])

    conn =
      conn(:post, "/agents/agent-1/start")
      |> put_req_header("content-type", "application/json")
      |> call()

    # The tracker is sourced from workspace_settings (default "database"), so a
    # launch config that omits a tracker no longer fails with missing_tracker_kind.
    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["agent_id"] == "agent-1"
  end

  test "runtime websocket state overrides caller-supplied scope with launcher context" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")

    conn =
      conn(
        :get,
        "/agents/agent-1/runtime/ws?agent_id=agent-2&workspace_id=workspace-2&session_key=custom&user_id=user-1"
      )
      |> fetch_query_params()

    assert {:ok, state} = RuntimeProxy.websocket_state("agent-1", conn)
    assert state.query_params["agent_id"] == "agent-1"
    assert state.query_params["workspace_id"] == "workspace-1"
    assert state.query_params["session_key"] == "custom"
    assert state.query_params["user_id"] == "user-1"
  end

  test "GET runtime state renders code access from target runtime workflow" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "repository" => "https://github.com/example/runtime-repo",
      "workspace" => %{"root" => "/tmp/runtime-workspaces"},
      "tracker" => %{"kind" => "memory"}
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")

    conn =
      conn(:get, "/agents/agent-1/runtime/api/v1/state")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["code_access"] == %{
             "type" => "repository",
             "label" => "example/runtime-repo",
             "value" => "https://github.com/example/runtime-repo",
             "workspace_path" => "/tmp/runtime-workspaces"
           }
  end

  test "GET runtime messages reads persisted agent history with pagination params" do
    Application.put_env(:symphony_elixir, :message_log_adapter, TestMessageLog)

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")

    conn =
      conn(
        :get,
        "/agents/agent-1/runtime/api/v1/messages?session_key=session-1&limit=25&before=2026-04-25T10:00:00Z&before_id=message-9"
      )
      |> call()

    assert conn.status == 200
    assert_received {:list_agent_messages, "agent-1", opts}
    assert opts[:workspace_id] == "workspace-1"
    assert opts[:limit] == "25"
    assert opts[:before] == "2026-04-25T10:00:00Z"
    assert opts[:before_id] == "message-9"

    body = Jason.decode!(conn.resp_body)
    assert [%{"id" => "message-1", "content" => "historic"}] = body["messages"]
    assert body["pagination"]["count"] == 1
  end

  test "GET /orchestrators/:id returns specific orchestrator" do
    create_conn =
      conn(:post, "/orchestrators", %{"tracker" => %{"kind" => "memory"}})
      |> put_req_header("content-type", "application/json")
      |> call()

    id = Jason.decode!(create_conn.resp_body)["data"]["id"]

    conn =
      conn(:get, "/orchestrators/#{id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["id"] == id
  end

  test "GET /orchestrators/:id returns 404 for unknown id" do
    conn =
      conn(:get, "/orchestrators/orch_nonexistent")
      |> call()

    assert conn.status == 404
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == "orchestrator not found"
  end

  test "DELETE /orchestrators/:id stops orchestrator" do
    create_conn =
      conn(:post, "/orchestrators", %{"tracker" => %{"kind" => "memory"}})
      |> put_req_header("content-type", "application/json")
      |> call()

    id = Jason.decode!(create_conn.resp_body)["data"]["id"]

    conn =
      conn(:delete, "/orchestrators/#{id}")
      |> call()

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["data"]["status"] == "stopped"

    get_conn =
      conn(:get, "/orchestrators/#{id}")
      |> call()

    assert get_conn.status == 404
  end

  test "DELETE /orchestrators/:id returns 404 for unknown id" do
    conn =
      conn(:delete, "/orchestrators/orch_nonexistent")
      |> call()

    assert conn.status == 404
  end
end
