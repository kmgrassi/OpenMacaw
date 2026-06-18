defmodule SymphonyElixir.LocalRelay.Registry do
  @moduledoc """
  In-process registry for local runtime helper connections.

  WebSocket handlers and tests register helper processes here. Runner adapters
  dispatch correlation-scoped work through the registry without knowing the
  transport process that owns the local endpoint.
  """

  use GenServer

  @type registration :: %{
          required(:workspace_id) => String.t(),
          required(:machine_id) => String.t(),
          optional(:pid) => pid(),
          optional(:runners) => [String.t() | map()],
          optional(:max_dispatches) => pos_integer(),
          optional(:metadata) => map()
        }

  @type lookup_result :: {:ok, map()} | {:error, :local_runtime_offline}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @spec register(registration()) :: {:ok, map()} | {:error, atom()}
  def register(registration) when is_map(registration) do
    GenServer.call(__MODULE__, {:register, registration})
  end

  @spec heartbeat(String.t(), String.t(), map()) :: :ok | {:error, atom()}
  def heartbeat(workspace_id, machine_id, attrs \\ %{}) do
    GenServer.call(__MODULE__, {:heartbeat, workspace_id, machine_id, attrs})
  end

  @spec unregister(String.t(), String.t()) :: :ok
  def unregister(workspace_id, machine_id) do
    GenServer.call(__MODULE__, {:unregister, workspace_id, machine_id})
  end

  @spec unregister(String.t(), String.t(), pid()) :: :ok
  def unregister(workspace_id, machine_id, pid) when is_pid(pid) do
    GenServer.call(__MODULE__, {:unregister, workspace_id, machine_id, pid})
  end

  @spec lookup(String.t(), String.t()) :: lookup_result()
  def lookup(workspace_id, runner_kind) do
    GenServer.call(__MODULE__, {:lookup, workspace_id, runner_kind})
  end

  @spec dispatch(String.t(), String.t(), map(), keyword()) ::
          {:ok, String.t(), map()}
          | {:error, :local_runtime_offline | :local_runner_busy | :local_runner_protocol_error}
  def dispatch(workspace_id, runner_kind, frame, opts \\ []) when is_map(frame) do
    caller = Keyword.get(opts, :caller, self())
    GenServer.call(__MODULE__, {:dispatch, workspace_id, runner_kind, frame, caller})
  end

  @spec progress(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def progress(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:progress, correlation_id, frame})
  end

  @spec complete(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def complete(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:complete, correlation_id, frame})
  end

  @spec error(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def error(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:error, correlation_id, frame})
  end

  @spec tool_call_request(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def tool_call_request(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:tool_call_request, correlation_id, frame})
  end

  @spec tool_call_result(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def tool_call_result(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:tool_call_result, correlation_id, frame})
  end

  @spec cancel_ack(String.t(), map()) :: :ok
  def cancel_ack(correlation_id, frame) when is_binary(correlation_id) and is_map(frame) do
    GenServer.call(__MODULE__, {:cancel_ack, correlation_id, frame})
  end

  @spec send_tool_execution_request(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def send_tool_execution_request(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:send_tool_execution_request, correlation_id, frame})
  end

  @spec send_frame(String.t(), map()) :: :ok | {:error, :local_runner_protocol_error}
  def send_frame(correlation_id, frame) when is_map(frame) do
    GenServer.call(__MODULE__, {:send_frame, correlation_id, frame})
  end

  @spec cancel(String.t()) :: :ok | {:error, :local_runner_protocol_error}
  def cancel(correlation_id) do
    GenServer.call(__MODULE__, {:cancel, correlation_id})
  end

  @doc """
  Evict every connected helper from this BEAM node.

  This is used during rolling deploy shutdown so local-runtime-helper clients
  reconnect to a still-serving task instead of staying attached to a draining
  task while browser chat traffic lands elsewhere.
  """
  @spec drain_all(atom()) :: :ok
  def drain_all(reason \\ :server_draining) when is_atom(reason) do
    GenServer.call(__MODULE__, {:drain_all, reason})
  end

  @doc false
  @spec reset!() :: :ok
  def reset! do
    GenServer.call(__MODULE__, :reset)
  end

  @impl true
  def init(_opts) do
    {:ok, %{helpers: %{}, by_key: %{}, pending: %{}}}
  end

  @impl true
  def handle_call({:register, registration}, {caller, _tag}, state) do
    case build_helper(registration, caller) do
      {:ok, helper} ->
        state = remove_helper(state, helper_id(helper.workspace_id, helper.machine_id))
        state = put_helper(state, helper)
        {:reply, {:ok, public_helper(helper)}, state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:heartbeat, workspace_id, machine_id, attrs}, _from, state) do
    id = helper_id(workspace_id, machine_id)

    case Map.fetch(state.helpers, id) do
      {:ok, helper} ->
        updated =
          helper
          |> Map.put(:last_seen_at, DateTime.utc_now())
          |> maybe_update_runners(Map.get(attrs, :runners) || Map.get(attrs, "runners"))
          |> Map.update!(:metadata, &Map.merge(normalize_map(&1), heartbeat_metadata(attrs)))

        state = state |> remove_helper(id, demonitor?: false, notify_pending?: false) |> put_helper(updated)
        {:reply, :ok, state}

      :error ->
        {:reply, {:error, :local_runtime_offline}, state}
    end
  end

  def handle_call({:unregister, workspace_id, machine_id}, _from, state) do
    {:reply, :ok, remove_helper(state, helper_id(workspace_id, machine_id))}
  end

  def handle_call({:unregister, workspace_id, machine_id, pid}, _from, state) do
    id = helper_id(workspace_id, machine_id)

    state =
      case Map.fetch(state.helpers, id) do
        {:ok, %{pid: ^pid}} -> remove_helper(state, id)
        _other -> state
      end

    {:reply, :ok, state}
  end

  def handle_call({:lookup, workspace_id, runner_kind}, _from, state) do
    {:reply, lookup_helper(state, workspace_id, runner_kind), state}
  end

  def handle_call({:dispatch, workspace_id, runner_kind, frame, caller}, _from, state) do
    correlation_id = Map.get(frame, "correlation_id") || Map.get(frame, :correlation_id)

    if not is_binary(correlation_id) or correlation_id == "" do
      {:reply, {:error, :local_runner_protocol_error}, state}
    else
      case dispatch_to_helper(state, workspace_id, runner_kind, frame, caller, correlation_id) do
        {:ok, reply, state} -> {:reply, reply, state}
        {:error, reason, state} -> {:reply, {:error, reason}, state}
      end
    end
  end

  def handle_call({:progress, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        send(pending.caller, {:local_relay_progress, correlation_id, frame})
        {:reply, :ok, state}

      :error ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:complete, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, %{awaiting_tool_outputs?: true}} ->
        {:reply, :ok, state}

      _other ->
        complete_pending(correlation_id, frame, state)
    end
  end

  def handle_call({:error, correlation_id, frame}, _from, state) do
    case pop_pending(state, correlation_id) do
      {:ok, pending, state} ->
        send(pending.caller, {:local_relay_error, correlation_id, frame})
        {:reply, :ok, state}

      {:error, state} ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:tool_call_request, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        send(pending.caller, {:local_relay_tool_call_request, correlation_id, frame})
        state = put_in(state, [:pending, correlation_id, :awaiting_tool_outputs?], true)
        {:reply, :ok, state}

      :error ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:tool_call_result, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        send(pending.caller, {:local_relay_tool_call_result, correlation_id, frame})
        {:reply, :ok, state}

      :error ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:cancel_ack, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        send(pending.caller, {:local_relay_cancel_ack, correlation_id, frame})
        {:reply, :ok, state}

      :error ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:send_tool_execution_request, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        with %{pid: pid} <- Map.get(state.helpers, pending.helper_id) do
          send(pid, {:local_relay_tool_execution_request, Map.put(frame, "correlation_id", correlation_id)})
          {:reply, :ok, state}
        else
          _missing_helper -> {:reply, {:error, :local_runner_protocol_error}, state}
        end

      :error ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:send_frame, correlation_id, frame}, _from, state) do
    case Map.fetch(state.pending, correlation_id) do
      {:ok, pending} ->
        with %{pid: pid} <- Map.get(state.helpers, pending.helper_id) do
          send(pid, {:local_relay_frame, Map.put(frame, "correlation_id", correlation_id)})
          state = put_in(state, [:pending, correlation_id, :awaiting_tool_outputs?], false)
          {:reply, :ok, state}
        else
          _missing_helper -> {:reply, {:error, :local_runner_protocol_error}, state}
        end

      :error ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call({:cancel, correlation_id}, _from, state) do
    case pop_pending(state, correlation_id) do
      {:ok, pending, state} ->
        if helper = state.helpers[pending.helper_id] do
          send(helper.pid, {:local_relay_cancel, %{"type" => "cancel", "correlation_id" => correlation_id}})
        end

        {:reply, :ok, state}

      {:error, state} ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  def handle_call(:reset, _from, state) do
    Enum.each(state.helpers, fn {_id, helper} -> Process.demonitor(helper.monitor, [:flush]) end)
    {:reply, :ok, %{helpers: %{}, by_key: %{}, pending: %{}}}
  end

  def handle_call({:drain_all, reason}, _from, state) do
    Enum.each(state.helpers, fn {_id, helper} ->
      send(helper.pid, {:local_relay_evicted, reason})
      Process.demonitor(helper.monitor, [:flush])
    end)

    Enum.each(state.pending, fn {correlation_id, pending} ->
      send(
        pending.caller,
        {:local_relay_error, correlation_id, %{"error_code" => "local_runtime_offline", "reason" => inspect(reason)}}
      )
    end)

    {:reply, :ok, %{helpers: %{}, by_key: %{}, pending: %{}}}
  end

  defp complete_pending(correlation_id, frame, state) do
    case pop_pending(state, correlation_id) do
      {:ok, pending, state} ->
        send(pending.caller, {:local_relay_complete, correlation_id, frame})
        {:reply, :ok, state}

      {:error, state} ->
        {:reply, {:error, :local_runner_protocol_error}, state}
    end
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, reason}, state) do
    case Enum.find(state.helpers, fn {_id, helper} -> helper.monitor == monitor end) do
      {id, _helper} -> {:noreply, remove_helper(state, id, down_reason: reason)}
      nil -> {:noreply, state}
    end
  end

  defp dispatch_to_helper(state, workspace_id, runner_kind, frame, caller, correlation_id) do
    case lookup_helper_entry(state, workspace_id, runner_kind) do
      {:error, reason} ->
        {:error, reason, state}

      {:ok, helper_id, helper} ->
        do_dispatch_to_helper(state, helper_id, helper, frame, caller, correlation_id)
    end
  end

  defp do_dispatch_to_helper(state, helper_id, helper, frame, caller, correlation_id) do
    if MapSet.size(helper.active_dispatches) >= helper.max_dispatches do
      {:error, :local_runner_busy, state}
    else
      frame = Map.put(frame, "correlation_id", correlation_id)
      send(helper.pid, {:local_relay_dispatch, frame})

      helper = %{helper | active_dispatches: MapSet.put(helper.active_dispatches, correlation_id)}

      state = %{
        state
        | helpers: Map.put(state.helpers, helper_id, helper),
          pending: Map.put(state.pending, correlation_id, %{caller: caller, helper_id: helper_id})
      }

      {:ok, {:ok, correlation_id, public_helper(helper)}, state}
    end
  end

  defp build_helper(registration, caller) do
    workspace_id = string_field(registration, :workspace_id)
    machine_id = string_field(registration, :machine_id)
    pid = Map.get(registration, :pid) || Map.get(registration, "pid") || caller
    runners = normalize_runners(Map.get(registration, :runners) || Map.get(registration, "runners") || [])

    case validate_helper_registration(workspace_id, machine_id, pid, runners) do
      :ok -> {:ok, new_helper(registration, workspace_id, machine_id, pid, runners)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_helper_registration(workspace_id, machine_id, pid, runners) do
    cond do
      not is_binary(workspace_id) or workspace_id == "" -> {:error, :local_runner_protocol_error}
      not is_binary(machine_id) or machine_id == "" -> {:error, :local_runner_protocol_error}
      not is_pid(pid) -> {:error, :local_runner_protocol_error}
      runners == [] -> {:error, :local_runner_protocol_error}
      true -> :ok
    end
  end

  defp new_helper(registration, workspace_id, machine_id, pid, runners) do
    %{
      id: helper_id(workspace_id, machine_id),
      workspace_id: workspace_id,
      machine_id: machine_id,
      pid: pid,
      monitor: Process.monitor(pid),
      runners: runners,
      runner_index: Map.new(runners, &{&1.runner_kind, &1}),
      max_dispatches: max_dispatches(registration),
      metadata: normalize_map(Map.get(registration, :metadata) || Map.get(registration, "metadata")),
      active_dispatches: MapSet.new(),
      registered_at: DateTime.utc_now(),
      last_seen_at: DateTime.utc_now()
    }
  end

  defp maybe_update_runners(helper, nil), do: helper

  defp maybe_update_runners(helper, runners) do
    runners = normalize_runners(runners)
    %{helper | runners: runners, runner_index: Map.new(runners, &{&1.runner_kind, &1})}
  end

  defp normalize_runners(runners) when is_list(runners) do
    runners
    |> Enum.map(&normalize_runner/1)
    |> Enum.reject(&is_nil/1)
  end

  defp normalize_runners(_), do: []

  defp normalize_runner(runner_kind) when is_binary(runner_kind) do
    runner_kind = String.trim(runner_kind)
    if runner_kind == "", do: nil, else: %{runner_kind: runner_kind, provider: nil, model: nil, capabilities: %{}}
  end

  defp normalize_runner(runner) when is_map(runner) do
    runner_kind = string_field(runner, :runner_kind) || string_field(runner, :kind)

    if is_binary(runner_kind) and runner_kind != "" do
      %{
        runner_kind: runner_kind,
        provider: string_field(runner, :provider),
        model: string_field(runner, :model),
        capabilities: normalize_map(Map.get(runner, :capabilities) || Map.get(runner, "capabilities")),
        metadata: normalize_map(Map.get(runner, :metadata) || Map.get(runner, "metadata"))
      }
    end
  end

  defp normalize_runner(_), do: nil

  defp put_helper(state, helper) do
    by_key =
      Enum.reduce(helper.runners, state.by_key, fn runner, acc ->
        Map.put(acc, {helper.workspace_id, runner.runner_kind}, helper.id)
      end)

    %{state | helpers: Map.put(state.helpers, helper.id, helper), by_key: by_key}
  end

  defp remove_helper(state, id, opts \\ []) do
    case Map.fetch(state.helpers, id) do
      {:ok, helper} ->
        if Keyword.get(opts, :demonitor?, true), do: Process.demonitor(helper.monitor, [:flush])

        {pending_for_helper, pending_for_other_helpers} =
          Enum.split_with(state.pending, fn {_correlation_id, pending} -> pending.helper_id == id end)

        pending_for_helper = Map.new(pending_for_helper)
        pending_for_other_helpers = Map.new(pending_for_other_helpers)
        notify_pending? = Keyword.get(opts, :notify_pending?, true)
        pending = if notify_pending?, do: pending_for_other_helpers, else: state.pending

        if notify_pending?, do: notify_pending_offline(pending_for_helper, Keyword.get(opts, :down_reason, :unregistered))

        by_key =
          Enum.reduce(helper.runners, state.by_key, fn runner, acc ->
            Map.delete(acc, {helper.workspace_id, runner.runner_kind})
          end)

        %{state | helpers: Map.delete(state.helpers, id), by_key: by_key, pending: pending}

      :error ->
        state
    end
  end

  defp notify_pending_offline(pending_for_helper, reason) do
    Enum.each(pending_for_helper, fn {correlation_id, pending} ->
      send(
        pending.caller,
        {:local_relay_error, correlation_id, %{"error_code" => "local_runtime_offline", "reason" => inspect(reason)}}
      )
    end)
  end

  defp lookup_helper(state, workspace_id, runner_kind) do
    case lookup_helper_entry(state, workspace_id, runner_kind) do
      {:ok, _id, helper} -> {:ok, public_helper(helper)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp lookup_helper_entry(state, workspace_id, runner_kind) do
    case Map.fetch(state.by_key, {workspace_id, runner_kind}) do
      {:ok, helper_id} -> {:ok, helper_id, Map.fetch!(state.helpers, helper_id)}
      :error -> {:error, :local_runtime_offline}
    end
  end

  defp pop_pending(state, correlation_id) do
    case Map.pop(state.pending, correlation_id) do
      {nil, _pending} ->
        {:error, state}

      {pending, pending_map} ->
        state = %{state | pending: pending_map}

        state =
          update_in(state.helpers[pending.helper_id], fn
            nil -> nil
            helper -> %{helper | active_dispatches: MapSet.delete(helper.active_dispatches, correlation_id)}
          end)

        {:ok, pending, state}
    end
  end

  defp public_helper(helper) do
    Map.take(helper, [:workspace_id, :machine_id, :runners, :metadata, :registered_at, :last_seen_at])
  end

  defp max_dispatches(registration) do
    case Map.get(registration, :max_dispatches) || Map.get(registration, "max_dispatches") do
      value when is_integer(value) and value > 0 -> value
      _ -> 1
    end
  end

  defp heartbeat_metadata(attrs) do
    attrs
    |> Map.get(:metadata, Map.get(attrs, "metadata"))
    |> normalize_map()
  end

  defp normalize_map(value) when is_map(value), do: value
  defp normalize_map(_value), do: %{}

  defp helper_id(workspace_id, machine_id), do: "#{workspace_id}:#{machine_id}"

  defp string_field(map, key) do
    Map.get(map, key) || Map.get(map, Atom.to_string(key))
  end
end
