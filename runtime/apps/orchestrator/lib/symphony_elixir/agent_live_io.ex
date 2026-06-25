defmodule SymphonyElixir.AgentLiveIo do
  @moduledoc """
  Runtime-owned HTTP live I/O session owner.

  Websocket callers keep the socket process alive as the run owner. HTTP input
  requests need a process with a longer lifetime than the request, otherwise the
  SessionStore owner monitor kills the runner as soon as the response returns.
  """

  use GenServer

  alias SymphonyElixir.ChatGateway
  alias SymphonyElixir.Gateway.SessionStore

  @type scope :: %{
          required(:agent_id) => String.t(),
          required(:workspace_id) => String.t(),
          required(:user_id) => String.t(),
          required(:session_key) => String.t()
        }

  @type event :: map()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec post_message(scope(), String.t(), keyword()) :: ChatGateway.post_result()
  def post_message(scope, message, opts \\ []) when is_map(scope) and is_binary(message) do
    ChatGateway.post_message(scope, message,
      run_id: Keyword.get_lazy(opts, :run_id, &Ecto.UUID.generate/0),
      owner_pid: owner_pid(),
      metadata: Keyword.get(opts, :metadata, %{}),
      workflow_path: Keyword.get(opts, :workflow_path),
      trace_id: Keyword.get(opts, :trace_id)
    )
  end

  @spec interrupt(String.t(), String.t() | nil) :: {:ok, event()} | {:error, term()}
  def interrupt(session_key, run_id \\ nil) when is_binary(session_key) do
    case SessionStore.abort_run(session_key, run_id) do
      {:ok, session} ->
        event =
          base_event("turn_interrupted", session, session_key, run_id)
          |> Map.put("payload", %{"reason" => "interrupted"})

        broadcast(session_key, event)
        {:ok, event}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec subscribe(String.t()) :: :ok
  def subscribe(session_key) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:subscribe, session_key, self()})
  end

  @spec unsubscribe(String.t()) :: :ok
  def unsubscribe(session_key) when is_binary(session_key) do
    GenServer.cast(__MODULE__, {:unsubscribe, session_key, self()})
  end

  @impl true
  def init(_opts) do
    {:ok, %{subscribers: %{}, buffers: %{}}}
  end

  @impl true
  def handle_call({:subscribe, session_key, pid}, _from, state) do
    Process.monitor(pid)
    subscribers = Map.update(state.subscribers, session_key, MapSet.new([pid]), &MapSet.put(&1, pid))
    {:reply, :ok, %{state | subscribers: subscribers}}
  end

  @impl true
  def handle_cast({:unsubscribe, session_key, pid}, state) do
    {:noreply, %{state | subscribers: drop_subscriber(state.subscribers, session_key, pid)}}
  end

  def handle_cast({:broadcast, session_key, event}, state) do
    broadcast_to(state, session_key, event)
    {:noreply, state}
  end

  @impl true
  def handle_info({:gateway_runner_event, session_key, run_id, message}, state) do
    maybe_append_delta(run_id, message)
    state = append_buffer(state, run_id, text_delta(message))
    broadcast_to(state, session_key, runner_event(session_key, run_id, message))
    {:noreply, state}
  end

  def handle_info({:gateway_runner_complete, session_key, run_id, :ok}, state) do
    {fallback, state} = pop_buffer(state, run_id)
    {:ok, session} = SessionStore.complete_run(run_id, assistant_fallback: fallback)
    broadcast_to(state, session_key, base_event("turn_completed", session, session_key, run_id))
    {:noreply, state}
  end

  def handle_info({:gateway_runner_complete, session_key, run_id, {:ok, result}}, state) do
    {fallback, state} = pop_buffer(state, run_id)

    {:ok, session} =
      SessionStore.complete_run(run_id,
        assistant_fallback: fallback || Map.get(result, "output_text"),
        model: Map.get(result, "model"),
        provider: Map.get(result, "provider"),
        usage: Map.get(result, "usage") || %{}
      )

    event =
      base_event("turn_completed", session, session_key, run_id)
      |> Map.put("payload", %{"result" => result})

    broadcast_to(state, session_key, event)
    {:noreply, state}
  end

  def handle_info({:gateway_runner_failed, session_key, run_id, reason}, state) do
    {_fallback, state} = pop_buffer(state, run_id)
    {:ok, session} = SessionStore.fail_run(run_id)
    broadcast_to(state, session_key, error_event(session, session_key, run_id, reason))
    {:noreply, state}
  end

  def handle_info({:gateway_runner_down, session_key, run_id, reason}, state) do
    {_fallback, state} = pop_buffer(state, run_id)
    {:ok, session} = SessionStore.fail_run(run_id)
    broadcast_to(state, session_key, error_event(session, session_key, run_id, reason))
    {:noreply, state}
  end

  def handle_info({:gateway_runner_aborted, session_key, run_id}, state) do
    {_fallback, state} = pop_buffer(state, run_id)
    broadcast_to(state, session_key, base_event("turn_interrupted", nil, session_key, run_id))
    {:noreply, state}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    subscribers =
      Map.new(state.subscribers, fn {session_key, pids} ->
        {session_key, MapSet.delete(pids, pid)}
      end)

    {:noreply, %{state | subscribers: subscribers}}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp owner_pid do
    case Process.whereis(__MODULE__) do
      pid when is_pid(pid) -> pid
      nil -> raise "#{inspect(__MODULE__)} is not started"
    end
  end

  defp broadcast(session_key, event) do
    if Process.whereis(__MODULE__) do
      GenServer.cast(__MODULE__, {:broadcast, session_key, event})
    end

    :ok
  end

  defp broadcast_to(state, session_key, event) do
    state.subscribers
    |> Map.get(session_key, MapSet.new())
    |> Enum.each(&send(&1, {:agent_live_io_event, session_key, event}))
  end

  defp drop_subscriber(subscribers, session_key, pid) do
    Map.update(subscribers, session_key, MapSet.new(), &MapSet.delete(&1, pid))
  end

  defp maybe_append_delta(run_id, %{event: :notification, payload: payload}) when is_map(payload) do
    case get_in(payload, ["params", "textDelta"]) do
      delta when is_binary(delta) -> SessionStore.append_delta(run_id, delta)
      _ -> :ok
    end
  end

  defp maybe_append_delta(_run_id, _message), do: :ok

  defp append_buffer(state, _run_id, nil), do: state

  defp append_buffer(state, run_id, delta) do
    update_in(state, [:buffers, run_id], fn current -> (current || "") <> delta end)
  end

  defp pop_buffer(state, run_id) do
    {buffer, buffers} = Map.pop(state.buffers, run_id)
    {buffer, %{state | buffers: buffers}}
  end

  defp text_delta(%{event: :notification, payload: payload}) when is_map(payload) do
    case get_in(payload, ["params", "textDelta"]) do
      delta when is_binary(delta) -> delta
      _ -> nil
    end
  end

  defp text_delta(_message), do: nil

  defp runner_event(session_key, run_id, %{event: :notification, payload: payload}) when is_map(payload) do
    case text_delta(%{event: :notification, payload: payload}) do
      delta when is_binary(delta) ->
        base_event("text_delta", nil, session_key, run_id)
        |> Map.put("payload", %{"text" => delta})

      _ ->
        base_event("tool_activity", nil, session_key, run_id)
        |> Map.put("payload", payload)
    end
  end

  defp runner_event(session_key, run_id, %{event: event, payload: payload}) do
    type =
      if event in [:tool_call_started, :tool_call_completed, :tool_call_failed],
        do: "tool_activity",
        else: Atom.to_string(event)

    base_event(type, nil, session_key, run_id)
    |> Map.put("payload", payload || %{})
  end

  defp runner_event(session_key, run_id, message) do
    base_event("tool_activity", nil, session_key, run_id)
    |> Map.put("payload", %{"message" => inspect(message)})
  end

  defp error_event(session, session_key, run_id, reason) do
    base_event("error", session, session_key, run_id)
    |> Map.put("payload", %{"reason" => inspect(reason)})
  end

  defp base_event(type, session, session_key, run_id) do
    %{
      "type" => type,
      "agentId" => session_field(session, :agent_id),
      "workspaceId" => session_field(session, :workspace_id),
      "sessionKey" => session_key,
      "turnId" => run_id,
      "payload" => %{}
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp session_field(session, field) when is_map(session) do
    Map.get(session, field) || Map.get(session, Atom.to_string(field))
  end

  defp session_field(_session, _field), do: nil
end
