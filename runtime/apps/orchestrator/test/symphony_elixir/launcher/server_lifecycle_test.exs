defmodule SymphonyElixir.Launcher.ServerLifecycleTest do
  use SymphonyElixir.LauncherServerCase, async: false

  @moduletag :launcher

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

    list = Server.list_orchestrators()
    assert length(list) == 1
    assert hd(list).id == orch.id

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

    [{_id, internal}] =
      :sys.get_state(Server)
      |> Map.get(:orchestrators)
      |> Enum.to_list()

    Process.exit(internal.pid, :kill)
    Process.sleep(100)

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
end
