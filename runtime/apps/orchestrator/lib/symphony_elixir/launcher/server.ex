defmodule SymphonyElixir.Launcher.Server do
  @moduledoc """
  GenServer that manages orchestrator instance lifecycles.

  The Launcher is the long-lived supervisor process that starts, stops, monitors,
  and restarts orchestrator instances. It exposes its state via the Launcher HTTP API
  (see `SymphonyElixir.Launcher.Router`).

  ## Responsibilities

  - Assigns ports to new orchestrator instances (4000, 4001, 4002, ...)
  - Starts orchestrators under a DynamicSupervisor
  - Monitors orchestrator processes and restarts on crash
  - Persists active orchestrator configs to disk for restart recovery
  - Provides orchestrator status for the HTTP API

  Heavy lifting is delegated:

  - `SymphonyElixir.Launcher.AgentStarter` — gateway-config lookup, credential
    injection, execution-profile normalization, validation.
  - `SymphonyElixir.Launcher.StateManager` — JSON persistence + restart-on-boot.

  This module owns the GenServer machinery. Engine instance writeback is
  delegated to `SymphonyElixir.Launcher.EngineInstanceSync`.

  ## State shape

      %{
        orchestrators: %{
          "orch_abc123" => %{
            id: "orch_abc123",
            pid: #PID<0.123.0>,
            ref: #Reference<...>,
            port: 4000,
            config: %{...},
            started_at: ~U[2026-04-13 10:00:00Z],
            status: :running
          }
        },
        next_port: 4000,
        state_dir: "~/.symphony/launcher",
        starter: &Orchestrator.Starter.start/1
      }
  """

  use GenServer

  require Logger

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Launcher.AgentStarter
  alias SymphonyElixir.Launcher.ConfigRegistry
  alias SymphonyElixir.Launcher.EngineInstanceSync
  alias SymphonyElixir.Launcher.GatewayApply
  alias SymphonyElixir.Launcher.LifecycleLog
  alias SymphonyElixir.Launcher.OrchestratorEntry
  alias SymphonyElixir.Launcher.RuntimeConfig
  alias SymphonyElixir.Launcher.StateManager
  alias SymphonyElixir.Launcher.WorkspaceRuntime
  alias SymphonyElixir.Orchestrator.Starter
  alias SymphonyElixir.Planning.PlanHandoff
  alias SymphonyElixir.RuntimeLog

  @dynamic_supervisor SymphonyElixir.Launcher.DynamicSupervisor
  @default_heartbeat_ms 30_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec start_orchestrator(map()) :: {:ok, map()} | {:error, term()}
  def start_orchestrator(config) do
    GenServer.call(__MODULE__, {:start_orchestrator, config}, 30_000)
  end

  @spec stop_orchestrator(String.t()) :: {:ok, map()} | {:error, term()}
  def stop_orchestrator(id) do
    GenServer.call(__MODULE__, {:stop_orchestrator, id})
  end

  @spec list_orchestrators() :: [map()]
  def list_orchestrators do
    GenServer.call(__MODULE__, :list_orchestrators)
  end

  @spec workspace_active_agents_count(String.t(), keyword()) ::
          {:ok, non_neg_integer()} | {:error, term()}
  def workspace_active_agents_count(workspace_id, opts \\ [])
      when is_binary(workspace_id) and workspace_id != "" do
    exclude_pid = Keyword.get(opts, :exclude_pid)

    GenServer.call(
      __MODULE__,
      {:workspace_active_agents_count, workspace_id, exclude_pid},
      15_000
    )
  catch
    :exit, _reason -> {:error, :launcher_unavailable}
  end

  @spec get_orchestrator(String.t()) :: {:ok, map()} | {:error, :not_found}
  def get_orchestrator(id) do
    GenServer.call(__MODULE__, {:get_orchestrator, id})
  end

  @spec start_agent(String.t(), map() | nil) :: {:ok, map()} | {:error, term()}
  def start_agent(agent_id, launch_params \\ %{}) when is_binary(agent_id) do
    GenServer.call(__MODULE__, {:start_agent, agent_id, launch_params}, 30_000)
  end

  @spec get_agent_runtime(String.t()) :: {:ok, map()} | {:error, :not_found}
  def get_agent_runtime(agent_id) when is_binary(agent_id) do
    GenServer.call(__MODULE__, {:get_agent_runtime, agent_id})
  end

  @spec health_summary() :: map()
  def health_summary do
    GenServer.call(__MODULE__, :health_summary)
  catch
    :exit, _reason -> %{latest_failure: LifecycleLog.latest_failure()}
  end

  @impl true
  def init(opts) do
    state_dir = Keyword.get(opts, :state_dir, default_state_dir())
    start_port = Keyword.get(opts, :start_port, default_start_port())
    starter = Keyword.get(opts, :starter, &default_starter/1)
    heartbeat_ms = Keyword.get(opts, :heartbeat_ms, default_heartbeat_ms())
    snapshotter = Keyword.get(opts, :snapshotter, &SymphonyElixir.Orchestrator.snapshot/2)
    File.mkdir_p!(state_dir)

    state = %{
      orchestrators: %{},
      next_port: start_port,
      state_dir: state_dir,
      starter: starter,
      snapshotter: snapshotter,
      heartbeat_ms: heartbeat_ms,
      heartbeat_ref: nil,
      latest_failure: nil
    }

    state =
      StateManager.restore(
        state,
        fn id, port, config -> do_start_orchestrator(state, id, port, config) end,
        fn entry ->
          ref = Process.monitor(entry.pid)
          entry = %{entry | ref: ref}
          EngineInstanceSync.record_state(entry, :running)
          entry
        end
      )

    # Defer Supabase reconcile until after init returns so slow/unreachable
    # Supabase cannot block supervisor start. Heartbeat scheduling moves
    # with it so a failed reconcile doesn't skip the timer.
    {:ok, state, {:continue, :bootstrap}}
  end

  @impl true
  def handle_continue(:bootstrap, state) do
    reconcile_engine_instance_async(state)
    {:noreply, schedule_heartbeat(state)}
  end

  @impl true
  def handle_call({:start_orchestrator, config}, _from, state) do
    case AgentStarter.normalize_execution_profile(config) do
      {:ok, config, profile} ->
        do_handle_start_orchestrator(config, profile, state)

      {:error, reason} ->
        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            %{desired_state: :running, actual_state: :failed},
            nil,
            reason,
            operation: :config_resolution
          )

        {:reply, {:error, reason}, %{state | latest_failure: fields}}
    end
  end

  @impl true
  def handle_call({:stop_orchestrator, id}, _from, state) do
    case Map.get(state.orchestrators, id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      entry ->
        started_at = System.monotonic_time(:millisecond)

        RuntimeLog.log(
          :info,
          :agent_stop_requested,
          OrchestratorEntry.runtime_log_fields(
            entry,
            LifecycleLog.start_fields(entry, %{desired_state: :stopped})
          )
        )

        do_stop_orchestrator(entry)

        stopped_entry = %{entry | status: :stopped, pid: nil, ref: nil}
        new_state = %{state | orchestrators: Map.delete(state.orchestrators, id)}
        StateManager.persist(new_state)
        EngineInstanceSync.update_status(stopped_entry, :stopped)

        RuntimeLog.log(
          :info,
          :agent_stopped,
          OrchestratorEntry.runtime_log_fields(
            stopped_entry,
            LifecycleLog.completion_fields(stopped_entry, started_at, %{desired_state: :stopped})
          )
        )

        {:reply, {:ok, OrchestratorEntry.serialize(stopped_entry)}, new_state}
    end
  end

  @impl true
  def handle_call(:health_summary, _from, state) do
    {:reply,
     %{
       orchestrator_count: map_size(state.orchestrators),
       latest_failure: LifecycleLog.latest_failure() || state.latest_failure
     }, state}
  end

  @impl true
  def handle_call(:list_orchestrators, _from, state) do
    orchestrators =
      state.orchestrators
      |> Map.values()
      |> Enum.map(&OrchestratorEntry.serialize/1)

    {:reply, orchestrators, state}
  end

  @impl true
  def handle_call({:workspace_active_agents_count, workspace_id, exclude_pid}, _from, state) do
    {:reply, WorkspaceRuntime.active_agents_count(state, workspace_id, exclude_pid, state.snapshotter), state}
  end

  @impl true
  def handle_call({:get_orchestrator, id}, _from, state) do
    case Map.get(state.orchestrators, id) do
      nil -> {:reply, {:error, :not_found}, state}
      entry -> {:reply, {:ok, OrchestratorEntry.serialize(entry)}, state}
    end
  end

  @impl true
  def handle_call({:start_agent, agent_id, launch_params}, _from, state) do
    with {:ok, %Agent{} = agent} <- AgentInventory.get_agent(agent_id),
         {:ok, handoff} <- PlanHandoff.validate_launch(agent, launch_params) do
      case find_orchestrator_by_agent_id(state.orchestrators, agent_id) do
        {_id, entry} ->
          refresh_or_reuse_agent_orchestrator(agent, entry, state, handoff, launch_params)

        nil ->
          start_new_agent_orchestrator(agent, state, handoff, launch_params)
      end
    else
      {:error, reason} = error ->
        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            %{agent_id: agent_id, desired_state: :running, actual_state: :failed},
            nil,
            reason,
            operation: :config_resolution
          )

        {:reply, error, %{state | latest_failure: fields}}
    end
  end

  @impl true
  def handle_call({:get_agent_runtime, agent_id}, _from, state) do
    case find_orchestrator_by_agent_id(state.orchestrators, agent_id) do
      {_id, entry} -> {:reply, {:ok, entry}, state}
      nil -> {:reply, {:error, :not_found}, state}
    end
  end

  defp start_new_agent_orchestrator(%Agent{} = agent, state, handoff, launch_params) do
    started_at = System.monotonic_time(:millisecond)

    case AgentStarter.resolve_and_validate_agent_config(agent, launch_params) do
      {:ok, config, resolution} ->
        config = AgentStarter.inject_plan_handoff(config, handoff)
        {:ok, profile} = ExecutionProfile.normalize_from_config(config)
        id = generate_id()
        port = next_orchestrator_port(state.next_port)
        trace_id = OrchestratorEntry.trace_id_from_config(config)

        RuntimeLog.log(
          :info,
          :agent_start_requested,
          %{
            trace_id: trace_id,
            agent_id: agent.id,
            workspace_id: agent.workspace_id,
            run_id: id,
            port: port,
            launcher_path: "agents"
          }
          |> Map.merge(ExecutionProfile.log_fields(profile))
        )

        case do_start_orchestrator(state, id, port, config) do
          {:ok, pid} ->
            ref = Process.monitor(pid)

            entry =
              OrchestratorEntry.new(id, pid, ref, port, config, %{
                agent_id: agent.id,
                type: Agent.kind(agent),
                agent_name: agent.name,
                workspace_id: agent.workspace_id,
                project_id: agent.project_id
              })

            new_state = %{
              state
              | orchestrators: Map.put(state.orchestrators, id, entry),
                next_port: port + 1
            }

            StateManager.persist(new_state)
            EngineInstanceSync.record_state(entry, :running)
            GatewayApply.record(resolution, :ok, id)

            RuntimeLog.log(
              :info,
              :agent_started,
              OrchestratorEntry.runtime_log_fields(
                entry,
                LifecycleLog.completion_fields(entry, started_at, %{trace_id: trace_id})
                |> Map.merge(ExecutionProfile.log_fields(profile))
              )
            )

            {:reply, {:ok, OrchestratorEntry.serialize(entry)}, new_state}

          {:error, reason} = error ->
            GatewayApply.record(resolution, :error, nil, error: RuntimeConfig.format_error(reason))

            fields =
              LifecycleLog.log_failure(
                :error,
                :agent_start_failed,
                %{
                  trace_id: trace_id,
                  agent_id: agent.id,
                  workspace_id: agent.workspace_id,
                  run_id: id,
                  port: port,
                  desired_state: :running,
                  actual_state: :failed
                },
                started_at,
                reason,
                operation: :start
              )

            {:reply, error, %{state | latest_failure: fields}}
        end

      {:error, reason} = error ->
        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            %{
              agent_id: agent.id,
              workspace_id: agent.workspace_id,
              desired_state: :running,
              actual_state: :failed
            },
            started_at,
            reason,
            operation: :config_resolution
          )

        {:reply, error, %{state | latest_failure: fields}}
    end
  end

  defp refresh_or_reuse_agent_orchestrator(%Agent{} = agent, entry, state, handoff, launch_params) do
    case AgentStarter.resolve_and_validate_agent_config_with_metadata(agent, launch_params) do
      {:ok, config, resolution, metadata} ->
        config = AgentStarter.inject_plan_handoff(config, handoff)

        cond do
          incomplete_credential_refresh?(metadata) and
              RuntimeConfig.resolved_credentials?(entry.config) ->
            RuntimeLog.log(
              :warning,
              :agent_start_credential_refresh_incomplete_reusing_runtime,
              %{
                agent_id: agent.id,
                workspace_id: agent.workspace_id,
                run_id: entry.id,
                port: entry.port,
                reason: inspect(Map.get(metadata, :credential_refresh)),
                retryable: true
              }
            )

            {:reply, {:ok, OrchestratorEntry.serialize(entry, true)}, state}

          RuntimeConfig.equivalent?(entry.config, config) ->
            {:reply, {:ok, OrchestratorEntry.serialize(entry, true)}, state}

          true ->
            restart_agent_orchestrator(agent, entry, state, config, resolution)
        end

      {:error, reason} ->
        RuntimeLog.log(:warning, :agent_start_config_refresh_failed_reusing_runtime, %{
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          run_id: entry.id,
          port: entry.port,
          reason: inspect(reason),
          retryable: true
        })

        {:reply, {:ok, OrchestratorEntry.serialize(entry, true)}, state}
    end
  end

  defp restart_agent_orchestrator(%Agent{} = agent, entry, state, config, resolution) do
    started_at = System.monotonic_time(:millisecond)
    trace_id = OrchestratorEntry.trace_id_from_config(config)
    {:ok, profile} = ExecutionProfile.normalize_from_config(config)

    RuntimeLog.log(
      :info,
      :agent_restart_requested_for_config_change,
      %{
        trace_id: trace_id,
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        run_id: entry.id,
        port: entry.port,
        launcher_path: "agents",
        desired_state: :running,
        actual_state: :restarting
      }
      |> Map.merge(ExecutionProfile.log_fields(profile))
    )

    do_stop_orchestrator(entry)

    case do_start_orchestrator(state, entry.id, entry.port, config) do
      {:ok, pid} ->
        ref = Process.monitor(pid)

        updated_entry =
          OrchestratorEntry.restarted(entry, pid, ref, config, %{
            type: Agent.kind(agent),
            agent_name: agent.name,
            workspace_id: agent.workspace_id,
            project_id: agent.project_id
          })

        new_state = %{
          state
          | orchestrators: Map.put(state.orchestrators, entry.id, updated_entry)
        }

        StateManager.persist(new_state)
        EngineInstanceSync.record_state(updated_entry, :running)
        GatewayApply.record(resolution, :ok, entry.id)

        RuntimeLog.log(
          :info,
          :agent_restarted_for_config_change,
          OrchestratorEntry.runtime_log_fields(
            updated_entry,
            LifecycleLog.completion_fields(updated_entry, started_at, %{trace_id: trace_id})
            |> Map.merge(ExecutionProfile.log_fields(profile))
          )
        )

        {:reply, {:ok, OrchestratorEntry.serialize(updated_entry, false)}, new_state}

      {:error, reason} = error ->
        GatewayApply.record(resolution, :error, entry.id, error: RuntimeConfig.format_error(reason))

        EngineInstanceSync.update_status(entry, :failed)

        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            %{
              trace_id: trace_id,
              agent_id: agent.id,
              workspace_id: agent.workspace_id,
              run_id: entry.id,
              port: entry.port,
              desired_state: :running,
              actual_state: :failed
            },
            started_at,
            reason,
            operation: :restart_for_config_change
          )

        new_state = %{
          state
          | orchestrators: Map.delete(state.orchestrators, entry.id),
            latest_failure: fields
        }

        StateManager.persist(new_state)
        {:reply, error, new_state}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, pid, reason}, state) do
    case find_orchestrator_by_ref(state.orchestrators, ref) do
      nil ->
        Logger.warning("Unknown process #{inspect(pid)} exited: #{inspect(reason)}")
        {:noreply, state}

      {id, entry} ->
        RuntimeLog.with_operation_trace_id(nil, fn ->
          Logger.warning("Orchestrator #{id} (port #{entry.port}) crashed: #{inspect(reason)}. Restarting...")

          fields =
            LifecycleLog.log_failure(
              :warning,
              :launcher_runtime_crashed,
              entry,
              nil,
              reason,
              operation: :runtime_crash,
              desired_state: :running,
              actual_state: :crashed
            )

          EngineInstanceSync.update_status(entry, :restarting)
          state = restart_orchestrator(%{state | latest_failure: fields}, id, entry)
          {:noreply, state}
        end)
    end
  end

  @impl true
  def handle_info(:heartbeat, state) do
    RuntimeLog.with_operation_trace_id(nil, fn ->
      EngineInstanceSync.emit_heartbeats(state.orchestrators)
    end)

    {:noreply, schedule_heartbeat(state)}
  end

  @impl true
  def handle_info(msg, state) do
    Logger.debug("Launcher.Server received unexpected message: #{inspect(msg)}")
    {:noreply, state}
  end

  # --- Private ---

  defp do_handle_start_orchestrator(config, profile, state) do
    started_at = System.monotonic_time(:millisecond)
    id = generate_id()
    port = next_orchestrator_port(state.next_port)
    trace_id = OrchestratorEntry.trace_id_from_config(config)

    RuntimeLog.log(
      :info,
      :agent_start_requested,
      %{
        trace_id: trace_id,
        run_id: id,
        port: port,
        launcher_path: "orchestrators"
      }
      |> Map.merge(ExecutionProfile.log_fields(profile))
    )

    case do_start_orchestrator(state, id, port, config) do
      {:ok, pid} ->
        ref = Process.monitor(pid)

        entry = OrchestratorEntry.new(id, pid, ref, port, config)

        new_state = %{
          state
          | orchestrators: Map.put(state.orchestrators, id, entry),
            next_port: port + 1
        }

        StateManager.persist(new_state)

        reply = OrchestratorEntry.serialize(entry)

        RuntimeLog.log(
          :info,
          :agent_started,
          OrchestratorEntry.runtime_log_fields(
            entry,
            LifecycleLog.completion_fields(entry, started_at, %{trace_id: trace_id})
            |> Map.merge(ExecutionProfile.log_fields(profile))
          )
        )

        {:reply, {:ok, reply}, new_state}

      {:error, reason} ->
        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            %{
              trace_id: trace_id,
              run_id: id,
              port: port,
              desired_state: :running,
              actual_state: :failed
            },
            started_at,
            reason,
            operation: :start
          )

        {:reply, {:error, reason}, %{state | latest_failure: fields}}
    end
  end

  defp do_start_orchestrator(state, id, port, config) do
    state.starter.(
      supervisor: @dynamic_supervisor,
      port: port,
      config: config,
      id: id
    )
  end

  defp default_starter(opts) do
    Starter.start(opts)
  end

  defp do_stop_orchestrator(%{id: id, pid: pid, ref: ref}) when is_pid(pid) do
    Process.demonitor(ref, [:flush])
    DynamicSupervisor.terminate_child(@dynamic_supervisor, pid)
    # Clean up config registry entries
    ConfigRegistry.delete(pid)
    ConfigRegistry.delete(:"orchestrator_#{id}")
  end

  defp do_stop_orchestrator(_entry), do: :ok

  defp restart_orchestrator(state, id, entry) do
    started_at = System.monotonic_time(:millisecond)

    case do_start_orchestrator(state, id, entry.port, entry.config) do
      {:ok, new_pid} ->
        new_ref = Process.monitor(new_pid)

        updated_entry = OrchestratorEntry.crash_restarted(entry, new_pid, new_ref)

        new_orchestrators = Map.put(state.orchestrators, id, updated_entry)
        new_state = %{state | orchestrators: new_orchestrators}
        StateManager.persist(new_state)
        EngineInstanceSync.update_status(updated_entry, :running)

        Logger.info("Orchestrator #{id} restarted successfully on port #{entry.port}")

        RuntimeLog.log(
          :info,
          :agent_started,
          OrchestratorEntry.runtime_log_fields(
            updated_entry,
            LifecycleLog.completion_fields(updated_entry, started_at, %{
              restart: true,
              desired_state: :running
            })
          )
        )

        new_state

      {:error, reason} ->
        Logger.error("Failed to restart orchestrator #{id}: #{inspect(reason)}")
        new_orchestrators = Map.delete(state.orchestrators, id)
        new_state = %{state | orchestrators: new_orchestrators}
        StateManager.persist(new_state)
        EngineInstanceSync.update_status(entry, :failed)

        fields =
          LifecycleLog.log_failure(
            :error,
            :agent_start_failed,
            entry,
            started_at,
            reason,
            operation: :restart,
            restart: true,
            desired_state: :running,
            actual_state: :failed
          )

        %{new_state | latest_failure: fields}
    end
  end

  defp find_orchestrator_by_ref(orchestrators, ref) do
    Enum.find_value(orchestrators, fn {id, entry} ->
      if entry.ref == ref, do: {id, entry}
    end)
  end

  defp find_orchestrator_by_agent_id(orchestrators, agent_id) do
    Enum.find(orchestrators, fn {_id, entry} -> Map.get(entry, :agent_id) == agent_id end)
  end

  defp generate_id do
    hex = :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)
    "orch_#{hex}"
  end

  defp reconcile_engine_instance_async(state),
    do: EngineInstanceSync.reconcile_async(state.orchestrators)

  defp incomplete_credential_refresh?(%{credential_refresh: {:incomplete, _reason}}), do: true
  defp incomplete_credential_refresh?(_metadata), do: false

  defp schedule_heartbeat(%{heartbeat_ms: ms} = state) when is_integer(ms) and ms > 0 do
    if state.heartbeat_ref, do: Process.cancel_timer(state.heartbeat_ref)
    ref = Process.send_after(self(), :heartbeat, ms)
    %{state | heartbeat_ref: ref}
  end

  defp schedule_heartbeat(state), do: state

  defp default_heartbeat_ms do
    Application.get_env(:symphony_elixir, :launcher_heartbeat_ms, @default_heartbeat_ms)
  end

  defp default_start_port do
    Application.get_env(:symphony_elixir, :launcher_start_port, 4000)
  end

  # The relay socket binds RELAY_SOCKET_PORT inside this same node. Orchestrator
  # ports increment from launcher_start_port (4000+), so skip the relay port when
  # allocating — otherwise a spawned orchestrator could fail to bind and the
  # agent's run (and its Codex work) would never start.
  defp next_orchestrator_port(candidate) do
    case reserved_relay_port() do
      ^candidate -> candidate + 1
      _ -> candidate
    end
  end

  defp reserved_relay_port do
    SymphonyElixirWeb.Endpoint.relay_socket_port_from_env()
  end

  defp default_state_dir do
    Application.get_env(
      :symphony_elixir,
      :launcher_state_dir,
      Path.expand("~/.symphony/launcher")
    )
  end
end
