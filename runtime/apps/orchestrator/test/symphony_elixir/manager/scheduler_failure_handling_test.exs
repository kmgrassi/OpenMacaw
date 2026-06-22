defmodule SymphonyElixir.Manager.SchedulerFailureHandlingTest do
  use SymphonyElixir.Manager.SchedulerCase

  test "poll failures are logged with stable error code and health state", %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: ErrorWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: "manager-agent-1",
          trace_id: "trc-manager-poll-failed"
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log =
      capture_log(fn ->
        assert %{
                 status: :error,
                 last_error: %{
                   kind: "runtime_exception",
                   error_code: "manager_scheduler_exception",
                   retryable: false
                 }
               } = Scheduler.tick(pid)
      end)

    events = decode_logged_events!(log)

    assert %{
             "event" => "manager_work_item_poll_failed",
             "error_code" => "manager_scheduler_exception",
             "error_class" => "RuntimeError",
             "error_message" => "database unavailable",
             "retryable" => false,
             "tick_phase" => "due_query",
             "trace_id" => "trc-manager-poll-failed"
           } = event!(events, "manager_work_item_poll_failed")

    assert %{
             "event" => "manager_scheduler_tick_failed",
             "last_error_code" => "manager_scheduler_exception",
             "scheduler_health" => "error",
             "error_class" => "RuntimeError",
             "error_message" => "database unavailable",
             "tick_phase" => "due_query"
           } = event!(events, "manager_scheduler_tick_failed")
  end

  test "work item source tuple errors surface the original reason instead of a case clause exception",
       %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: ReturningErrorWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: "manager-agent-1",
          trace_id: "trc-manager-poll-return-error"
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log =
      capture_log(fn ->
        assert %{
                 status: :error,
                 last_error: %{
                   kind: "postgrest_failed",
                   error_code: "manager_scheduler_failure",
                   retryable: false,
                   message: "{:postgrest_failed, :timeout}"
                 }
               } = Scheduler.tick(pid)
      end)

    events = decode_logged_events!(log)

    assert %{
             "event" => "manager_work_item_poll_failed",
             "error_code" => "manager_scheduler_failure",
             "reason" => "{:postgrest_failed, :timeout}",
             "retryable" => false,
             "trace_id" => "trc-manager-poll-return-error"
           } = event!(events, "manager_work_item_poll_failed")

    refute Enum.any?(events, fn event ->
             event["error_class"] == "CaseClauseError" or
               String.contains?(event["error_message"] || "", "no case clause matching")
           end)
  end

  test "manager turn exceptions are logged with structured class, message, and tick phase",
       %{registry: registry} do
    row = %WorkItemRow{
      id: "00000000-0000-0000-0000-000000000003",
      identifier: "WI-3",
      title: "Run manager turn",
      state: "running",
      workspace_id: "workspace-1",
      next_poll_at: ~U[2026-04-25 11:59:00Z],
      metadata: %{}
    }

    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [row])

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: RaisingChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: "manager-agent-1",
          trace_id: "trc-manager-turn-failed"
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log = capture_log(fn -> assert %{status: :error} = Scheduler.tick(pid) end)

    assert %{
             "event" => "manager_scheduler_tick_failed",
             "workspace_id" => "workspace-1",
             "agent_id" => "manager-agent-1",
             "error_code" => "manager_scheduler_exception",
             "error_class" => "RuntimeError",
             "error_message" => "manager turn exploded",
             "tick_phase" => "run_turn"
           } = event!(decode_logged_events!(log), "manager_scheduler_tick_failed")
  end

  test "status records provider errors and becomes unhealthy after repeated failures", %{
    registry: registry
  } do
    row = %WorkItemRow{
      id: "00000000-0000-0000-0000-000000000002",
      identifier: "WI-2",
      title: "Retry manager turn",
      state: "running",
      workspace_id: "00000000-0000-0000-0000-000000000222",
      next_poll_at: ~U[2026-04-25 11:59:00Z],
      metadata: %{}
    }

    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [row])

    {:ok, pid} =
      Scheduler.start_link(row.workspace_id, "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: ErrorChatGateway,
        session: %{
          workspace_id: row.workspace_id,
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: "manager-agent-1",
          provider: "openai",
          model: "gpt-5.2",
          trace_id: "trc-manager-test"
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{status: :error, last_error: %{kind: "provider_failure", retryable: true}} = Scheduler.tick(pid)
    assert %{status: :error} = Scheduler.tick(pid)

    assert %{
             status: :unhealthy,
             agent_id: "manager-agent-1",
             provider: "openai",
             model: "gpt-5.2",
             trace_id: "trc-manager-test",
             last_error: %{kind: "provider_failure", error_code: "manager_provider_timeout"}
           } = Scheduler.tick(pid)
  end
end
