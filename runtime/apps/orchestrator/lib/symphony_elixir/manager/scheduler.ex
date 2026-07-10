defmodule SymphonyElixir.Manager.Scheduler do
  @moduledoc """
  Per-(workspace, agent) scheduler for manager-agent reconciliation.

  A scheduler polls due `work_items` for one manager agent within one
  workspace and posts non-empty batches through `SymphonyElixir.ChatGateway`.

  Cadence is resolved per agent: the gateway config key
  `runners.manager.<agent_id>.min_cadence_ms` is read first, then the
  workspace-level `runners.manager.min_cadence_ms`, then the default of
  60s. Work items are filtered to those whose `manager_runner_id`
  matches this scheduler's agent so multiple manager agents in the same
  workspace do not poach each other's items.
  """

  use GenServer

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.ChatGateway
  alias SymphonyElixir.Manager.SchedulerStatus
  alias SymphonyElixir.Manager.SchedulerConfig
  alias SymphonyElixir.Manager.Scheduler.Session
  alias SymphonyElixir.Manager.WorkItems.Database, as: DueWorkItems
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.StructuredContext

  @registry SymphonyElixir.Manager.Scheduler.Registry
  @default_due_task_query SchedulerConfig.default_due_task_query()
  @default_batch_limit 25
  @default_jitter_ms 5_000
  @tick_phase_key {__MODULE__, :tick_phase}

  @type state :: %{
          workspace_id: String.t(),
          agent_id: String.t(),
          session: map(),
          session_mode: :explicit | :resolved,
          session_resolver: module(),
          session_resolver_opts: keyword(),
          session_details: map(),
          idle_reason: atom() | nil,
          session_error: map() | nil,
          work_item_source: module(),
          chat_gateway: module(),
          clock: (-> DateTime.t()),
          timer: (pid(), term(), non_neg_integer() -> reference() | term()),
          min_cadence_ms: pos_integer(),
          batch_limit: pos_integer(),
          last_tick_at: DateTime.t() | nil,
          last_decision_count: non_neg_integer(),
          last_error: map() | nil,
          consecutive_error_count: non_neg_integer(),
          trace_id: String.t() | nil
        }

  @type status :: %{
          status:
            :idle_awaiting_config
            | :idle_awaiting_credential
            | :running
            | :unhealthy
            | :error,
          workspace_id: String.t(),
          agent_id: String.t(),
          min_cadence_ms: pos_integer(),
          last_tick_at: DateTime.t() | nil,
          last_decision_count: non_neg_integer(),
          idle_reason: atom() | nil,
          last_error: map() | nil,
          trace_id: String.t() | nil
        }

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts) do
    workspace_id = Keyword.fetch!(opts, :workspace_id)
    agent_id = Keyword.fetch!(opts, :agent_id)
    scheduler_opts = Keyword.drop(opts, [:workspace_id, :agent_id])

    %{
      id: {__MODULE__, workspace_id, agent_id},
      start: {__MODULE__, :start_link, [workspace_id, agent_id, scheduler_opts]},
      restart: :transient,
      shutdown: 5_000,
      type: :worker
    }
  end

  @spec start_link(String.t(), String.t(), keyword()) :: GenServer.on_start()
  def start_link(workspace_id, agent_id, opts \\ [])
      when is_binary(workspace_id) and workspace_id != "" and is_binary(agent_id) and
             agent_id != "" do
    registry = Keyword.get(opts, :registry, @registry)
    name = Keyword.get(opts, :name, via_tuple(workspace_id, agent_id, registry))
    GenServer.start_link(__MODULE__, {workspace_id, agent_id, opts}, name: name)
  end

  @spec via_tuple(String.t(), String.t(), module()) ::
          {:via, Registry, {module(), {:manager_scheduler, String.t(), String.t()}}}
  def via_tuple(workspace_id, agent_id, registry \\ @registry)
      when is_binary(workspace_id) and is_binary(agent_id) do
    {:via, Registry, {registry, {:manager_scheduler, workspace_id, agent_id}}}
  end

  @spec tick(GenServer.server(), timeout()) :: map()
  def tick(server, timeout \\ 5_000), do: GenServer.call(server, :tick, timeout)

  @spec status(GenServer.server(), timeout()) :: status()
  def status(server, timeout \\ 5_000), do: GenServer.call(server, :status, timeout)

  # Public query path used by tests + external introspection. Delegates to
  # the PostgREST-backed `Manager.WorkItems.Database` module so all runtime
  # DB access in the launcher path uses the same client. See CLAUDE.md
  # "Database Connection Conventions".
  @spec due_work_items(String.t(), DateTime.t(), keyword()) ::
          {:ok, [SymphonyElixir.WorkItem.t()]} | {:error, term()}
  def due_work_items(workspace_id, now, opts \\ []) when is_struct(now, DateTime) do
    agent_id = Keyword.get(opts, :agent_id)
    source = Keyword.get(opts, :work_item_source, DueWorkItems)
    states = Keyword.get(opts, :states, @default_due_task_query.states)

    source.due_work_items(workspace_id, agent_id, now,
      states: states,
      plan_ids: Keyword.get(opts, :plan_ids),
      limit: Keyword.get(opts, :limit, @default_batch_limit)
    )
  end

  @impl GenServer
  def init({workspace_id, agent_id, opts}) do
    min_cadence_ms =
      Keyword.get(opts, :min_cadence_ms, configured_min_cadence_ms(workspace_id, agent_id))

    jitter_ms = Keyword.get(opts, :jitter_ms, @default_jitter_ms)

    {session, session_mode, session_details, idle_reason, session_error} =
      Session.initial(workspace_id, agent_id, opts)

    state = %{
      workspace_id: workspace_id,
      agent_id: agent_id,
      session: session,
      session_mode: session_mode,
      session_resolver: Session.resolver(opts),
      session_resolver_opts: Session.resolver_opts(opts),
      session_details: session_details,
      idle_reason: idle_reason,
      session_error: session_error,
      work_item_source: Keyword.get(opts, :work_item_source, DueWorkItems),
      chat_gateway: Keyword.get(opts, :chat_gateway, ChatGateway),
      clock: Keyword.get(opts, :clock, &DateTime.utc_now/0),
      timer: Keyword.get(opts, :timer, &Process.send_after/3),
      min_cadence_ms: min_cadence_ms,
      batch_limit: Keyword.get(opts, :batch_limit, @default_batch_limit),
      last_tick_at: nil,
      last_decision_count: 0,
      last_error: nil,
      consecutive_error_count: 0,
      trace_id: trace_id_for(session, session_details)
    }

    if Keyword.get(opts, :schedule_first_tick, true) do
      schedule_tick(state, initial_delay(jitter_ms))
    end

    {:ok, state}
  end

  @impl GenServer
  def handle_call(:tick, _from, state) do
    {reply, state} = run_tick(state)
    {:reply, reply, state}
  end

  def handle_call(:status, _from, state) do
    {:reply, status_payload(state), state}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    {_reply, state} = run_tick(state)
    schedule_tick(state, state.min_cadence_ms)
    {:noreply, state}
  end

  defp run_tick(state) do
    trace_id = RuntimeLog.ensure_trace_id(state.trace_id)

    RuntimeLog.with_operation_trace_id(trace_id, fn -> do_run_tick(state, trace_id) end)
  end

  defp do_run_tick(state, trace_id) do
    started_at = System.monotonic_time()
    now = state.clock.()

    set_tick_phase(:refresh_session)
    state = Session.refresh(state)

    RuntimeLog.log(:info, :manager_scheduler_tick_started, status_log_fields(state, trace_id))

    {due_work_items, batch_result, tick_error, tick_metrics} =
      case run_due_batch(state, now, trace_id) do
        {:ok, due_work_items, batch_result, metrics} ->
          {due_work_items, batch_result, batch_error(batch_result), metrics}

        {:error, error, metrics} ->
          normalized = SchedulerStatus.normalize_error(error)

          {[], %{total: 0, ok: 0, error: 1, results: [%{status: :error, reason: error}]}, normalized, metrics}
      end

    # Reload min_cadence_ms from gateway_config so wizard-driven config
    # changes take effect within one tick instead of waiting for a
    # scheduler restart. Other manager runner fields (provider, model,
    # agent_id, target_runner_kind) already refresh via refresh_session/1
    # above; due_task_query refreshes inside poll_due_work_items/3. The
    # cadence is the last gateway_config-derived field that was cached at
    # init time. See docs/local-helper-page-runtime-scope.md PR4.
    set_tick_phase(:refresh_config)
    refreshed_cadence = configured_min_cadence_ms(state.workspace_id, state.agent_id)

    next_state = %{
      state
      | last_tick_at: now,
        last_decision_count: Map.get(batch_result, :total, length(due_work_items)),
        last_error: tick_error,
        consecutive_error_count: next_error_count(state, tick_error),
        trace_id: trace_id,
        min_cadence_ms: refreshed_cadence
    }

    finish_fields =
      next_state
      |> status_log_fields(trace_id)
      |> Map.merge(tick_metrics)
      |> Map.put(:duration_ms, duration_ms(started_at))
      |> maybe_put(:last_error, next_state.last_error)

    scheduler_status = SchedulerStatus.compute(next_state)

    if tick_error do
      RuntimeLog.log(SchedulerStatus.log_level(scheduler_status), :manager_scheduler_tick_failed, finish_fields)
    end

    RuntimeLog.log(SchedulerStatus.log_level(scheduler_status), :manager_scheduler_tick_finished, finish_fields)

    clear_tick_phase()

    {Map.merge(status_payload(next_state), %{batch: batch_result}), next_state}
  end

  defp run_due_batch(state, now, trace_id) do
    if Session.runnable?(state) do
      set_tick_phase(:due_query)

      with {:ok, due_work_items, poll_metrics} <- poll_due_work_items(state, now, trace_id) do
        batch_result =
          case due_work_items do
            [] ->
              %{total: 0, ok: 0, error: 0, results: []}

            items ->
              set_tick_phase(:run_turn)
              run_manager_batch(state, items, now)
          end

        picked_count = if due_work_items == [], do: 0, else: length(due_work_items)

        {:ok, due_work_items, batch_result,
         Map.merge(poll_metrics, %{
           picked_count: picked_count,
           skipped_count: 0
         })}
      end
    else
      scheduler_status = SchedulerStatus.compute(state)
      skip_reason = SchedulerStatus.skip_reason(scheduler_status)

      RuntimeLog.log(
        :info,
        :manager_work_item_poll_skipped,
        SchedulerStatus.log_fields(scheduler_status, trace_id)
        |> Map.merge(%{
          skip_reason: skip_reason,
          due_count: 0,
          picked_count: 0,
          skipped_count: 1
        })
      )

      {:ok, [], %{total: 0, ok: 0, error: 0, results: [], idle_reason: state.idle_reason}, %{due_count: 0, picked_count: 0, skipped_count: 1, skip_reason: skip_reason}}
    end
  rescue
    exception ->
      error = {:exception, exception.__struct__, Exception.message(exception)}

      {:error, error,
       Map.merge(
         %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)},
         scheduler_exception_fields(error)
       )}
  catch
    kind, reason ->
      error = {kind, reason}
      {:error, error, %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)}}
  end

  defp poll_due_work_items(state, now, trace_id) do
    started_at = System.monotonic_time()
    fields = status_log_fields(state, trace_id)

    try do
      RuntimeLog.log(:info, :manager_work_item_poll_started, fields)

      %{states: states, plan_ids: plan_ids} =
        SchedulerConfig.due_task_query(state.workspace_id, state.agent_id)

      case state.work_item_source.due_work_items(state.workspace_id, state.agent_id, now,
             states: states,
             plan_ids: plan_ids,
             limit: state.batch_limit
           ) do
        {:ok, due_work_items} ->
          due_count = length(due_work_items)

          completed_fields =
            Map.merge(fields, %{
              due_count: due_count,
              picked_count: due_count,
              skipped_count: 0,
              duration_ms: duration_ms(started_at)
            })

          RuntimeLog.log(:info, :manager_work_item_poll_completed, completed_fields)

          if due_count == 0 do
            RuntimeLog.log(
              :info,
              :manager_work_item_poll_skipped,
              Map.put(completed_fields, :skip_reason, :no_due_items)
            )
          end

          {:ok, due_work_items, %{due_count: due_count}}

        {:error, error} ->
          log_poll_failure(fields, started_at, error, nil)
          {:error, error, %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)}}

        {:error, error, work_item_id} ->
          log_poll_failure(fields, started_at, error, work_item_id)
          {:error, error, %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)}}
      end
    rescue
      exception ->
        error = {:exception, exception.__struct__, Exception.message(exception)}
        log_poll_failure(fields, started_at, error, nil)

        {:error, error,
         Map.merge(
           %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)},
           scheduler_exception_fields(error)
         )}
    catch
      kind, reason ->
        error = {kind, reason}
        log_poll_failure(fields, started_at, error, nil)
        {:error, error, %{due_count: 0, picked_count: 0, skipped_count: 0, error_code: SchedulerStatus.error_code(error)}}
    end
  end

  defp log_poll_failure(fields, started_at, error, work_item_id) do
    RuntimeLog.log(
      :warning,
      :manager_work_item_poll_failed,
      fields
      |> Map.merge(%{
        error_code: SchedulerStatus.error_code(error),
        retryable: SchedulerStatus.retryable_error?(error),
        reason: inspect(error),
        duration_ms: duration_ms(started_at)
      })
      |> Map.merge(scheduler_exception_fields(error))
      |> maybe_put(:work_item_id, work_item_id)
    )
  end

  defp run_manager_batch(state, items, now) do
    run_id = generate_run_id()
    {body, metadata} = StructuredContext.format_work_items(items, kind: "due_tasks")
    work_item_ids = Enum.map(items, & &1.id)

    metadata =
      metadata
      |> Map.put("source", "manager_scheduler")
      |> Map.put("scheduled_at", DateTime.to_iso8601(now))

    assistant_metadata = %{
      "source" => "manager_scheduler"
    }

    scope_input =
      state.session
      |> put_string_default(:agent_id, state.agent_id)
      |> put_string_default(:workspace_id, state.workspace_id)
      |> put_string_default(:session_key, "agent:#{state.agent_id}:main")

    case ChatGateway.scope_for(scope_input) do
      nil ->
        batch_error(items, run_id, :manager_chat_scope_missing)

      scope ->
        scope = Map.put(scope, :manager_session, state.session)

        case state.chat_gateway.post_message(scope, body,
               agent: scheduler_agent(state),
               await?: true,
               run_id: run_id,
               metadata: metadata,
               assistant_metadata: assistant_metadata,
               work_item_ids: work_item_ids,
               trace_id: state.trace_id
             ) do
          {:ok, ^run_id} ->
            %{
              total: length(items),
              ok: length(items),
              error: 0,
              results: [
                %{
                  work_item_ids: work_item_ids,
                  run_id: run_id,
                  status: :ok
                }
              ]
            }

          {:error, reason} ->
            batch_error(items, run_id, reason)
        end
    end
  end

  defp put_string_default(map, key, default) do
    case Map.get(map, key) do
      value when is_binary(value) and value != "" -> map
      _ -> Map.put(map, key, default)
    end
  end

  defp scheduler_agent(state) do
    %Agent{
      id: state.agent_id,
      workspace_id: state.workspace_id,
      name: state.agent_id,
      slug: state.agent_id,
      type: "manager"
    }
  end

  defp batch_error(items, run_id, reason) do
    work_item_ids = Enum.map(items, & &1.id)

    %{
      total: length(items),
      ok: 0,
      error: length(items),
      results: [
        %{
          work_item_ids: work_item_ids,
          run_id: run_id,
          status: :error,
          reason: reason
        }
      ]
    }
  end

  defp generate_run_id do
    Ecto.UUID.generate()
  end

  defp schedule_tick(state, delay_ms) do
    state.timer.(self(), :tick, delay_ms)
    :ok
  end

  defp initial_delay(max_jitter_ms) when is_integer(max_jitter_ms) and max_jitter_ms > 0 do
    :rand.uniform(max_jitter_ms)
  end

  defp initial_delay(_), do: 0

  defp configured_min_cadence_ms(workspace_id, agent_id) do
    SchedulerConfig.min_cadence_ms(workspace_id, agent_id)
  end

  defp status_payload(state) do
    state
    |> SchedulerStatus.compute()
    |> SchedulerStatus.to_payload()
  end

  defp batch_error(%{error: error_count, results: results}) when error_count > 0 and is_list(results) do
    results
    |> Enum.find(&(Map.get(&1, :status) == :error || Map.get(&1, "status") == "error"))
    |> case do
      nil ->
        SchedulerStatus.normalize_error(:batch_failed)

      result ->
        SchedulerStatus.normalize_error(Map.get(result, :reason) || Map.get(result, "reason") || :batch_failed)
    end
  end

  defp batch_error(_batch_result), do: nil

  defp next_error_count(_state, nil), do: 0
  defp next_error_count(state, _last_error), do: state.consecutive_error_count + 1

  defp trace_id_for(session, session_details) do
    RuntimeLog.ensure_trace_id(
      session_value(session, :trace_id) ||
        session_value(session_details, :trace_id)
    )
  end

  defp session_value(session, key) when is_map(session) do
    Map.get(session, key) || Map.get(session, Atom.to_string(key))
  end

  defp session_value(_session, _key), do: nil

  defp status_log_fields(state, trace_id) do
    state
    |> SchedulerStatus.compute()
    |> SchedulerStatus.log_fields(trace_id)
  end

  defp scheduler_exception_fields(error) do
    SchedulerStatus.exception_log_fields(error, tick_phase: current_tick_phase())
  end

  defp duration_ms(started_at) do
    System.convert_time_unit(System.monotonic_time() - started_at, :native, :millisecond)
  end

  defp set_tick_phase(phase) when is_atom(phase) do
    Process.put(@tick_phase_key, phase)
    :ok
  end

  defp current_tick_phase do
    Process.get(@tick_phase_key)
  end

  defp clear_tick_phase do
    Process.delete(@tick_phase_key)
    :ok
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
