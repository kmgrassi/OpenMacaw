defmodule SymphonyElixir.AgentIO.Session do
  @moduledoc false

  use GenServer

  require Logger

  alias SymphonyElixir.Runner.{CodingRunner, Contract}
  alias SymphonyElixir.WorkItem

  @registry SymphonyElixir.AgentIO.SessionRegistry
  @task_supervisor SymphonyElixir.TaskSupervisor
  @default_idle_timeout_ms :timer.minutes(5)

  @type state :: %{
          session_key: String.t(),
          runner: module(),
          config: map(),
          workspace: String.t() | nil,
          work_item: WorkItem.t(),
          runner_session: map() | nil,
          subscribers: MapSet.t(pid()),
          active_task: Task.t() | nil,
          active_turn_id: String.t() | nil,
          idle_timeout_ms: non_neg_integer(),
          idle_timer_ref: reference() | nil
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    session_key = Keyword.fetch!(opts, :session_key)
    GenServer.start_link(__MODULE__, opts, name: {:via, Registry, {@registry, session_key}})
  end

  @spec subscribe(pid(), pid()) :: {:ok, map()} | {:error, term()}
  def subscribe(pid, subscriber) when is_pid(pid) and is_pid(subscriber) do
    GenServer.call(pid, {:subscribe, subscriber})
  end

  @spec send_message(pid(), String.t()) :: {:ok, map()} | {:error, term()}
  def send_message(pid, message) when is_pid(pid) and is_binary(message) do
    GenServer.call(pid, {:send_message, message})
  end

  @spec interrupt(pid()) :: :ok | {:error, term()}
  def interrupt(pid) when is_pid(pid) do
    GenServer.call(pid, :interrupt)
  end

  @impl true
  def init(opts) do
    runner = Keyword.get(opts, :runner, SymphonyElixir.Runner.Codex)
    config = Keyword.get(opts, :config, %{})
    workspace = Keyword.get(opts, :workspace)

    state = %{
      session_key: Keyword.fetch!(opts, :session_key),
      runner: runner,
      config: config,
      workspace: workspace,
      work_item: Keyword.get(opts, :work_item, default_work_item(Keyword.fetch!(opts, :session_key))),
      runner_session: nil,
      subscribers: MapSet.new(),
      active_task: nil,
      active_turn_id: nil,
      idle_timeout_ms: Keyword.get(opts, :idle_timeout_ms, @default_idle_timeout_ms),
      idle_timer_ref: nil
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:subscribe, subscriber}, _from, state) do
    state = cancel_idle_timer(state)

    case ensure_runner_session(state) do
      {:ok, state} ->
        state = %{state | subscribers: MapSet.put(state.subscribers, subscriber)}
        {:reply, {:ok, session_snapshot(state)}, state}

      {:error, reason, state} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:send_message, _message}, _from, %{active_task: %Task{}} = state) do
    {:reply, {:error, :turn_already_active}, state}
  end

  def handle_call({:send_message, message}, _from, state) do
    state = cancel_idle_timer(state)

    with {:ok, state} <- ensure_runner_session_result(state) do
      parent = self()
      turn_id = make_turn_id()
      on_message = event_callback(state.runner_session, parent, turn_id)

      task =
        Task.Supervisor.async_nolink(@task_supervisor, fn ->
          CodingRunner.send_input(state.runner, state.runner_session, message, state.work_item, on_message: on_message)
        end)

      event = %{
        event: :turn_started,
        session_key: state.session_key,
        turn_id: turn_id,
        payload: %{
          "sessionKey" => state.session_key,
          "turnId" => turn_id
        }
      }

      state =
        %{state | active_task: task, active_turn_id: turn_id}
        |> broadcast(event)

      {:reply, {:ok, %{session_key: state.session_key, turn_id: turn_id}}, state}
    else
      {:error, reason, state} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:interrupt, _from, %{active_task: nil} = state) do
    {:reply, {:error, :no_active_turn}, schedule_idle_timeout(state)}
  end

  def handle_call(:interrupt, _from, state) do
    case CodingRunner.interrupt(state.runner, state.runner_session, []) do
      :ok ->
        :ok

      {:error, :interrupt_not_supported} ->
        kill_active_task(state)

      {:error, _reason} ->
        kill_active_task(state)
    end

    event = %{
      event: :turn_ended_with_error,
      session_key: state.session_key,
      turn_id: state.active_turn_id,
      payload: %{
        "sessionKey" => state.session_key,
        "turnId" => state.active_turn_id,
        "reason" => "interrupted"
      }
    }

    state =
      state
      |> stop_runner_session()
      |> clear_active_turn()
      |> broadcast(event)

    {:reply, :ok, schedule_idle_timeout(state)}
  end

  @impl true
  def handle_info({:runner_event, turn_id, message}, state) do
    {:noreply, broadcast(state, Map.put(message, :turn_id, turn_id))}
  end

  def handle_info({ref, result}, %{active_task: %Task{ref: ref}} = state) do
    Process.demonitor(ref, [:flush])

    event =
      case Contract.normalize_result(result) do
        {:ok, normalized} ->
          %{
            event: :turn_completed,
            session_key: state.session_key,
            turn_id: state.active_turn_id,
            payload: Map.put(normalized, :session_key, state.session_key)
          }

        {:error, normalized} ->
          %{
            event: :turn_ended_with_error,
            session_key: state.session_key,
            turn_id: state.active_turn_id,
            payload: Map.put(normalized, :session_key, state.session_key)
          }
      end

    state =
      state
      |> clear_active_turn()
      |> broadcast(event)
      |> schedule_idle_timeout()

    {:noreply, state}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{active_task: %Task{ref: ref}} = state) do
    event = %{
      event: :turn_ended_with_error,
      session_key: state.session_key,
      turn_id: state.active_turn_id,
      payload: %{
        "sessionKey" => state.session_key,
        "turnId" => state.active_turn_id,
        "reason" => inspect(reason)
      }
    }

    state =
      state
      |> clear_active_turn()
      |> stop_runner_session()
      |> broadcast(event)
      |> schedule_idle_timeout()

    {:noreply, state}
  end

  def handle_info({:timeout, ref, :idle_timeout}, %{idle_timer_ref: ref, active_task: nil} = state) do
    {:noreply, %{stop_runner_session(state) | idle_timer_ref: nil}}
  end

  def handle_info({:timeout, _ref, :idle_timeout}, state), do: {:noreply, state}

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    _ = stop_runner_session(state)
    :ok
  end

  defp ensure_runner_session_result(state) do
    case ensure_runner_session(state) do
      {:ok, state} -> {:ok, state}
      {:error, reason, state} -> {:error, reason, state}
    end
  end

  defp ensure_runner_session(%{runner_session: session} = state) when is_map(session) do
    {:ok, state}
  end

  defp ensure_runner_session(state) do
    case state.runner.start_session(state.config, state.workspace) do
      {:ok, runner_session} ->
        state = %{state | runner_session: runner_session}
        broadcast(state, %{event: :session_started, session_key: state.session_key, payload: session_snapshot(state)})
        {:ok, state}

      {:error, reason} ->
        event = %{event: :startup_failed, session_key: state.session_key, payload: %{"reason" => inspect(reason)}}
        state = broadcast(state, event)
        {:error, reason, state}
    end
  end

  defp event_callback(session, parent, turn_id) do
    existing = Map.get(session, :on_message)

    fn message ->
      if is_function(existing, 1), do: existing.(message)
      send(parent, {:runner_event, turn_id, message})
      :ok
    end
  end

  defp broadcast(state, message) do
    event =
      message
      |> Map.put_new(:timestamp, DateTime.utc_now())
      |> normalize_event()

    Enum.each(state.subscribers, fn subscriber ->
      send(subscriber, {:agent_io_event, state.session_key, event})
    end)

    state
  end

  defp normalize_event(message) do
    case Contract.normalize_event(message) do
      {:ok, event} ->
        event

      {:error, reason} ->
        Logger.warning("AgentIO dropped unknown runner event=#{inspect(reason)}")
        %{event: :notification, timestamp: DateTime.utc_now(), payload: %{"droppedEvent" => inspect(reason)}}
    end
  end

  defp session_snapshot(state) do
    state.runner_session
    |> Kernel.||(%{})
    |> Contract.normalize_session(state.runner)
    |> Map.put(:session_key, state.session_key)
    |> Map.put(:active_turn_id, state.active_turn_id)
  end

  defp clear_active_turn(state) do
    %{state | active_task: nil, active_turn_id: nil}
  end

  defp stop_runner_session(%{runner_session: nil} = state), do: state

  defp stop_runner_session(state) do
    _ = CodingRunner.stop_session(state.runner, state.runner_session)
    %{state | runner_session: nil}
  end

  defp kill_active_task(%{active_task: %Task{pid: pid}}) when is_pid(pid) do
    Process.exit(pid, :kill)
    :ok
  end

  defp kill_active_task(_state), do: :ok

  defp schedule_idle_timeout(%{active_task: %Task{}} = state), do: state
  defp schedule_idle_timeout(%{idle_timeout_ms: 0} = state), do: state

  defp schedule_idle_timeout(state) do
    state = cancel_idle_timer(state)
    ref = :erlang.start_timer(state.idle_timeout_ms, self(), :idle_timeout)
    %{state | idle_timer_ref: ref}
  end

  defp cancel_idle_timer(%{idle_timer_ref: ref} = state) when is_reference(ref) do
    :erlang.cancel_timer(ref)
    %{state | idle_timer_ref: nil}
  end

  defp cancel_idle_timer(state), do: state

  defp default_work_item(session_key) do
    %WorkItem{
      id: session_key,
      identifier: session_key,
      title: "Streaming Agent Session",
      source: "agent_io"
    }
  end

  defp make_turn_id do
    System.unique_integer([:positive, :monotonic])
    |> Integer.to_string()
    |> then(&"turn-#{&1}")
  end
end
