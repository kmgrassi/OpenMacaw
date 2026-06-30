defmodule SymphonyElixir.AgentIO do
  @moduledoc """
  Internal live agent I/O session layer.

  This module is the orchestrator-side boundary for the streaming agent I/O
  work. Platform endpoints can call it to attach to a live runner session,
  send user input, interrupt the active turn, and receive normalized runner
  events without owning runner processes directly.
  """

  alias SymphonyElixir.AgentIO.Session

  @registry SymphonyElixir.AgentIO.SessionRegistry
  @supervisor SymphonyElixir.AgentIO.SessionSupervisor
  @default_max_sessions 100

  @type session_key :: String.t()

  @doc """
  Ensures a live I/O session process exists for `session_key`.
  """
  @spec ensure_session(session_key(), keyword()) :: {:ok, pid()} | {:error, term()}
  def ensure_session(session_key, opts \\ []) when is_binary(session_key) do
    case lookup(session_key) do
      {:ok, pid} ->
        {:ok, pid}

      :error ->
        if active_session_count() >= max_sessions(opts) do
          {:error, :session_limit_exceeded}
        else
          child_opts = Keyword.put(opts, :session_key, session_key)

          case DynamicSupervisor.start_child(@supervisor, {Session, child_opts}) do
            {:ok, pid} -> {:ok, pid}
            {:error, {:already_started, pid}} -> {:ok, pid}
            {:error, {:shutdown, {:failed_to_start_child, _child, {:already_started, pid}}}} -> {:ok, pid}
            {:error, reason} -> {:error, reason}
          end
        end
    end
  end

  @doc """
  Subscribes `subscriber` to the continuous stream for `session_key`.

  The returned snapshot is a normalized view of the current runner session.
  """
  @spec subscribe(session_key(), pid(), keyword()) :: {:ok, map()} | {:error, term()}
  def subscribe(session_key, subscriber \\ self(), opts \\ [])
      when is_binary(session_key) and is_pid(subscriber) do
    with {:ok, pid} <- ensure_session(session_key, opts) do
      Session.subscribe(pid, subscriber)
    end
  end

  @doc """
  Sends a user message to the session as the next turn.
  """
  @spec send_message(session_key(), String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def send_message(session_key, message, opts \\ [])
      when is_binary(session_key) and is_binary(message) do
    with {:ok, pid} <- ensure_session(session_key, opts) do
      Session.send_message(pid, message)
    end
  end

  @doc """
  Interrupts the active turn and tears down the warm runner process.

  The durable session process stays registered, so the next message can restart
  the underlying runner session with the same orchestrator session key.
  """
  @spec interrupt(session_key()) :: :ok | {:error, term()}
  def interrupt(session_key) when is_binary(session_key) do
    with {:ok, pid} <- lookup(session_key) do
      Session.interrupt(pid)
    end
  end

  @doc """
  Returns live AgentIO process counts for diagnostics and tests.
  """
  @spec stats() :: %{active_sessions: non_neg_integer(), max_sessions: pos_integer()}
  def stats do
    %{active_sessions: active_session_count(), max_sessions: max_sessions([])}
  end

  defp active_session_count do
    case DynamicSupervisor.count_children(@supervisor) do
      %{active: active} when is_integer(active) and active >= 0 -> active
      _ -> 0
    end
  end

  defp max_sessions(opts) do
    case Keyword.get(opts, :max_sessions, Application.get_env(:symphony_elixir, :agent_io_max_sessions, @default_max_sessions)) do
      value when is_integer(value) and value > 0 -> value
      _ -> @default_max_sessions
    end
  end

  defp lookup(session_key) do
    case Registry.lookup(@registry, session_key) do
      [{pid, _value}] when is_pid(pid) -> if Process.alive?(pid), do: {:ok, pid}, else: :error
      [] -> :error
    end
  end
end
