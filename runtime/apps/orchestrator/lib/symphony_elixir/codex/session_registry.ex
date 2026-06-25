defmodule SymphonyElixir.Codex.SessionRegistry do
  @moduledoc """
  Keeps Codex app-server sessions warm for API-driven message input.
  """

  use GenServer

  alias SymphonyElixir.Codex.{AppServer, PortProtocol}
  alias SymphonyElixir.WorkItem

  @type session_id :: String.t()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @spec create_session(Path.t(), map()) :: {:ok, map()} | {:error, term()}
  def create_session(workspace, runner_config \\ %{}) do
    GenServer.call(__MODULE__, {:create_session, workspace, runner_config}, :infinity)
  end

  @spec send_message(session_id(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def send_message(session_id, prompt, issue \\ %{}) do
    GenServer.call(__MODULE__, {:send_message, session_id, prompt, issue}, :infinity)
  end

  @spec interrupt(session_id()) :: {:ok, map()} | {:error, term()}
  def interrupt(session_id) do
    GenServer.call(__MODULE__, {:interrupt, session_id}, :infinity)
  end

  @spec stop_session(session_id()) :: :ok | {:error, term()}
  def stop_session(session_id) do
    GenServer.call(__MODULE__, {:stop_session, session_id}, :infinity)
  end

  @impl true
  def init(_) do
    Process.flag(:trap_exit, true)
    {:ok, %{sessions: %{}}}
  end

  @impl true
  def handle_call({:create_session, workspace, runner_config}, _from, state) do
    session_id = "codex-session-" <> Ecto.UUID.generate()
    registry = self()

    opts = [
      runner_config: runner_config,
      on_message: fn message -> send(registry, {:codex_session_event, session_id, message}) end
    ]

    case AppServer.start_session(workspace, opts) do
      {:ok, session} ->
        session =
          session
          |> Map.put(:runner_config, runner_config)
          |> Map.put(:on_message, Keyword.fetch!(opts, :on_message))

        entry = %{
          session: session,
          task: nil,
          task_ref: nil,
          status: :idle,
          current_turn_id: nil,
          current_session_id: nil,
          events: []
        }

        reply = public_entry(session_id, entry)
        {:reply, {:ok, reply}, put_in(state, [:sessions, session_id], entry)}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:send_message, session_id, prompt, issue}, _from, state) do
    with {:ok, entry} <- fetch_entry(state, session_id),
         :ok <- ensure_idle(entry),
         {:ok, prompt} <- normalize_prompt(prompt) do
      parent = self()
      task = Task.Supervisor.async_nolink(SymphonyElixir.TaskSupervisor, fn -> run_turn(parent) end)
      true = Port.connect(entry.session.port, task.pid)

      issue = normalize_issue(issue, session_id)
      send(task.pid, {:run_turn, session_id, entry.session, prompt, issue})

      entry = %{entry | task: task.pid, task_ref: task.ref, status: :running, current_turn_id: nil, current_session_id: nil}
      state = put_in(state, [:sessions, session_id], entry)
      {:reply, {:ok, public_entry(session_id, entry)}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:interrupt, session_id}, _from, state) do
    with {:ok, entry} <- fetch_entry(state, session_id),
         {:ok, turn_id} <- active_turn(entry),
         :ok <- AppServer.interrupt_turn(entry.session, turn_id) do
      entry = %{entry | status: :interrupting}
      {:reply, {:ok, public_entry(session_id, entry)}, put_in(state, [:sessions, session_id], entry)}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:stop_session, session_id}, _from, state) do
    case Map.pop(state.sessions, session_id) do
      {nil, _sessions} ->
        {:reply, {:error, :session_not_found}, state}

      {entry, sessions} ->
        stop_entry(entry)
        {:reply, :ok, %{state | sessions: sessions}}
    end
  end

  @impl true
  def handle_info({_ref, {:turn_finished, session_id, result}}, state) do
    {:noreply, finish_turn(state, session_id, result)}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    case find_session_by_ref(state, ref) do
      {nil, _entry} ->
        {:noreply, state}

      {session_id, _entry} ->
        {:noreply, finish_turn(state, session_id, {:error, {:task_down, reason}})}
    end
  end

  def handle_info({:codex_session_event, session_id, message}, state) do
    case fetch_entry(state, session_id) do
      {:ok, entry} ->
        entry =
          entry
          |> append_event(message)
          |> maybe_mark_started(message)

        {:noreply, put_in(state, [:sessions, session_id], entry)}

      {:error, _} ->
        {:noreply, state}
    end
  end

  def handle_info({port, {:exit_status, _status}}, state) when is_port(port) do
    {:noreply, remove_session_by_port(state, port)}
  end

  def handle_info({:EXIT, port, _reason}, state) when is_port(port) do
    {:noreply, remove_session_by_port(state, port)}
  end

  def handle_info({port, {:data, {_line_state, chunk}}}, state) when is_port(port) do
    PortProtocol.log_non_json_stream_line(chunk, "idle session stream")
    {:noreply, state}
  end

  defp run_turn(registry) do
    receive do
      {:run_turn, session_id, session, prompt, issue} ->
        result = AppServer.send_message(session, prompt, issue, turn_opts(session))
        _ = Port.connect(session.port, registry)
        {:turn_finished, session_id, result}
    end
  end

  defp turn_opts(session) do
    opts = []
    opts = if session[:on_message], do: Keyword.put(opts, :on_message, session[:on_message]), else: opts
    opts = if session[:runner_config], do: Keyword.put(opts, :runner_config, session[:runner_config]), else: opts
    opts
  end

  defp fetch_entry(%{sessions: sessions}, session_id) do
    case Map.fetch(sessions, session_id) do
      {:ok, entry} -> {:ok, entry}
      :error -> {:error, :session_not_found}
    end
  end

  defp ensure_idle(%{status: status}) when status in [:idle, :completed, :failed], do: :ok
  defp ensure_idle(_entry), do: {:error, :turn_already_running}

  defp active_turn(%{status: status, current_turn_id: turn_id}) when status in [:running, :interrupting] and is_binary(turn_id),
    do: {:ok, turn_id}

  defp active_turn(_entry), do: {:error, :no_active_turn}

  defp normalize_prompt(prompt) when is_binary(prompt) do
    case String.trim(prompt) do
      "" -> {:error, :empty_prompt}
      trimmed -> {:ok, trimmed}
    end
  end

  defp normalize_prompt(_prompt), do: {:error, :invalid_prompt}

  defp normalize_issue(issue, session_id) when is_map(issue) do
    %WorkItem{
      id: Map.get(issue, "id") || Map.get(issue, :id) || session_id,
      identifier: Map.get(issue, "identifier") || Map.get(issue, :identifier) || session_id,
      title: Map.get(issue, "title") || Map.get(issue, :title) || "Streaming Codex input",
      description: Map.get(issue, "description") || Map.get(issue, :description) || "",
      state: Map.get(issue, "state") || Map.get(issue, :state) || "In Progress",
      url: Map.get(issue, "url") || Map.get(issue, :url),
      labels: Map.get(issue, "labels") || Map.get(issue, :labels) || []
    }
  end

  defp normalize_issue(_issue, session_id), do: normalize_issue(%{}, session_id)

  defp append_event(entry, message) do
    %{entry | events: [message | entry.events] |> Enum.take(50)}
  end

  defp maybe_mark_started(entry, %{event: :session_started, session_id: run_session_id, turn_id: turn_id}) do
    %{entry | status: :running, current_session_id: run_session_id, current_turn_id: turn_id}
  end

  defp maybe_mark_started(entry, _message), do: entry

  defp finish_turn(state, session_id, result) do
    case fetch_entry(state, session_id) do
      {:ok, entry} ->
        status =
          case result do
            {:ok, _} -> :completed
            {:error, _} -> :failed
          end

        entry = %{entry | status: status, task: nil, task_ref: nil, current_turn_id: nil, current_session_id: nil}
        put_in(state, [:sessions, session_id], entry)

      {:error, _} ->
        state
    end
  end

  defp find_session_by_ref(%{sessions: sessions}, ref) do
    Enum.find(sessions, {nil, nil}, fn {_session_id, entry} -> entry.task_ref == ref end)
  end

  defp remove_session_by_port(%{sessions: sessions} = state, port) do
    sessions =
      sessions
      |> Enum.reject(fn {_session_id, entry} -> entry.session.port == port end)
      |> Map.new()

    %{state | sessions: sessions}
  end

  defp stop_entry(%{task: task} = entry) when is_pid(task) do
    # The registry remains linked to ports it opened even while the connected
    # owner is the turn task, so close the port here and then clean up the task.
    _ = AppServer.stop_session(entry.session)
    Process.exit(task, :kill)
    :ok
  end

  defp stop_entry(%{session: session}) do
    AppServer.stop_session(session)
  end

  defp public_entry(session_id, entry) do
    %{
      session_id: session_id,
      thread_id: entry.session.thread_id,
      status: Atom.to_string(entry.status),
      current_turn_id: entry.current_turn_id,
      current_session_id: entry.current_session_id
    }
  end
end
