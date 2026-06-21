defmodule SymphonyElixir.Manager.SchedulerCadenceTest do
  use SymphonyElixir.Manager.SchedulerCase

  test "configured workspace cadence overrides the default", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"min_cadence_ms" => 12_345}}
    })

    test_pid = self()

    timer = fn pid, message, delay_ms ->
      send(test_pid, {:timer, pid, message, delay_ms})
      make_ref()
    end

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        jitter_ms: 0,
        timer: timer
      )

    assert_received {:timer, ^pid, :tick, 0}
    assert %{min_cadence_ms: 12_345} = Scheduler.status(pid)
  end

  test "per-agent cadence override beats workspace cadence", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "min_cadence_ms" => 60_000,
          "manager-agent-1" => %{"min_cadence_ms" => 5_000}
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        schedule_first_tick: false
      )

    assert %{min_cadence_ms: 5_000} = Scheduler.status(pid)
  end

  test "per-agent cadence falls back to workspace then default", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"min_cadence_ms" => 30_000}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-without-override",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        schedule_first_tick: false
      )

    assert %{min_cadence_ms: 30_000} = Scheduler.status(pid)
  end

  test "min_cadence_ms config changes are observed on the next tick", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"min_cadence_ms" => 12_345}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        manager: TestManager,
        session: %{workspace_id: "workspace-1", runner: SymphonyElixir.Runner.LlmToolRunner},
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{min_cadence_ms: 12_345} = Scheduler.status(pid)

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"min_cadence_ms" => 99_999}}
    })

    assert %{min_cadence_ms: 12_345} = Scheduler.status(pid)
    assert %{batch: %{total: 0}} = Scheduler.tick(pid)
    assert %{min_cadence_ms: 99_999} = Scheduler.status(pid)
  end

  test "agents in the same workspace use independent cadences", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "min_cadence_ms" => 60_000,
          "agent-fast" => %{"min_cadence_ms" => 1_000},
          "agent-slow" => %{"min_cadence_ms" => 600_000}
        }
      }
    })

    {:ok, fast_pid} =
      Scheduler.start_link("workspace-1", "agent-fast",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        schedule_first_tick: false
      )

    {:ok, slow_pid} =
      Scheduler.start_link("workspace-1", "agent-slow",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        schedule_first_tick: false
      )

    assert %{min_cadence_ms: 1_000} = Scheduler.status(fast_pid)
    assert %{min_cadence_ms: 600_000} = Scheduler.status(slow_pid)
  end
end
