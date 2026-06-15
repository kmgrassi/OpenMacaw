defmodule SymphonyElixir.Launcher.RouterTestSupport do
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.{Router, Server}
  alias SymphonyElixir.WorkerBridge.Server, as: WorkerBridgeServer

  @service_role_key "launcher-router-test-service-role"

  defmacro __using__(_opts) do
    quote do
      use SymphonyElixir.TestSupport

      import Plug.Conn
      import Plug.Test

      alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
      alias SymphonyElixir.Launcher.{RuntimeProxy, Server}
      alias SymphonyElixir.Manager.Supervisor, as: ManagerSupervisor
      alias SymphonyElixir.PathSafety

      @moduletag :launcher

      setup do
        SymphonyElixir.Launcher.RouterTestSupport.setup_launcher_router_test(self())
      end

      defp call(conn), do: SymphonyElixir.Launcher.RouterTestSupport.call(conn)
      defp git!(args, opts), do: SymphonyElixir.Launcher.RouterTestSupport.git!(args, opts)
    end
  end

  defmodule RouterTestGatewayConfig do
    @behaviour SymphonyElixir.Launcher.GatewayConfig

    alias SymphonyElixir.Launcher.GatewayConfig.Resolved

    def fetch("workspace", workspace_id) do
      case Application.get_env(:symphony_elixir, :test_router_manager_gateway, %{}) do
        %{} = mapping ->
          case Map.get(mapping, workspace_id) do
            nil ->
              {:error, :not_found}

            config_json ->
              {:ok,
               %Resolved{
                 scope_type: "workspace",
                 scope_id: workspace_id,
                 config_json: config_json,
                 config_hash: "router-test-hash",
                 version: 1
               }}
          end

        _ ->
          {:error, :not_found}
      end
    end

    def fetch(_scope_type, _scope_id), do: {:error, :not_found}
    def record_apply_state(_scope_type, _scope_id, _status, _opts), do: :ok
  end

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
      {:ok,
       Application.get_env(:symphony_elixir, :test_agent_inventory_credentials, [])
       |> Enum.filter(&(&1.agent_id == agent_id))}
    end
  end

  defmodule TestExecutionProfile do
    def resolve(agent_id, workspace_id, _opts \\ []) do
      config =
        :symphony_elixir
        |> Application.get_env(:test_router_manager_gateway, %{})
        |> Map.get(workspace_id)
        |> then(&get_in(&1 || %{}, ["runners", "manager"]))

      case config do
        nil ->
          {:error, :not_found}

        %{} ->
          if Map.get(config, "provider") == "openai" and not is_binary(Map.get(config, "api_key")) do
            {:error, :credential_missing}
          else
            {:ok,
             %{
               agent_id: agent_id,
               workspace_id: workspace_id,
               runner_kind: "manager",
               provider: Map.get(config, "provider") || "openai",
               model: Map.get(config, "model"),
               api_key: Map.get(config, "api_key")
             }}
          end
      end
    end
  end

  defmodule TestMessageLog do
    def list_agent_messages(agent_id, opts) do
      send(
        Application.fetch_env!(:symphony_elixir, :test_parent),
        {:list_agent_messages, agent_id, opts}
      )

      {:ok,
       [
         %{
           "id" => "message-1",
           "role" => "user",
           "content" => "historic",
           "created_at" => "2026-04-25T10:00:00Z"
         }
       ], %{limit: 25, count: 1}}
    end
  end

  defmodule ManagerTickWorkItemSource do
    alias SymphonyElixir.Manager.WorkItemRow

    def due_work_items(_workspace_id, _agent_id, _now, _opts) do
      send(Application.fetch_env!(:symphony_elixir, :test_parent), :manager_tick_repo_all)

      rows =
        :symphony_elixir
        |> Application.fetch_env!(:test_manager_tick_rows)
        |> Enum.map(&WorkItemRow.to_work_item/1)

      {:ok, rows}
    end
  end

  defmodule ManagerTickChatGateway do
    def post_message(scope, body, opts) do
      send(
        Application.fetch_env!(:symphony_elixir, :test_parent),
        {:manager_tick_post_message, scope, body, opts}
      )

      {:ok, Keyword.fetch!(opts, :run_id)}
    end
  end

  defmodule TestPlanDraft do
    @behaviour SymphonyElixir.Planner.PlanDraft

    def draft_for_agent(agent_id, params) do
      send(
        Application.fetch_env!(:symphony_elixir, :test_parent),
        {:draft_for_agent, agent_id, params}
      )

      case params do
        %{"prompt" => "bad"} ->
          {:error, {:invalid_plan_draft, [%{"path" => "/tasks", "message" => "At least one task is required"}]}}

        _ ->
          {:ok,
           %{
             "draft" => %{
               "schema_version" => "1",
               "title" => "Draft",
               "intent" => "Test draft",
               "tasks" => [
                 %{
                   "id" => "t-01",
                   "title" => "Implement",
                   "instructions" => "Do the work",
                   "labels" => %{},
                   "depends_on" => [],
                   "completion_gates" => ["tests"]
                 }
               ]
             }
           }}
      end
    end
  end

  defmodule TestAgentProbe do
    def probe(workspace_id, agent_id) do
      send(Application.fetch_env!(:symphony_elixir, :test_parent), {:agent_probe_started, agent_id})

      counter = Application.get_env(:symphony_elixir, :test_agent_probe_counter)

      if is_pid(counter) do
        Elixir.Agent.get_and_update(counter, fn %{current: current, max: max} ->
          current = current + 1
          {%{current: current, max: max(max, current)}, %{current: current, max: max(max, current)}}
        end)
      end

      response =
        case Map.fetch(Application.get_env(:symphony_elixir, :test_agent_probe_results, %{}), agent_id) do
          {:ok, {:sleep, ms}} ->
            Process.sleep(ms)
            {:ok, :ready}

          {:ok, result} ->
            result

          :error ->
            unless is_binary(workspace_id) do
              raise "expected workspace_id to be a string"
            end

            {:ok, :ready}
        end

      if is_pid(counter) do
        Elixir.Agent.update(counter, fn %{current: current, max: max} ->
          %{current: current - 1, max: max}
        end)
      end

      response
    end
  end

  defmodule MockRuntime do
    use GenServer

    def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

    @impl true
    def init(_opts), do: {:ok, %{}}

    @impl true
    def handle_call(:snapshot, _from, state) do
      snapshot = %{
        running: [],
        retrying: [],
        codex_totals: %{},
        rate_limits: %{}
      }

      {:reply, snapshot, state}
    end
  end

  def setup_launcher_router_test(test_parent) do
    previous_service_role_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", @service_role_key)

    Application.put_env(:symphony_elixir, :test_parent, test_parent)
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :planner_plan_draft_adapter, TestPlanDraft)
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [])
    Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [])
    Application.put_env(:symphony_elixir, :test_manager_tick_rows, [])

    Application.put_env(
      :symphony_elixir,
      :manager_scheduler_session_resolver,
      TestExecutionProfile
    )

    Application.put_env(:symphony_elixir, :agent_diagnostic_probe_adapter, TestAgentProbe)
    Application.put_env(:symphony_elixir, :test_agent_probe_results, %{})

    Application.put_env(:symphony_elixir, :agent_diagnostic_options,
      per_agent_timeout_ms: 50,
      aggregate_timeout_ms: 500
    )

    Application.put_env(:symphony_elixir, :agent_launch_template, %{
      "tracker" => %{"kind" => "memory"}
    })

    state_dir = Path.join(System.tmp_dir!(), "launcher_router_test_#{:rand.uniform(999_999)}")
    File.mkdir_p!(state_dir)

    {:ok, cr_pid} = SymphonyElixir.Launcher.ConfigRegistry.start_link()

    {:ok, ds_pid} =
      DynamicSupervisor.start_link(
        name: SymphonyElixir.Launcher.DynamicSupervisor,
        strategy: :one_for_one
      )

    {:ok, server_pid} =
      Server.start_link(
        state_dir: state_dir,
        start_port: 18_000,
        starter: &mock_starter/1
      )

    {:ok, worker_bridge_pid} =
      WorkerBridgeServer.start_link(
        port_opener: fn _spec ->
          {:ok, Port.open({:spawn, ~c"cat"}, [:binary])}
        end
      )

    ExUnit.Callbacks.on_exit(fn ->
      case previous_service_role_key do
        nil -> System.delete_env("SUPABASE_SERVICE_ROLE_KEY")
        value -> System.put_env("SUPABASE_SERVICE_ROLE_KEY", value)
      end

      Application.delete_env(:symphony_elixir, :test_parent)
      Application.delete_env(:symphony_elixir, :message_log_adapter)
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :planner_plan_draft_adapter)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_agents)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_credentials)
      Application.delete_env(:symphony_elixir, :test_manager_tick_rows)
      Application.delete_env(:symphony_elixir, :manager_scheduler_session_resolver)
      Application.delete_env(:symphony_elixir, :agent_diagnostic_probe_adapter)
      Application.delete_env(:symphony_elixir, :agent_diagnostic_options)
      Application.delete_env(:symphony_elixir, :test_agent_probe_results)
      Application.delete_env(:symphony_elixir, :test_agent_probe_counter)
      Application.delete_env(:symphony_elixir, :agent_launch_template)
      Application.delete_env(:symphony_elixir, :local_runtime_diagnostics_source)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_adapter)
      Application.delete_env(:symphony_elixir, :test_router_manager_gateway)

      for pid <- [worker_bridge_pid, server_pid, ds_pid, cr_pid], do: safe_stop(pid)
      File.rm_rf!(state_dir)
    end)

    :ok
  end

  def call(conn) do
    conn
    |> Plug.Conn.delete_req_header("authorization")
    |> Plug.Conn.put_req_header("authorization", "Bearer #{@service_role_key}")
    |> Router.call(Router.init([]))
  end

  def git!(args, opts) do
    case System.cmd("git", args, Keyword.merge([stderr_to_stdout: true], opts)) do
      {_output, 0} -> :ok
      {output, status} -> raise "git failed status=#{status}: #{output}"
    end
  end

  defp mock_starter(opts) do
    supervisor = Keyword.fetch!(opts, :supervisor)
    id = Keyword.fetch!(opts, :id)
    config = Keyword.fetch!(opts, :config)
    workflow_path = Path.join(System.tmp_dir!(), "mock-workflow-#{id}.md")
    File.write!(workflow_path, SymphonyElixir.Orchestrator.Starter.build_workflow_content(config))

    child_spec = %{
      id: :"mock_orch_#{id}",
      start: {MockRuntime, :start_link, [[id: id]]},
      restart: :temporary
    }

    case DynamicSupervisor.start_child(supervisor, child_spec) do
      {:ok, pid} = result ->
        SymphonyElixir.Launcher.ConfigRegistry.put(pid, workflow_path)
        result

      result ->
        result
    end
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
end
