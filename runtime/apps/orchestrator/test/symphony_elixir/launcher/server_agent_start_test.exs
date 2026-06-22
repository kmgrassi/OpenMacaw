defmodule SymphonyElixir.Launcher.ServerAgentStartTest do
  use SymphonyElixir.LauncherServerCase, async: false

  @moduletag :launcher

  test "start_agent starts an orchestrator from database inventory" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        workspace_id: "workspace-1",
        project_id: "project-1",
        model_settings: %{"primary" => "openai/gpt-5"},
        tool_policy: %{"planning" => %{"destination" => "database"}}
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert orchestrator.agent_id == "agent-1"
    assert orchestrator.agent_name == "Builder"
    assert orchestrator.workspace_id == "workspace-1"
    assert orchestrator.project_id == "project-1"
    assert orchestrator.type == "coding"
    assert orchestrator.port == 19_000
    assert get_in(orchestrator.config, ["stored_agent", "id"]) == "agent-1"
    assert get_in(orchestrator.config, ["stored_agent", "type"]) == "coding"
  end

  test "start_agent preserves explicit planning agent type in public response and config" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Planner",
        type: "planning",
        workspace_id: "workspace-1",
        tool_policy: %{"planning" => %{"destination" => "database"}}
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert orchestrator.type == "planning"
    assert get_in(orchestrator.config, ["stored_agent", "type"]) == "planning"
    assert get_in(orchestrator.config, ["stored_agent", "tool_policy", "planning", "destination"]) == "database"
  end

  test "start_agent reuses an existing running orchestrator for the same agent" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    assert {:ok, first} = Server.start_agent("agent-1")
    assert {:ok, second} = Server.start_agent("agent-1")

    assert second.id == first.id
    assert second.reused == true
    assert length(Server.list_orchestrators()) == 1
  end

  test "workspace_active_agents_count sums running agents across workspace orchestrators" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder A", workspace_id: "workspace-1"},
      %Agent{id: "agent-2", name: "Builder B", workspace_id: "workspace-1"},
      %Agent{id: "agent-3", name: "Builder C", workspace_id: "workspace-2"}
    ])

    assert {:ok, _runtime_one} = Server.start_agent("agent-1")
    assert {:ok, _runtime_two} = Server.start_agent("agent-2")
    assert {:ok, _runtime_three} = Server.start_agent("agent-3")

    assert {:ok, runtime_one} = Server.get_agent_runtime("agent-1")
    assert {:ok, runtime_two} = Server.get_agent_runtime("agent-2")
    assert {:ok, runtime_three} = Server.get_agent_runtime("agent-3")

    Elixir.Agent.update(runtime_one.pid, &Map.put(&1, :snapshot, %{running: [%{}, %{}]}))
    Elixir.Agent.update(runtime_two.pid, &Map.put(&1, :snapshot, %{running: [%{}]}))
    Elixir.Agent.update(runtime_three.pid, &Map.put(&1, :snapshot, %{running: [%{}, %{}, %{}]}))

    assert {:ok, 3} = Server.workspace_active_agents_count("workspace-1")
    assert {:ok, 3} = Server.workspace_active_agents_count("workspace-2")
  end

  test "workspace_active_agents_count skips the excluded orchestrator pid" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder A", workspace_id: "workspace-1"},
      %Agent{id: "agent-2", name: "Builder B", workspace_id: "workspace-1"}
    ])

    assert {:ok, _runtime_one} = Server.start_agent("agent-1")
    assert {:ok, _runtime_two} = Server.start_agent("agent-2")

    assert {:ok, runtime_one} = Server.get_agent_runtime("agent-1")
    assert {:ok, runtime_two} = Server.get_agent_runtime("agent-2")

    Elixir.Agent.update(runtime_one.pid, &Map.put(&1, :snapshot, %{running: [%{}, %{}]}))
    Elixir.Agent.update(runtime_two.pid, &Map.put(&1, :snapshot, %{running: [%{}]}))

    assert {:ok, 1} = Server.workspace_active_agents_count("workspace-1", exclude_pid: runtime_one.pid)
  end

  test "start_agent defaults to a database tracker when none is configured" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
    ])

    # tracker.kind is sourced from workspace_settings (default "database"), so a
    # missing tracker no longer blocks the launch.
    assert {:ok, _runtime} = Server.start_agent("agent-1")
  end

  test "start_agent returns structured error details when explicit execution profile is invalid" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "memory"},
      "execution_profile" => %{
        "runner_kind" => "codex"
      }
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
    ])

    assert {:error,
            {:invalid_agent_config, "agent launch execution profile is invalid",
             %{
               error_code: "invalid_execution_profile",
               required_config: ["execution_profile.provider"],
               resolution_hint: "Check model, provider, and runner settings",
               reason: {:missing_execution_profile_field, "provider"}
             }}} = Server.start_agent("agent-1")
  end

  test "heartbeat updates engine_instance rows for running orchestrators" do
    test_pid = self()

    Application.put_env(:symphony_elixir, :launcher_engine_instance,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: "engine_instance",
      host: "test-host"
    )

    Application.put_env(:symphony_elixir, :launcher_engine_instance_req_options, plug: {Req.Test, SymphonyElixir.Launcher.EngineInstance})

    Application.put_env(
      :symphony_elixir,
      :launcher_engine_instance_dispatcher,
      fn work ->
        send(test_pid, {:dispatch_engine_instance, work})
        :ok
      end
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_req_options)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_dispatcher)
    end)

    Req.Test.stub(SymphonyElixir.Launcher.EngineInstance, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      payload = if body == "", do: %{}, else: Jason.decode!(body)
      send(test_pid, {:engine_instance_request, conn.method, conn.query_string, payload})

      case conn.method do
        "GET" -> conn |> Plug.Conn.put_resp_content_type("application/json") |> Plug.Conn.send_resp(200, "[]")
        "POST" -> Plug.Conn.send_resp(conn, 201, "")
        _ -> Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    receive do
      {:dispatch_engine_instance, reconcile_work} ->
        assert :ok = reconcile_work.()
        assert_receive {:engine_instance_request, "GET", "host=eq.test-host", %{}}
    after
      0 ->
        :ok
    end

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
    ])

    assert {:ok, _orchestrator} = Server.start_agent("agent-1")
    assert {"on_conflict=instance_id", %{"status" => "running"}} = await_engine_instance_upsert()

    send(Server, :heartbeat)

    {query, payload} = await_engine_instance_heartbeat_patch()
    assert query =~ "instance_id=eq.orch_"
    assert is_binary(payload["last_health_at"])
    assert payload["last_health_at"] == payload["updated_at"]
  end

  test "start_agent accepts atom-keyed nested launch templates" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{tracker: %{kind: "memory"}})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: "agent-1",
        name: "Builder",
        model_settings: %{"primary" => "openai/gpt-5"}
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert get_in(orchestrator.config, ["tracker", "kind"]) == "memory"
  end

  test "start_agent injects stored LINEAR_API_KEY into a linear tracker" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{"tracker" => %{"kind" => "linear"}})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder"}
    ])

    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-linear",
        agent_id: "agent-1",
        provider: "linear",
        label: "Linear API key",
        env_var: "LINEAR_API_KEY",
        secret_value: "lin_api_shh",
        has_secret: true
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert get_in(orchestrator.config, ["tracker", "api_key"]) == "lin_api_shh"
    assert get_in(orchestrator.config, ["credentials", "LINEAR_API_KEY"]) == "lin_api_shh"
  end

  test "start_agent does not inject LINEAR_API_KEY into non-linear trackers" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{"tracker" => %{"kind" => "database"}})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder"}
    ])

    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-linear",
        agent_id: "agent-1",
        provider: "linear",
        label: "Linear API key",
        env_var: "LINEAR_API_KEY",
        secret_value: "lin_api_shh",
        has_secret: true
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    refute get_in(orchestrator.config, ["tracker", "api_key"])
    assert get_in(orchestrator.config, ["credentials", "LINEAR_API_KEY"]) == "lin_api_shh"
  end

  test "start_agent keeps the newest credential when env vars collide" do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder"}
    ])

    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-new",
        agent_id: "agent-1",
        provider: "openai",
        label: "OpenAI new",
        env_var: "OPENAI_API_KEY",
        secret_value: "sk-new",
        has_secret: true,
        updated_at: "2026-04-23T10:00:00Z"
      },
      %StoredCredential{
        id: "cred-old",
        agent_id: "agent-1",
        provider: "openai",
        label: "OpenAI old",
        env_var: "OPENAI_API_KEY",
        secret_value: "sk-old",
        has_secret: true,
        updated_at: "2026-04-22T10:00:00Z"
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert get_in(orchestrator.config, ["credentials", "OPENAI_API_KEY"]) == "sk-new"
  end

  test "start_agent does not override an api_key already set by the launch template" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "linear", "api_key" => "template_key"}
    })

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder"}
    ])

    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
      %StoredCredential{
        id: "cred-linear",
        agent_id: "agent-1",
        provider: "linear",
        label: "Linear API key",
        env_var: "LINEAR_API_KEY",
        secret_value: "stored_key",
        has_secret: true
      }
    ])

    assert {:ok, orchestrator} = Server.start_agent("agent-1")
    assert get_in(orchestrator.config, ["tracker", "api_key"]) == "template_key"
    assert get_in(orchestrator.config, ["credentials", "LINEAR_API_KEY"]) == "stored_key"
  end
end
