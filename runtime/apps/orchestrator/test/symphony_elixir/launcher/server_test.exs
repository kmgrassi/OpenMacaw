defmodule SymphonyElixir.Launcher.ServerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.Launcher.Server

  @moduletag :launcher

  defmodule TestAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents do
      {:ok, Application.get_env(:symphony_elixir, :test_agent_inventory_agents, [])}
    end

    def get_agent(agent_id) do
      Application.get_env(:symphony_elixir, :test_agent_inventory_agents, [])
      |> Enum.find(&(&1.id == agent_id))
      |> case do
        %Agent{} = agent -> {:ok, agent}
        nil -> {:error, :not_found}
      end
    end

    def list_credentials(agent_id) do
      case Application.get_env(:symphony_elixir, :test_agent_inventory_credentials_result) do
        {:error, _reason} = error ->
          error

        _ ->
          {:ok,
           Application.get_env(:symphony_elixir, :test_agent_inventory_credentials, [])
           |> Enum.filter(&(&1.agent_id == agent_id))}
      end
    end
  end

  defmodule TestGatewayConfig do
    @behaviour SymphonyElixir.Launcher.GatewayConfig

    def fetch(scope_type, scope_id) do
      lookup = Application.get_env(:symphony_elixir, :test_gateway_config_rows, %{})

      case Map.get(lookup, {scope_type, scope_id}) do
        %Resolved{} = resolved ->
          {:ok, resolved}

        {:error, _reason} = error ->
          error

        nil ->
          {:error, :not_found}
      end
    end

    def record_apply_state(scope_type, scope_id, status, opts) do
      test_pid = Application.get_env(:symphony_elixir, :test_gateway_config_state_pid)

      if is_pid(test_pid) do
        send(test_pid, {:gateway_config_state, scope_type, scope_id, status, opts})
      end

      case Application.get_env(:symphony_elixir, :test_gateway_config_state_response, :ok) do
        :ok -> :ok
        {:error, _} = error -> error
      end
    end
  end

  # A mock starter that creates a simple Agent instead of a real Orchestrator.
  # This avoids needing WorkflowStore, Config, etc. during tests.
  defp mock_starter(opts) do
    supervisor = Keyword.fetch!(opts, :supervisor)
    id = Keyword.fetch!(opts, :id)

    child_spec = %{
      id: :"mock_orch_#{id}",
      start: {Elixir.Agent, :start_link, [fn -> %{id: id, snapshot: %{running: []}} end]},
      restart: :temporary
    }

    DynamicSupervisor.start_child(supervisor, child_spec)
  end

  setup do
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [])
    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [])
    Application.delete_env(:symphony_elixir, :test_agent_inventory_credentials_result)
    Application.put_env(:symphony_elixir, :agent_launch_template, %{"tracker" => %{"kind" => "memory"}})
    Application.put_env(:symphony_elixir, :launcher_gateway_config_adapter, TestGatewayConfig)
    Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{})
    Application.put_env(:symphony_elixir, :test_gateway_config_state_pid, self())
    Application.put_env(:symphony_elixir, :test_gateway_config_state_response, :ok)

    Application.put_env(:symphony_elixir, :test_launcher_snapshotter, fn pid, _timeout ->
      Elixir.Agent.get(pid, &Map.get(&1, :snapshot))
    end)

    state_dir = Path.join(System.tmp_dir!(), "launcher_test_#{:rand.uniform(999_999)}")
    File.mkdir_p!(state_dir)

    {:ok, cr_pid} = SymphonyElixir.Launcher.ConfigRegistry.start_link()

    {:ok, ds_pid} =
      DynamicSupervisor.start_link(
        name: SymphonyElixir.Launcher.DynamicSupervisor,
        strategy: :one_for_one
      )

    {:ok, pid} =
      Server.start_link(
        state_dir: state_dir,
        start_port: 19_000,
        starter: &mock_starter/1,
        snapshotter: Application.fetch_env!(:symphony_elixir, :test_launcher_snapshotter)
      )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_agents)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_credentials)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_credentials_result)
      Application.delete_env(:symphony_elixir, :agent_launch_template)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_adapter)
      Application.delete_env(:symphony_elixir, :test_gateway_config_rows)
      Application.delete_env(:symphony_elixir, :test_gateway_config_state_pid)
      Application.delete_env(:symphony_elixir, :test_gateway_config_state_response)
      Application.delete_env(:symphony_elixir, :test_launcher_snapshotter)
      safe_stop(pid)
      safe_stop(ds_pid)
      safe_stop(cr_pid)
      File.rm_rf!(state_dir)
    end)

    %{state_dir: state_dir, server_pid: pid}
  end

  defp safe_stop(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        :exit, _ -> :ok
      end
    end
  end

  test "list_orchestrators returns empty list initially" do
    assert [] = Server.list_orchestrators()
  end

  test "start_orchestrator returns orchestrator with id and port", %{state_dir: state_dir} do
    config = %{"tracker" => %{"kind" => "memory"}}

    assert {:ok, orch} = Server.start_orchestrator(config)
    assert orch.id =~ ~r/^orch_[0-9a-f]{16}$/
    assert orch.port == 19_000
    assert orch.status == "running"
    assert orch.config == config

    # Verify it appears in the list
    list = Server.list_orchestrators()
    assert length(list) == 1
    assert hd(list).id == orch.id

    # Verify state was persisted
    assert File.exists?(Path.join(state_dir, "orchestrators.json"))
  end

  test "start_orchestrator assigns incrementing ports" do
    config = %{"tracker" => %{"kind" => "memory"}}

    {:ok, orch1} = Server.start_orchestrator(config)
    {:ok, orch2} = Server.start_orchestrator(config)

    assert orch1.port == 19_000
    assert orch2.port == 19_001
  end

  test "start_orchestrator skips the reserved relay port" do
    # The relay socket binds RELAY_SOCKET_PORT in this same node, so an
    # orchestrator must never be handed that port. With start_port 19_000,
    # reserving 19_000 pushes the first orchestrator to 19_001.
    System.put_env("RELAY_SOCKET_PORT", "19000")
    on_exit(fn -> System.delete_env("RELAY_SOCKET_PORT") end)

    config = %{"tracker" => %{"kind" => "memory"}}

    assert {:ok, orch} = Server.start_orchestrator(config)
    assert orch.port == 19_001
  end

  test "get_orchestrator returns the correct entry" do
    config = %{"tracker" => %{"kind" => "memory"}}
    {:ok, orch} = Server.start_orchestrator(config)

    assert {:ok, fetched} = Server.get_orchestrator(orch.id)
    assert fetched.id == orch.id
    assert fetched.port == orch.port
  end

  test "get_orchestrator returns not_found for unknown id" do
    assert {:error, :not_found} = Server.get_orchestrator("orch_nonexistent")
  end

  test "stop_orchestrator removes and returns the entry" do
    config = %{"tracker" => %{"kind" => "memory"}}
    {:ok, orch} = Server.start_orchestrator(config)

    assert {:ok, stopped} = Server.stop_orchestrator(orch.id)
    assert stopped.status == "stopped"
    assert stopped.id == orch.id

    # Verify it's gone from the list
    assert [] = Server.list_orchestrators()
    assert {:error, :not_found} = Server.get_orchestrator(orch.id)
  end

  test "stop_orchestrator returns not_found for unknown id" do
    assert {:error, :not_found} = Server.stop_orchestrator("orch_nonexistent")
  end

  test "persists state to disk", %{state_dir: state_dir} do
    config = %{"tracker" => %{"kind" => "memory"}}
    {:ok, _orch} = Server.start_orchestrator(config)

    path = Path.join(state_dir, "orchestrators.json")
    assert File.exists?(path)

    {:ok, content} = File.read(path)
    {:ok, data} = Jason.decode(content)

    assert length(data["orchestrators"]) == 1
    assert data["next_port"] == 19_001
  end

  test "restores pre-kind stored-agent state as coding", %{state_dir: state_dir, server_pid: server_pid} do
    GenServer.stop(server_pid, :normal, 5_000)

    path = Path.join(state_dir, "orchestrators.json")

    File.write!(
      path,
      Jason.encode!(%{
        next_port: 19_001,
        orchestrators: [
          %{
            id: "orch_existing",
            port: 19_000,
            config: %{"tracker" => %{"kind" => "memory"}},
            agent_id: "agent-1",
            agent_name: "Builder",
            workspace_id: "workspace-1",
            project_id: "project-1"
          }
        ]
      })
    )

    {:ok, restarted_pid} =
      Server.start_link(
        state_dir: state_dir,
        start_port: 19_000,
        starter: &mock_starter/1
      )

    on_exit(fn -> safe_stop(restarted_pid) end)

    assert [orchestrator] = Server.list_orchestrators()
    assert orchestrator.agent_id == "agent-1"
    assert orchestrator.type == "coding"
  end

  test "handles crash by restarting orchestrator" do
    config = %{"tracker" => %{"kind" => "memory"}}
    {:ok, orch} = Server.start_orchestrator(config)

    # Get the PID from the internal state
    [{_id, internal}] =
      :sys.get_state(Server)
      |> Map.get(:orchestrators)
      |> Enum.to_list()

    # Kill the process to simulate a crash
    Process.exit(internal.pid, :kill)

    # Give the Server time to handle the :DOWN message and restart
    Process.sleep(100)

    # The orchestrator should still be in the list (restarted)
    list = Server.list_orchestrators()
    assert length(list) == 1
    assert hd(list).id == orch.id
    assert hd(list).status == "running"
  end

  test "started_at is an ISO 8601 string" do
    config = %{"tracker" => %{"kind" => "memory"}}
    {:ok, orch} = Server.start_orchestrator(config)

    assert is_binary(orch.started_at)
    assert {:ok, _, _} = DateTime.from_iso8601(orch.started_at)
  end

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

  test "start_agent returns structured error details when tracker.kind is missing" do
    Application.put_env(:symphony_elixir, :agent_launch_template, %{})

    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
    ])

    assert {:error,
            {:invalid_agent_config, "agent launch config tracker.kind is required",
             %{
               error_code: "missing_tracker_kind",
               required_config: ["tracker.kind"],
               resolution_hint: "Create a gateway_config with tracker settings for this agent"
             }}} = Server.start_agent("agent-1")
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

  describe "gateway_config resolution" do
    test "agent-scoped gateway_config overrides the local template" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"}
      })

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-agent",
          version: 4,
          config_json: %{
            "tracker" => %{"kind" => "database", "endpoint" => "https://db"},
            "runners" => [%{"kind" => "codex"}]
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"
      assert get_in(orchestrator.config, ["runners"]) == [%{"kind" => "codex"}]
      assert get_in(orchestrator.config, ["stored_agent", "id"]) == "agent-1"

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-agent"
      assert Keyword.get(opts, :last_applied_version) == 4
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "falls back to workspace-scoped gateway_config when agent scope is missing" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"workspace", "workspace-1"} => %Resolved{
          scope_type: "workspace",
          scope_id: "workspace-1",
          config_hash: "hash-workspace",
          version: 2,
          config_json: %{"tracker" => %{"kind" => "database"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"

      assert_receive {:gateway_config_state, "workspace", "workspace-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-workspace"
      assert Keyword.get(opts, :last_applied_version) == 2
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "falls back to the local template when no gateway_config row exists" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"},
        "runners" => []
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "memory"

      refute_receive {:gateway_config_state, _, _, _, _}, 50
    end

    test "uses forwarded resolved execution profile with gateway_config launch settings" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"}
      })

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-agent",
          version: 4,
          config_json: %{
            "tracker" => %{"kind" => "database", "endpoint" => "https://db"},
            "runners" => [%{"kind" => "planner", "provider" => "anthropic"}]
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} =
               Server.start_agent("agent-1", %{
                 "trace_id" => "trace-1",
                 "resolved_execution_profile" => %{
                   "agentId" => "agent-1",
                   "workspaceId" => "workspace-1",
                   "role" => "coding",
                   "runnerKind" => "codex",
                   "provider" => "openai",
                   "model" => "gpt-5.2",
                   "credentialRef" => %{"type" => "credential_id", "value" => "cred-1"},
                   "toolProfile" => "coding"
                 }
               })

      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"
      assert get_in(orchestrator.config, ["tracker", "endpoint"]) == "https://db"
      assert get_in(orchestrator.config, ["runners"]) == [%{"kind" => "planner", "provider" => "anthropic"}]
      assert get_in(orchestrator.config, ["execution_profile", "runner_kind"]) == "codex"
      assert get_in(orchestrator.config, ["execution_profile", "provider"]) == "openai"
      assert get_in(orchestrator.config, ["execution_profile", "model"]) == "gpt-5.2"
      assert get_in(orchestrator.config, ["execution_profile", "credential_ref", "type"]) == "credential_id"
      assert get_in(orchestrator.config, ["resolved_execution_profile", "runner_kind"]) == "codex"

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-agent"
      assert Keyword.get(opts, :last_applied_version) == 4
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "records last_apply_status=error when the orchestrator fails to start" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-err"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-err",
          config_hash: "hash-err",
          version: 7,
          config_json: %{"tracker" => %{"kind" => "memory"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-err",
          name: "Broken",
          workspace_id: "workspace-1"
        }
      ])

      # Swap the server's starter with one that always fails.
      :sys.replace_state(Server, fn state ->
        %{state | starter: fn _opts -> {:error, :boom} end}
      end)

      assert {:error, :boom} = Server.start_agent("agent-err")

      assert_receive {:gateway_config_state, "agent", "agent-err", :error, opts}
      assert Keyword.get(opts, :last_apply_error) == ":boom"
      assert Keyword.get(opts, :broker_instance_id) == nil
    end

    test "propagates gateway_config transport errors instead of silently falling back" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => {:error, {:http_error, 500, "boom"}}
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:error, {:http_error, 500, "boom"}} = Server.start_agent("agent-1")
      refute_receive {:gateway_config_state, _, _, _, _}, 50
    end

    test "reuses a running orchestrator even when gateway_config is unavailable" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-1",
          version: 1,
          config_json: %{"tracker" => %{"kind" => "memory"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert first.reused != true

      # Simulate Supabase going flaky between the first and second call.
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => {:error, {:http_error, 500, "boom"}},
        {"workspace", "workspace-1"} => {:error, {:http_error, 500, "boom"}}
      })

      assert {:ok, second} = Server.start_agent("agent-1")
      assert second.id == first.id
      assert second.reused == true
    end

    test "reuses a credentialed orchestrator when stored credential refresh is incomplete" do
      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
        %StoredCredential{
          id: "cred-openai",
          agent_id: "agent-1",
          provider: "openai",
          label: "OpenAI",
          env_var: "OPENAI_API_KEY",
          secret_value: "sk-existing",
          has_secret: true
        }
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert get_in(first.config, ["credentials", "OPENAI_API_KEY"]) == "sk-existing"

      Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
        %StoredCredential{
          id: "cred-openai",
          agent_id: "agent-1",
          provider: "openai",
          label: "OpenAI",
          env_var: "OPENAI_API_KEY",
          secret_ref: "secret/openai",
          has_secret: true
        }
      ])

      Application.put_env(:symphony_elixir, :worker_bridge_secret_ref_resolver, fn _secret_ref, _aliases ->
        {:error, :temporarily_unavailable}
      end)

      on_exit(fn -> Application.delete_env(:symphony_elixir, :worker_bridge_secret_ref_resolver) end)

      assert {:ok, second} = Server.start_agent("agent-1")

      assert second.id == first.id
      assert second.reused == true
      assert second.restart_count == 0
      assert get_in(second.config, ["credentials", "OPENAI_API_KEY"]) == "sk-existing"
    end

    test "refreshes a running agent orchestrator when resolved config changes" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-1",
          version: 1,
          config_json: %{
            "tracker" => %{"kind" => "memory"},
            "execution_profile" => %{
              "runner_kind" => "manager",
              "provider" => "local",
              "model" => "qwen3-coder:30b"
            }
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert get_in(first.config, ["stored_agent", "tool_policy"]) == %{}
      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, first_opts}
      assert Keyword.get(first_opts, :last_applied_hash) == "hash-1"

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1",
          tool_policy: %{"allowed_tools" => ["git.run", "repo.read_file"]}
        }
      ])

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-2",
          version: 2,
          config_json: %{
            "tracker" => %{"kind" => "memory"},
            "execution_profile" => %{
              "runner_kind" => "manager",
              "provider" => "local",
              "model" => "qwen3-coder:30b"
            }
          }
        }
      })

      assert {:ok, second} = Server.start_agent("agent-1")

      assert second.id == first.id
      assert second.port == first.port
      assert second.reused == false
      assert second.restart_count == 1
      assert get_in(second.config, ["stored_agent", "tool_policy", "allowed_tools"]) == ["git.run", "repo.read_file"]

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, second_opts}
      assert Keyword.get(second_opts, :last_applied_hash) == "hash-2"
      assert Keyword.get(second_opts, :last_applied_version) == 2
    end
  end

  defp await_engine_instance_upsert(attempts \\ 5)

  defp await_engine_instance_upsert(0) do
    flunk("expected engine_instance upsert POST")
  end

  defp await_engine_instance_upsert(attempts) do
    receive do
      {:engine_instance_request, "POST", query, payload} ->
        {query, payload}

      {:engine_instance_request, _method, _query, _payload} ->
        await_engine_instance_upsert(attempts - 1)
    after
      0 ->
        assert_receive {:dispatch_engine_instance, work}
        assert :ok = work.()
        await_engine_instance_upsert(attempts)
    end
  end

  defp await_engine_instance_heartbeat_patch(attempts \\ 5)

  defp await_engine_instance_heartbeat_patch(0) do
    flunk("expected engine_instance heartbeat PATCH")
  end

  defp await_engine_instance_heartbeat_patch(attempts) do
    receive do
      {:engine_instance_request, "PATCH", query, payload} ->
        if String.contains?(query, "instance_id=eq.orch_") do
          {query, payload}
        else
          await_engine_instance_heartbeat_patch(attempts - 1)
        end

      {:engine_instance_request, _method, _query, _payload} ->
        await_engine_instance_heartbeat_patch(attempts - 1)
    after
      0 ->
        assert_receive {:dispatch_engine_instance, work}
        assert :ok = work.()
        await_engine_instance_heartbeat_patch(attempts)
    end
  end
end
