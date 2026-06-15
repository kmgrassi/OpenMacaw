defmodule SymphonyElixir.Gateway.SessionStore do
  @moduledoc """
  In-memory session and run registry for the websocket gateway.
  """

  use GenServer

  @type scope :: %{
          agent_id: String.t(),
          workspace_id: String.t(),
          session_key: String.t(),
          user_id: String.t()
        }

  @type session :: %{
          key: String.t(),
          id: String.t(),
          agent_id: String.t(),
          workspace_id: String.t(),
          user_id: String.t(),
          kind: String.t(),
          label: String.t(),
          display_name: String.t(),
          surface: String.t(),
          updated_at: integer(),
          model: String.t() | nil,
          messages: [map()],
          input_tokens: non_neg_integer(),
          output_tokens: non_neg_integer(),
          total_tokens: non_neg_integer()
        }

  @type run :: %{
          id: String.t(),
          session_key: String.t(),
          owner_pid: pid(),
          task_pid: pid() | nil,
          monitor_ref: reference() | nil,
          started_at: integer(),
          assistant_buffer: String.t()
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec ensure_session(scope(), keyword()) :: {:ok, session()}
  def ensure_session(scope, opts \\ []) do
    GenServer.call(__MODULE__, {:ensure_session, scope, opts})
  end

  @spec list_sessions(keyword()) :: [session()]
  def list_sessions(opts \\ []) do
    GenServer.call(__MODULE__, {:list_sessions, opts})
  end

  @spec get_messages(String.t()) :: [map()]
  def get_messages(session_key) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:get_messages, session_key})
  end

  @spec append_user_message(scope(), String.t()) :: :ok
  def append_user_message(scope, message) when is_map(scope) and is_binary(message) do
    GenServer.call(__MODULE__, {:append_user_message, scope, message})
  end

  @spec start_run(scope() | String.t(), String.t(), pid()) ::
          {:ok, %{session: session(), run: run()}} | {:error, term()}
  def start_run(%{session_key: session_key}, run_id, owner_pid)
      when is_binary(session_key) and is_binary(run_id) and is_pid(owner_pid) do
    GenServer.call(__MODULE__, {:start_run, session_key, run_id, owner_pid})
  end

  def start_run(session_key, run_id, owner_pid)
      when is_binary(session_key) and is_binary(run_id) and is_pid(owner_pid) do
    GenServer.call(__MODULE__, {:start_run, session_key, run_id, owner_pid})
  end

  @spec attach_run(String.t(), pid()) :: {:ok, run()} | {:error, term()}
  def attach_run(run_id, task_pid) when is_binary(run_id) and is_pid(task_pid) do
    GenServer.call(__MODULE__, {:attach_run, run_id, task_pid})
  end

  @spec append_delta(String.t(), String.t()) :: :ok
  def append_delta(run_id, delta) when is_binary(run_id) and is_binary(delta) do
    GenServer.cast(__MODULE__, {:append_delta, run_id, delta})
  end

  @spec complete_run(String.t(), keyword()) :: {:ok, session() | nil}
  def complete_run(run_id, opts \\ []) when is_binary(run_id) do
    GenServer.call(__MODULE__, {:complete_run, run_id, opts})
  end

  @spec fail_run(String.t()) :: {:ok, session() | nil}
  def fail_run(run_id) when is_binary(run_id) do
    GenServer.call(__MODULE__, {:fail_run, run_id})
  end

  @spec abort_run(String.t(), String.t() | nil) :: {:ok, session() | nil} | {:error, term()}
  def abort_run(session_key, run_id \\ nil) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:abort_run, session_key, run_id})
  end

  @spec reset_session(String.t()) :: {:ok, session()} | {:error, term()}
  def reset_session(session_key) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:reset_session, session_key})
  end

  @spec delete_session(String.t()) :: :ok
  def delete_session(session_key) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:delete_session, session_key})
  end

  @spec usage_snapshot() :: map()
  def usage_snapshot do
    GenServer.call(__MODULE__, :usage_snapshot)
  end

  @impl true
  def init(_opts) do
    {:ok, %{sessions: %{}, runs: %{}, monitors: %{}}}
  end

  @impl true
  def handle_call({:ensure_session, scope, opts}, _from, state) do
    {session, state} = upsert_session(state, scope, opts)
    {:reply, {:ok, session}, state}
  end

  def handle_call({:list_sessions, opts}, _from, state) do
    limit = Keyword.get(opts, :limit, 50)

    sessions =
      state.sessions
      |> Map.values()
      |> Enum.sort_by(& &1.updated_at, :desc)
      |> Enum.take(limit)

    {:reply, sessions, state}
  end

  def handle_call({:get_messages, session_key}, _from, state) do
    messages =
      state.sessions
      |> Map.get(session_key, %{messages: []})
      |> Map.get(:messages, [])

    {:reply, messages, state}
  end

  def handle_call({:append_user_message, scope, message}, _from, state) do
    {session, state} = upsert_session(state, scope, [])

    updated =
      append_message(session, %{
        "role" => "user",
        "content" => message,
        "timestamp" => now_ms(),
        "user_id" => scope.user_id
      })

    {:reply, :ok, put_session(state, updated)}
  end

  def handle_call({:start_run, session_key, run_id, owner_pid}, _from, state) do
    case Map.get(state.sessions, session_key) do
      nil ->
        {:reply, {:error, :session_not_found}, state}

      session ->
        if Enum.any?(state.runs, fn {_id, run} -> run.session_key == session_key end) do
          {:reply, {:error, :run_already_active}, state}
        else
          run = %{
            id: run_id,
            session_key: session_key,
            owner_pid: owner_pid,
            task_pid: nil,
            monitor_ref: nil,
            started_at: now_ms(),
            assistant_buffer: ""
          }

          new_state = put_in(state, [:runs, run_id], run)
          {:reply, {:ok, %{session: session, run: run}}, new_state}
        end
    end
  end

  def handle_call({:attach_run, run_id, task_pid}, _from, state) do
    case Map.get(state.runs, run_id) do
      nil ->
        {:reply, {:error, :run_not_found}, state}

      run ->
        monitor_ref = Process.monitor(task_pid)
        updated_run = %{run | task_pid: task_pid, monitor_ref: monitor_ref}

        new_state =
          state
          |> put_in([:runs, run_id], updated_run)
          |> put_in([:monitors, monitor_ref], run_id)

        {:reply, {:ok, updated_run}, new_state}
    end
  end

  def handle_call({:complete_run, run_id, opts}, _from, state) do
    case Map.get(state.runs, run_id) do
      nil ->
        {:reply, {:ok, nil}, state}

      run ->
        state = demonitor_run(state, run)

        assistant_text =
          final_assistant_text(run.assistant_buffer, Keyword.get(opts, :assistant_fallback))

        case Map.get(state.sessions, run.session_key) do
          nil ->
            {:reply, {:ok, nil}, remove_run(state, run_id)}

          session ->
            session =
              if assistant_text == "" do
                touch_session(session)
                |> maybe_put(:model, Keyword.get(opts, :model))
              else
                session
                |> append_message(%{
                  "role" => "assistant",
                  "content" => assistant_text,
                  "timestamp" => now_ms()
                })
                |> maybe_put_usage(opts)
                |> maybe_put(:model, Keyword.get(opts, :model))
              end

            state = state |> put_session(session) |> remove_run(run_id)
            {:reply, {:ok, session}, state}
        end
    end
  end

  def handle_call({:fail_run, run_id}, _from, state) do
    case Map.get(state.runs, run_id) do
      nil ->
        {:reply, {:ok, nil}, state}

      run ->
        state = state |> demonitor_run(run) |> remove_run(run_id)
        {:reply, {:ok, Map.get(state.sessions, run.session_key)}, state}
    end
  end

  def handle_call({:abort_run, session_key, run_id}, _from, state) do
    run =
      Enum.find_value(state.runs, fn {id, candidate} ->
        if candidate.session_key == session_key and (is_nil(run_id) or run_id == id),
          do: candidate,
          else: nil
      end)

    case run do
      nil ->
        {:reply, {:error, :run_not_found}, state}

      %{task_pid: task_pid} = run ->
        if is_pid(task_pid), do: Process.exit(task_pid, :kill)
        session = Map.get(state.sessions, run.session_key)
        {:reply, {:ok, session}, state}
    end
  end

  def handle_call({:reset_session, session_key}, _from, state) do
    case Map.get(state.sessions, session_key) do
      nil ->
        {:reply, {:error, :session_not_found}, state}

      session ->
        reset = %{
          session
          | messages: [],
            updated_at: now_ms(),
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
        }

        {:reply, {:ok, reset}, put_session(state, reset)}
    end
  end

  def handle_call({:delete_session, session_key}, _from, state) do
    run_ids =
      state.runs
      |> Enum.filter(fn {_run_id, run} -> run.session_key == session_key end)
      |> Enum.map(fn {run_id, _run} -> run_id end)

    state =
      Enum.reduce(run_ids, state, fn run_id, acc ->
        case Map.get(acc.runs, run_id) do
          nil ->
            acc

          run ->
            if is_pid(run.task_pid), do: Process.exit(run.task_pid, :kill)
            # Killing the task and demonitor-flushing means no :DOWN and no
            # subsequent completion will reach the owner socket, so tell it
            # the run is over here. Otherwise the client's send lifecycle
            # never unwinds and its composer spins forever.
            if is_pid(run.owner_pid),
              do: send(run.owner_pid, {:gateway_runner_aborted, session_key, run_id})

            acc |> demonitor_run(run) |> remove_run(run_id)
        end
      end)

    {:reply, :ok, %{state | sessions: Map.delete(state.sessions, session_key)}}
  end

  def handle_call(:usage_snapshot, _from, state) do
    sessions = Map.values(state.sessions)

    totals =
      Enum.reduce(
        sessions,
        %{input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0.0},
        fn session, acc ->
          %{
            input: acc.input + session.input_tokens,
            output: acc.output + session.output_tokens,
            cacheRead: acc.cacheRead,
            cacheWrite: acc.cacheWrite,
            totalTokens: acc.totalTokens + session.total_tokens,
            totalCost: acc.totalCost
          }
        end
      )

    payload = %{
      updatedAt: now_ms(),
      startDate: Date.utc_today() |> Date.to_iso8601(),
      endDate: Date.utc_today() |> Date.to_iso8601(),
      totals: totals,
      aggregates: %{
        messages: %{
          total: Enum.reduce(sessions, 0, fn session, acc -> acc + length(session.messages) end),
          user:
            Enum.reduce(sessions, 0, fn session, acc ->
              acc + count_role(session.messages, "user")
            end),
          assistant:
            Enum.reduce(sessions, 0, fn session, acc ->
              acc + count_role(session.messages, "assistant")
            end),
          toolCalls: 0,
          errors: 0
        },
        byModel:
          sessions
          |> Enum.group_by(&(&1.model || "codex"))
          |> Enum.map(fn {model, rows} ->
            total_tokens = Enum.reduce(rows, 0, fn row, acc -> acc + row.total_tokens end)

            %{
              provider: "openai",
              model: model,
              count: length(rows),
              totals: %{
                input: Enum.reduce(rows, 0, fn row, acc -> acc + row.input_tokens end),
                output: Enum.reduce(rows, 0, fn row, acc -> acc + row.output_tokens end),
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: total_tokens,
                totalCost: 0.0
              }
            }
          end),
        daily: []
      }
    }

    {:reply, payload, state}
  end

  @impl true
  def handle_cast({:append_delta, run_id, delta}, state) do
    state =
      update_in(state, [:runs, run_id], fn
        nil -> nil
        run -> %{run | assistant_buffer: run.assistant_buffer <> delta}
      end)

    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    case Map.pop(state.monitors, ref) do
      {nil, monitors} ->
        {:noreply, %{state | monitors: monitors}}

      {run_id, monitors} ->
        run = Map.get(state.runs, run_id)
        state = %{state | monitors: monitors}

        case {run, reason} do
          {nil, _reason} ->
            {:noreply, state}

          {_run, :normal} ->
            {:noreply, put_in(state, [:runs, run_id, :monitor_ref], nil)}

          {%{owner_pid: owner_pid} = run, shutdown_reason} ->
            if is_pid(owner_pid) do
              send(owner_pid, {:gateway_runner_down, run.session_key, run_id, shutdown_reason})
            end

            {:noreply, %{state | runs: Map.delete(state.runs, run_id)}}
        end
    end
  end

  defp upsert_session(state, scope, opts) do
    key = scope.session_key

    session =
      case Map.get(state.sessions, key) do
        nil ->
          %{
            key: key,
            id: key,
            agent_id: scope.agent_id,
            workspace_id: scope.workspace_id,
            user_id: scope.user_id,
            kind: "chat",
            label: Keyword.get(opts, :label, key),
            display_name: Keyword.get(opts, :display_name, Keyword.get(opts, :label, key)),
            surface: "webchat",
            updated_at: now_ms(),
            model: Keyword.get(opts, :model),
            messages: [],
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
          }

        existing ->
          existing
          |> Map.put(:updated_at, now_ms())
          |> Map.put(:user_id, scope.user_id)
          |> maybe_put(:label, Keyword.get(opts, :label))
          |> maybe_put(:display_name, Keyword.get(opts, :display_name))
          |> maybe_put(:model, Keyword.get(opts, :model))
      end

    {session, put_session(state, session)}
  end

  defp put_session(state, session) do
    put_in(state, [:sessions, session.key], session)
  end

  defp append_message(session, message) do
    %{session | messages: [message | session.messages], updated_at: now_ms()}
  end

  defp touch_session(session), do: %{session | updated_at: now_ms()}

  defp final_assistant_text(buffer, fallback) do
    case String.trim(buffer || "") do
      "" -> normalize_fallback_text(fallback)
      text -> text
    end
  end

  defp normalize_fallback_text(text) when is_binary(text), do: String.trim(text)
  defp normalize_fallback_text(_text), do: ""

  defp maybe_put(session, _key, nil), do: session
  defp maybe_put(session, key, value), do: Map.put(session, key, value)

  defp maybe_put_usage(session, opts) do
    usage = Keyword.get(opts, :usage, %{})
    input = parse_int(Map.get(usage, "input_tokens") || Map.get(usage, :input_tokens))
    output = parse_int(Map.get(usage, "output_tokens") || Map.get(usage, :output_tokens))
    total = parse_int(Map.get(usage, "total_tokens") || Map.get(usage, :total_tokens))

    %{
      session
      | input_tokens: session.input_tokens + input,
        output_tokens: session.output_tokens + output,
        total_tokens: session.total_tokens + max(total, input + output)
    }
  end

  defp demonitor_run(state, %{monitor_ref: ref}) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    %{state | monitors: Map.delete(state.monitors, ref)}
  end

  defp demonitor_run(state, _run), do: state

  defp remove_run(state, run_id), do: %{state | runs: Map.delete(state.runs, run_id)}

  defp count_role(messages, role) do
    Enum.count(messages, fn message -> Map.get(message, "role") == role end)
  end

  defp parse_int(value) when is_integer(value), do: value
  defp parse_int(_value), do: 0

  defp now_ms, do: System.system_time(:millisecond)
end
