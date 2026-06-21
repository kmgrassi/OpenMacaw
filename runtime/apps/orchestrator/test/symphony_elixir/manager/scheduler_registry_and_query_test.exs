defmodule SymphonyElixir.Manager.SchedulerRegistryAndQueryTest do
  use SymphonyElixir.Manager.SchedulerCase

  test "registers one scheduler per workspace via Registry", %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        schedule_first_tick: false
      )

    assert [{^pid, nil}] =
             Registry.lookup(registry, {:manager_scheduler, "workspace-1", "manager-agent-1"})

    assert {:error, {:already_started, ^pid}} =
             Scheduler.start_link("workspace-1", "manager-agent-1", registry: registry)
  end

  test "due_work_items delegates to the configured work_item_source with normalized opts" do
    now = ~U[2026-04-25 12:00:00Z]

    row = %WorkItemRow{
      id: "00000000-0000-0000-0000-000000000099",
      identifier: "WI-DUE",
      title: "Due fixture",
      state: "running",
      workspace_id: "workspace-1",
      next_poll_at: ~U[2026-04-25 11:59:00Z],
      metadata: %{}
    }

    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [row])

    assert {:ok, [item]} =
             Scheduler.due_work_items("workspace-1", now,
               work_item_source: TestWorkItemSource,
               agent_id: "manager-agent-1",
               states: ["running"],
               plan_ids: ["00000000-0000-0000-0000-000000000010"],
               limit: 7
             )

    assert item.id == row.id
    assert item.source == "database"

    assert_received {:due_query, {"workspace-1", "manager-agent-1", ^now, opts}}
    assert Keyword.fetch!(opts, :states) == ["running"]
    assert Keyword.fetch!(opts, :plan_ids) == ["00000000-0000-0000-0000-000000000010"]
    assert Keyword.fetch!(opts, :limit) == 7
  end

  test "workspace due_task_query states restrict poll query on each tick", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"due_task_query" => %{"states" => ["running"]}}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{workspace_id: "workspace-1", runner: SymphonyElixir.Runner.LlmToolRunner},
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert_received {:due_query, {"workspace-1", "manager-agent-1", _now, opts}}
    assert Keyword.fetch!(opts, :states) == ["running"]
  end

  test "per-agent due_task_query states override workspace states", %{registry: registry} do
    agent_id = "00000000-0000-0000-0000-000000000100"

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "due_task_query" => %{"states" => ["awaiting_review"]},
          agent_id => %{"due_task_query" => %{"states" => ["running"]}}
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", agent_id,
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: agent_id
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert_received {:due_query, {"workspace-1", ^agent_id, _now, opts}}
    assert Keyword.fetch!(opts, :states) == ["running"]
  end

  test "per-agent due_task_query plan ids restrict poll query", %{registry: registry} do
    agent_id = "00000000-0000-0000-0000-000000000100"
    plan_a = "00000000-0000-0000-0000-000000000010"
    plan_b = "00000000-0000-0000-0000-000000000020"

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{agent_id => %{"due_task_query" => %{"plan_ids" => [plan_a]}}}
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", agent_id,
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: agent_id
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert_received {:due_query, {"workspace-1", ^agent_id, _now, opts}}
    assert Keyword.fetch!(opts, :plan_ids) == [plan_a]
    refute plan_b in Keyword.fetch!(opts, :plan_ids)
  end

  test "invalid due_task_query values fall back or drop values with warnings", %{registry: registry} do
    agent_id = "00000000-0000-0000-0000-000000000100"
    plan_id = "00000000-0000-0000-0000-000000000010"

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          agent_id => %{
            "due_task_query" => %{
              "states" => ["nonsense"],
              "plan_ids" => ["not-a-uuid", plan_id]
            }
          }
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", agent_id,
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: agent_id
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log = capture_log(fn -> assert %{batch: %{total: 0}} = Scheduler.tick(pid) end)

    assert log =~ "Ignoring invalid manager due_task_query states"
    assert log =~ "Manager due_task_query states contained no valid values"
    assert log =~ "Ignoring invalid manager due_task_query plan_ids"

    assert_received {:due_query, {"workspace-1", ^agent_id, _now, opts}}
    assert Keyword.fetch!(opts, :states) == ["running", "awaiting_review"]
    assert Keyword.fetch!(opts, :plan_ids) == [plan_id]
  end

  test "due_task_query config changes are observed on the next tick", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"due_task_query" => %{"states" => ["running"]}}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{workspace_id: "workspace-1", runner: SymphonyElixir.Runner.LlmToolRunner},
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert_received {:due_query, {"workspace-1", "manager-agent-1", _now1, first_opts}}
    assert Keyword.fetch!(first_opts, :states) == ["running"]

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"due_task_query" => %{"states" => ["awaiting_review"]}}}
    })

    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert_received {:due_query, {"workspace-1", "manager-agent-1", _now2, second_opts}}
    assert Keyword.fetch!(second_opts, :states) == ["awaiting_review"]
  end

  test "manual tick runs a non-empty due batch and records status", %{registry: registry} do
    row = %WorkItemRow{
      id: "00000000-0000-0000-0000-000000000001",
      identifier: "WI-1",
      title: "Address review",
      state: "running",
      workspace_id: "00000000-0000-0000-0000-000000000111",
      next_poll_at: ~U[2026-04-25 11:59:00Z],
      labels: ["backend"],
      metadata: %{"url" => "https://example.test/pr/1"}
    }

    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [row])

    {:ok, pid} =
      Scheduler.start_link(row.workspace_id, "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{workspace_id: row.workspace_id, runner: SymphonyElixir.Runner.LlmToolRunner},
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        min_cadence_ms: 60_000,
        schedule_first_tick: false
      )

    assert %{last_decision_count: 1, batch: %{total: 1}} = Scheduler.tick(pid)

    workspace_id = row.workspace_id
    assert_received {:due_query, {^workspace_id, "manager-agent-1", _now, opts}}
    assert Keyword.fetch!(opts, :limit) == 25
    assert_received {:post_message, %{workspace_id: ^workspace_id}, body, opts}
    assert %{"due_tasks" => [work_item]} = Jason.decode!(body)
    assert work_item["id"] == row.id
    assert work_item["url"] == "https://example.test/pr/1"
    assert opts[:metadata]["source"] == "manager_scheduler"
    assert opts[:metadata]["work_item_ids"] == [row.id]

    assert %{
             status: :running,
             missing: [],
             provider: "openai",
             last_tick_at: ~U[2026-04-25 12:00:00Z],
             last_decision_count: 1,
             last_error: nil,
             trace_id: trace_id
           } = Scheduler.status(pid)

    assert is_binary(trace_id)
  end

  test "empty due batch does not post a manager chat message", %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{workspace_id: "workspace-1", runner: SymphonyElixir.Runner.LlmToolRunner},
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{batch: %{total: 0}, last_decision_count: 0} = Scheduler.tick(pid)
    assert_received {:due_query, _query}
    refute_received {:post_message, _scope, _body, _opts}
  end

  test "logs scheduler tick counts and no-due skip reason", %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session: %{
          workspace_id: "workspace-1",
          runner: SymphonyElixir.Runner.LlmToolRunner,
          agent_id: "manager-agent-1",
          trace_id: "trc-manager-empty"
        },
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log = capture_log(fn -> assert %{batch: %{total: 0}} = Scheduler.tick(pid) end)
    events = decode_logged_events!(log)

    assert %{
             "workspace_id" => "workspace-1",
             "agent_id" => "manager-agent-1",
             "trace_id" => "trc-manager-empty"
           } = event!(events, "manager_scheduler_tick_started")

    assert %{
             "skip_reason" => "no_due_items",
             "due_count" => 0,
             "picked_count" => 0,
             "skipped_count" => 0
           } = event!(events, "manager_work_item_poll_skipped")

    assert %{
             "due_count" => 0,
             "picked_count" => 0,
             "skipped_count" => 0,
             "scheduler_health" => "running"
           } = event!(events, "manager_scheduler_tick_finished")
  end
end
