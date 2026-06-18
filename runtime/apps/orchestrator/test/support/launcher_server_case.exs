defmodule SymphonyElixir.LauncherServerCase do
  use ExUnit.CaseTemplate

  import ExUnit.Assertions

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.Launcher.Server

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

  using do
    quote do
      use SymphonyElixir.TestSupport

      alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
      alias SymphonyElixir.Launcher.GatewayConfig.Resolved
      alias SymphonyElixir.Launcher.Server

      import SymphonyElixir.LauncherServerCase
    end
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

  def mock_starter(opts) do
    supervisor = Keyword.fetch!(opts, :supervisor)
    id = Keyword.fetch!(opts, :id)

    child_spec = %{
      id: :"mock_orch_#{id}",
      start: {Elixir.Agent, :start_link, [fn -> %{id: id, snapshot: %{running: []}} end]},
      restart: :temporary
    }

    DynamicSupervisor.start_child(supervisor, child_spec)
  end

  def safe_stop(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        :exit, _ -> :ok
      end
    end
  end

  def await_engine_instance_upsert(attempts \\ 5)

  def await_engine_instance_upsert(0) do
    flunk("expected engine_instance upsert POST")
  end

  def await_engine_instance_upsert(attempts) do
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

  def await_engine_instance_heartbeat_patch(attempts \\ 5)

  def await_engine_instance_heartbeat_patch(0) do
    flunk("expected engine_instance heartbeat PATCH")
  end

  def await_engine_instance_heartbeat_patch(attempts) do
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
