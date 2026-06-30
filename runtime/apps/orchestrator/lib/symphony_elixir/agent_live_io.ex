defmodule SymphonyElixir.AgentLiveIo do
  @moduledoc """
  Runtime-owned HTTP live I/O session owner.

  Websocket callers keep the socket process alive as the run owner. HTTP input
  requests need a process with a longer lifetime than the request, otherwise the
  SessionStore owner monitor kills the runner as soon as the response returns.
  """

  use GenServer

  alias SymphonyElixir.AgentIO
  alias SymphonyElixir.AgentIO.ToolActivity
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.ChatGateway
  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Gateway.AgentExecutionProfile
  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.Workspace
  alias SymphonyElixirWeb.Gateway.Middleware

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
    with {:ok, route} <- route(scope, opts) do
      case route do
        {:agent_io, agent, profile} ->
          with {:ok, agent_io_opts} <- agent_io_opts(scope, agent, profile, opts),
               {:ok, %{turn_id: turn_id}} <- AgentIO.send_message(scope.session_key, message, agent_io_opts) do
            {:ok, turn_id}
          end

        :chat_gateway ->
          ChatGateway.post_message(scope, message,
            run_id: Keyword.get_lazy(opts, :run_id, &Ecto.UUID.generate/0),
            owner_pid: owner_pid(),
            metadata: Keyword.get(opts, :metadata, %{}),
            workflow_path: Keyword.get(opts, :workflow_path),
            trace_id: Keyword.get(opts, :trace_id)
          )
      end
    end
  end

  @spec interrupt(scope() | String.t(), String.t() | nil, keyword()) :: {:ok, event()} | {:error, term()}
  def interrupt(scope_or_session_key, run_id \\ nil, opts \\ [])

  @spec interrupt(scope() | String.t(), String.t() | nil, keyword()) :: {:ok, event()} | {:error, term()}
  def interrupt(%{session_key: session_key} = scope, run_id, opts) when is_binary(session_key) do
    with {:ok, route} <- route(scope, opts) do
      case route do
        {:agent_io, _agent, _profile} ->
          with :ok <- AgentIO.interrupt(session_key) do
            event =
              base_event("turn_interrupted", scope, session_key, run_id)
              |> Map.put("payload", %{"reason" => "interrupted"})

            {:ok, event}
          end

        :chat_gateway ->
          interrupt(session_key, run_id, opts)
      end
    end
  end

  def interrupt(session_key, run_id, _opts) when is_binary(session_key) do
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

  @spec subscribe(scope() | String.t(), keyword()) :: :ok | {:error, term()}
  def subscribe(scope_or_session_key, opts \\ [])

  @spec subscribe(scope() | String.t(), keyword()) :: :ok | {:error, term()}
  def subscribe(%{session_key: session_key} = scope, opts) when is_binary(session_key) do
    with {:ok, route} <- route(scope, opts) do
      case route do
        {:agent_io, agent, profile} ->
          with {:ok, agent_io_opts} <- agent_io_opts(scope, agent, profile, opts),
               {:ok, _snapshot} <- AgentIO.subscribe(session_key, self(), agent_io_opts) do
            :ok
          end

        :chat_gateway ->
          subscribe(session_key, opts)
      end
    end
  end

  def subscribe(session_key, _opts) when is_binary(session_key) do
    GenServer.call(__MODULE__, {:subscribe, session_key, self()})
  end

  @spec unsubscribe(String.t()) :: :ok
  def unsubscribe(session_key) when is_binary(session_key) do
    GenServer.cast(__MODULE__, {:unsubscribe, session_key, self()})
  end

  @spec stream_event(scope(), map()) :: event() | nil
  def stream_event(scope, %{event: event} = message) when is_map(scope) do
    session_key = Map.get(message, :session_key) || scope.session_key
    turn_id = Map.get(message, :turn_id) || get_in(message, [:payload, "turnId"]) || get_in(message, [:payload, :turn_id])
    payload = Map.get(message, :payload) || %{}

    case event do
      :turn_started ->
        base_event("turn_started", scope, session_key, turn_id)
        |> Map.put("payload", payload)

      :notification ->
        notification_event(scope, session_key, turn_id, payload)

      :turn_completed ->
        base_event("turn_completed", scope, session_key, turn_id)
        |> Map.put("payload", payload)

      :turn_ended_with_error ->
        if interrupted_payload?(payload) do
          base_event("turn_interrupted", scope, session_key, turn_id)
          |> Map.put("payload", payload)
        else
          base_event("error", scope, session_key, turn_id)
          |> Map.put("payload", payload)
        end

      :startup_failed ->
        base_event("error", scope, session_key, turn_id)
        |> Map.put("payload", payload)

      event when event in [:tool_call_started, :tool_call_completed, :tool_call_failed, :unsupported_tool_call] ->
        base_event("tool_activity", scope, session_key, turn_id)
        |> Map.put("payload", ToolActivity.normalize(message))

      _other ->
        nil
    end
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

  defp route(scope, opts) do
    if Keyword.has_key?(opts, :agent_live_io_route) do
      {:ok, Keyword.fetch!(opts, :agent_live_io_route)}
    else
      with {:ok, agent} <- fetch_agent(scope, opts) do
        case profile_resolver().resolve_route(scope.agent_id, scope.workspace_id) do
          {:ok, profile} ->
            if coding_agent_io_profile?(profile) do
              {:ok, {:agent_io, agent, profile}}
            else
              {:ok, :chat_gateway}
            end

          {:error, _reason} ->
            {:ok, :chat_gateway}
        end
      end
    end
  end

  defp fetch_agent(scope, opts) do
    case Keyword.get(opts, :agent) do
      nil -> Middleware.fetch_agent(scope.agent_id)
      agent -> {:ok, agent}
    end
  end

  defp profile_resolver do
    Application.get_env(:symphony_elixir, :agent_live_io_profile_resolver, AgentExecutionProfile)
  end

  defp coding_agent_io_profile?(profile) when is_map(profile) do
    ExecutionProfile.runner_kind(profile) == "codex"
  end

  defp coding_agent_io_profile?(_profile), do: false

  defp agent_io_opts(scope, agent, profile, opts) do
    work_item = work_item(scope, agent, profile, Keyword.get(opts, :metadata, %{}))
    runner = Keyword.get(opts, :runner, Application.get_env(:symphony_elixir, :agent_live_io_coding_runner, SymphonyElixir.Runner.Codex))
    config = runner_config(agent, profile, scope, opts)

    with {:ok, workspace} <- workspace_for(work_item, opts) do
      {:ok,
       [
         runner: runner,
         config: config,
         workspace: workspace,
         work_item: work_item
       ]}
    end
  end

  defp runner_config(agent, profile, scope, opts) do
    base_config =
      agent
      |> agent_model_settings()
      |> Map.put_new("agent_id", scope.agent_id)
      |> Map.put_new("workspace_id", scope.workspace_id)
      |> Map.put_new("user_id", scope.user_id)
      |> maybe_put("agent_context", agent_context(agent))
      |> maybe_put("trace_id", Keyword.get(opts, :trace_id))

    ExecutionProfile.runner_config(profile, base_config)
  end

  defp workspace_for(%WorkItem{} = work_item, opts) do
    case Keyword.fetch(opts, :workspace) do
      {:ok, workspace} when is_binary(workspace) -> {:ok, workspace}
      _ -> Workspace.create_for_issue(work_item.identifier || work_item.id)
    end
  end

  defp work_item(scope, agent, profile, metadata) do
    %WorkItem{
      id: scope.session_key,
      identifier: agent_slug(agent) || agent_id(agent) || scope.agent_id,
      title: agent_name(agent) || "Streaming Agent Session",
      description: agent_context(agent),
      source: "agent_live_io",
      runner_type: ExecutionProfile.runner_kind(profile),
      metadata: metadata || %{}
    }
  end

  defp notification_event(scope, session_key, turn_id, payload) do
    case get_in(payload, ["params", "textDelta"]) do
      delta when is_binary(delta) ->
        base_event("text_delta", scope, session_key, turn_id)
        |> Map.put("payload", %{"text" => delta})

      _ ->
        nil
    end
  end

  defp interrupted_payload?(payload) when is_map(payload) do
    reason = Map.get(payload, "reason") || Map.get(payload, :reason)
    reason == "interrupted" or reason == :interrupted
  end

  defp interrupted_payload?(_payload), do: false

  defp agent_model_settings(%Agent{model_settings: settings}) when is_map(settings), do: settings
  defp agent_model_settings(%{model_settings: settings}) when is_map(settings), do: settings
  defp agent_model_settings(_agent), do: %{}

  defp agent_id(%Agent{id: id}), do: id
  defp agent_id(%{id: id}), do: id
  defp agent_id(%{"id" => id}), do: id
  defp agent_id(_agent), do: nil

  defp agent_name(%Agent{name: name}), do: name
  defp agent_name(%{name: name}), do: name
  defp agent_name(%{"name" => name}), do: name
  defp agent_name(_agent), do: nil

  defp agent_slug(%Agent{slug: slug}), do: slug
  defp agent_slug(%{slug: slug}), do: slug
  defp agent_slug(%{"slug" => slug}), do: slug
  defp agent_slug(_agent), do: nil

  defp agent_context(%Agent{context: context}), do: context
  defp agent_context(%{context: context}), do: context
  defp agent_context(%{"context" => context}), do: context
  defp agent_context(_agent), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

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
      if event in [:tool_call_started, :tool_call_completed, :tool_call_failed, :unsupported_tool_call],
        do: "tool_activity",
        else: Atom.to_string(event)

    payload =
      if type == "tool_activity" do
        ToolActivity.normalize(%{event: event, payload: payload})
      else
        payload || %{}
      end

    base_event(type, nil, session_key, run_id)
    |> Map.put("payload", payload)
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
