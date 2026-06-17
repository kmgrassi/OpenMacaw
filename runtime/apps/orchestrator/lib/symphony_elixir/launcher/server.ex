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
  alias SymphonyElixir.Launcher.GatewayConfig
  alias SymphonyElixir.Launcher.LifecycleLog
  alias SymphonyElixir.Launcher.StateManager
  alias SymphonyElixir.Orchestrator.Starter
  alias SymphonyElixir.Planning.PlanHandoff
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.Time

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

  @spec workspace_active_agents_count(String.t(), keyword()) :: {:ok, non_neg_integer()} | {:error, term()}
  def workspace_active_agents_count(workspace_id, opts \\ []) when is_binary(workspace_id) and workspace_id != "" do
    exclude_pid = Keyword.get(opts, :exclude_pid)
    GenServer.call(__MODULE__, {:workspace_active_agents_count, workspace_id, exclude_pid}, 15_000)
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
          runtime_log_fields(entry, LifecycleLog.start_fields(entry, %{desired_state: :stopped}))
        )

        do_stop_orchestrator(entry)

        stopped_entry = %{entry | status: :stopped, pid: nil, ref: nil}
        new_state = %{state | orchestrators: Map.delete(state.orchestrators, id)}
        StateManager.persist(new_state)
        EngineInstanceSync.update_status(stopped_entry, :stopped)

        RuntimeLog.log(
          :info,
          :agent_stopped,
          runtime_log_fields(
            stopped_entry,
            LifecycleLog.completion_fields(stopped_entry, started_at, %{desired_state: :stopped})
          )
        )

        {:reply, {:ok, serialize_entry(stopped_entry)}, new_state}
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
      |> Enum.map(&serialize_entry/1)

    {:reply, orchestrators, state}
  end

  @impl true
  def handle_call({:workspace_active_agents_count, workspace_id, exclude_pid}, _from, state) do
    {:reply, do_workspace_active_agents_count(state, workspace_id, exclude_pid), state}
  end

  @impl true
  def handle_call({:get_orchestrator, id}, _from, state) do
    case Map.get(state.orchestrators, id) do
      nil -> {:reply, {:error, :not_found}, state}
      entry -> {:reply, {:ok, serialize_entry(entry)}, state}
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
        trace_id = trace_id_from_config(config)

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

            entry = %{
              id: id,
              pid: pid,
              ref: ref,
              port: port,
              config: config,
              started_at: DateTime.utc_now(),
              status: :running,
              agent_id: agent.id,
              type: Agent.kind(agent),
              agent_name: agent.name,
              workspace_id: agent.workspace_id,
              project_id: agent.project_id,
              restart_count: 0
            }

            new_state = %{
              state
              | orchestrators: Map.put(state.orchestrators, id, entry),
                next_port: port + 1
            }

            StateManager.persist(new_state)
            EngineInstanceSync.record_state(entry, :running)
            record_gateway_apply(resolution, :ok, id)

            RuntimeLog.log(
              :info,
              :agent_started,
              runtime_log_fields(
                entry,
                LifecycleLog.completion_fields(entry, started_at, %{trace_id: trace_id})
                |> Map.merge(ExecutionProfile.log_fields(profile))
              )
            )

            {:reply, {:ok, serialize_entry(entry)}, new_state}

          {:error, reason} = error ->
            record_gateway_apply(resolution, :error, nil, error: format_error(reason))

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
            %{agent_id: agent.id, workspace_id: agent.workspace_id, desired_state: :running, actual_state: :failed},
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
          incomplete_credential_refresh?(metadata) and config_has_resolved_credentials?(entry.config) ->
            RuntimeLog.log(:warning, :agent_start_credential_refresh_incomplete_reusing_runtime, %{
              agent_id: agent.id,
              workspace_id: agent.workspace_id,
              run_id: entry.id,
              port: entry.port,
              reason: inspect(Map.get(metadata, :credential_refresh)),
              retryable: true
            })

            {:reply, {:ok, serialize_entry(entry, true)}, state}

          equivalent_runtime_config?(entry.config, config) ->
            {:reply, {:ok, serialize_entry(entry, true)}, state}

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

        {:reply, {:ok, serialize_entry(entry, true)}, state}
    end
  end

  defp restart_agent_orchestrator(%Agent{} = agent, entry, state, config, resolution) do
    started_at = System.monotonic_time(:millisecond)
    trace_id = trace_id_from_config(config)
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

        updated_entry = %{
          entry
          | pid: pid,
            ref: ref,
            config: config,
            started_at: DateTime.utc_now(),
            status: :running,
            type: Agent.kind(agent),
            agent_name: agent.name,
            workspace_id: agent.workspace_id,
            project_id: agent.project_id,
            restart_count: Map.get(entry, :restart_count, 0) + 1
        }

        new_state = %{state | orchestrators: Map.put(state.orchestrators, entry.id, updated_entry)}
        StateManager.persist(new_state)
        EngineInstanceSync.record_state(updated_entry, :running)
        record_gateway_apply(resolution, :ok, entry.id)

        RuntimeLog.log(
          :info,
          :agent_restarted_for_config_change,
          runtime_log_fields(
            updated_entry,
            LifecycleLog.completion_fields(updated_entry, started_at, %{trace_id: trace_id})
            |> Map.merge(ExecutionProfile.log_fields(profile))
          )
        )

        {:reply, {:ok, serialize_entry(updated_entry, false)}, new_state}

      {:error, reason} = error ->
        record_gateway_apply(resolution, :error, entry.id, error: format_error(reason))
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

        new_state = %{state | orchestrators: Map.delete(state.orchestrators, entry.id), latest_failure: fields}
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
    trace_id = trace_id_from_config(config)

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

        entry = %{
          id: id,
          pid: pid,
          ref: ref,
          port: port,
          config: config,
          started_at: DateTime.utc_now(),
          status: :running,
          restart_count: 0
        }

        new_state = %{
          state
          | orchestrators: Map.put(state.orchestrators, id, entry),
            next_port: port + 1
        }

        StateManager.persist(new_state)

        reply = serialize_entry(entry)

        RuntimeLog.log(
          :info,
          :agent_started,
          runtime_log_fields(
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

        updated_entry = %{
          entry
          | pid: new_pid,
            ref: new_ref,
            status: :running,
            restart_count: Map.get(entry, :restart_count, 0) + 1
        }

        new_orchestrators = Map.put(state.orchestrators, id, updated_entry)
        new_state = %{state | orchestrators: new_orchestrators}
        StateManager.persist(new_state)
        EngineInstanceSync.update_status(updated_entry, :running)

        Logger.info("Orchestrator #{id} restarted successfully on port #{entry.port}")

        RuntimeLog.log(
          :info,
          :agent_started,
          runtime_log_fields(
            updated_entry,
            LifecycleLog.completion_fields(updated_entry, started_at, %{restart: true, desired_state: :running})
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

  defp serialize_entry(entry, reused \\ false) do
    %{
      id: entry.id,
      port: entry.port,
      config: entry.config,
      started_at: format_datetime(entry.started_at),
      status: to_string(entry.status),
      reused: reused
    }
    |> maybe_put(:agent_id, Map.get(entry, :agent_id))
    |> maybe_put(:type, Map.get(entry, :type))
    |> maybe_put(:agent_name, Map.get(entry, :agent_name))
    |> maybe_put(:workspace_id, Map.get(entry, :workspace_id))
    |> maybe_put(:project_id, Map.get(entry, :project_id))
    |> maybe_put(:restart_count, Map.get(entry, :restart_count))
  end

  defp format_datetime(value), do: Time.to_iso8601(value) || to_string(value)

  defp reconcile_engine_instance_async(state), do: EngineInstanceSync.reconcile_async(state.orchestrators)

  defp equivalent_runtime_config?(left, right) do
    comparable_runtime_config(left) == comparable_runtime_config(right)
  end

  defp incomplete_credential_refresh?(%{credential_refresh: {:incomplete, _reason}}), do: true
  defp incomplete_credential_refresh?(_metadata), do: false

  defp config_has_resolved_credentials?(config) when is_map(config) do
    config = normalize_config_value(config)

    config_has_credentials_map?(config) or config_has_tracker_api_key?(config)
  end

  defp config_has_resolved_credentials?(_config), do: false

  defp config_has_credentials_map?(config) do
    case Map.get(config, "credentials") do
      credentials when is_map(credentials) -> map_size(credentials) > 0
      _ -> false
    end
  end

  defp config_has_tracker_api_key?(config) do
    case get_in(config, ["tracker", "api_key"]) do
      value when is_binary(value) -> value != ""
      _ -> false
    end
  end

  defp comparable_runtime_config(config) when is_map(config) do
    config
    |> normalize_config_value()
    |> drop_runtime_config_volatiles()
  end

  defp comparable_runtime_config(config), do: config

  defp normalize_config_value(value) when is_map(value) do
    Map.new(value, fn {key, nested} -> {to_string(key), normalize_config_value(nested)} end)
  end

  defp normalize_config_value(value) when is_list(value), do: Enum.map(value, &normalize_config_value/1)
  defp normalize_config_value(value), do: value

  defp drop_runtime_config_volatiles(config) when is_map(config) do
    config
    |> Map.delete("trace_id")
    |> update_in(["runtime"], fn
      runtime when is_map(runtime) -> Map.delete(runtime, "trace_id")
      runtime -> runtime
    end)
  end

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

  defp trace_id_from_config(config) when is_map(config) do
    RuntimeLog.ensure_trace_id(
      Map.get(config, "trace_id") ||
        Map.get(config, :trace_id) ||
        get_in(config, ["runtime", "trace_id"]) ||
        get_in(config, [:runtime, :trace_id])
    )
  end

  defp trace_id_from_config(_config), do: RuntimeLog.ensure_trace_id(nil)

  defp runtime_log_fields(entry, extra) do
    %{
      agent_id: Map.get(entry, :agent_id),
      workspace_id: Map.get(entry, :workspace_id),
      run_id: Map.get(entry, :id),
      port: Map.get(entry, :port),
      status: Map.get(entry, :status),
      agent_type: Map.get(entry, :type),
      host: EngineInstanceSync.host(),
      desired_state: Map.get(entry, :desired_state),
      actual_state: Map.get(entry, :status),
      restart_count: Map.get(entry, :restart_count)
    }
    |> Map.merge(ExecutionProfile.log_fields(get_in(entry, [:config, "execution_profile"])))
    |> Map.merge(extra)
  end

  defp record_gateway_apply(resolution, status, broker_instance_id, opts \\ [])

  defp record_gateway_apply(nil, _status, _broker_instance_id, _opts), do: :ok

  defp record_gateway_apply(%{scope_type: scope_type, scope_id: scope_id} = resolution, :ok, broker_instance_id, _opts) do
    case GatewayConfig.record_apply_state(scope_type, scope_id, :ok,
           last_applied_hash: Map.get(resolution, :config_hash),
           last_applied_version: Map.get(resolution, :version),
           broker_instance_id: broker_instance_id
         ) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to record gateway_config_state ok for #{scope_type}/#{scope_id}: #{inspect(reason)}")

        :ok
    end
  end

  defp record_gateway_apply(%{scope_type: scope_type, scope_id: scope_id}, :error, broker_instance_id, opts) do
    error_message = Keyword.get(opts, :error)

    case GatewayConfig.record_apply_state(scope_type, scope_id, :error,
           broker_instance_id: broker_instance_id,
           last_apply_error: error_message
         ) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("Failed to record gateway_config_state error for #{scope_type}/#{scope_id}: #{inspect(reason)}")

        :ok
    end
  end

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error({:invalid_agent_config, message, _details}) when is_binary(message), do: message
  defp format_error(reason), do: inspect(reason)

  defp do_workspace_active_agents_count(state, workspace_id, exclude_pid) when is_binary(workspace_id) do
    state.orchestrators
    |> Map.values()
    |> Enum.filter(&workspace_count_entry?(&1, workspace_id, exclude_pid))
    |> Enum.reduce_while({:ok, 0}, fn entry, {:ok, count} ->
      case running_agents_for_entry(entry, state.snapshotter) do
        {:ok, running_count} ->
          {:cont, {:ok, count + running_count}}

        {:error, reason} ->
          {:halt, {:error, {:workspace_runtime_unavailable, Map.get(entry, :id), reason}}}
      end
    end)
  end

  defp do_workspace_active_agents_count(_state, _workspace_id, _exclude_pid), do: {:error, :invalid_workspace_id}

  defp workspace_count_entry?(entry, workspace_id, exclude_pid) do
    Map.get(entry, :workspace_id) == workspace_id and Map.get(entry, :status) == :running and
      Map.get(entry, :pid) != exclude_pid
  end

  defp running_agents_for_entry(%{pid: pid}, _snapshotter) when not is_pid(pid),
    do: {:error, :runtime_unavailable}

  defp running_agents_for_entry(%{pid: pid}, snapshotter) when is_function(snapshotter, 2) do
    case snapshotter.(pid, 1_000) do
      %{running: running} when is_list(running) ->
        {:ok, length(running)}

      :timeout ->
        {:error, :timeout}

      :unavailable ->
        {:error, :unavailable}

      other ->
        {:error, {:invalid_snapshot, other}}
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
