defmodule SymphonyElixir.ScheduledTask.SchedulerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ScheduledTask.Scheduler

  defmodule TestRepository do
    def due_tasks(now, limit) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_test_pid)
      send(test_pid, {:due_tasks, now, limit})
      {:ok, Application.fetch_env!(:symphony_elixir, :scheduled_task_due_tasks)}
    end

    def claim_run(task, scheduled_for, started_at) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_test_pid)
      send(test_pid, {:claim_run, task["id"], scheduled_for, started_at})

      case Application.get_env(:symphony_elixir, :scheduled_task_claim_result, :ok) do
        :conflict ->
          {:ok, :conflict}

        :ok ->
          {:ok,
           %{
             "id" => "11111111-1111-4111-8111-111111111111",
             "scheduled_task_id" => task["id"],
             "scheduled_for" => DateTime.to_iso8601(scheduled_for)
           }}
      end
    end

    def finish_run(run_id, payload) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_test_pid)
      send(test_pid, {:finish_run, run_id, payload})
      {:ok, Map.put(payload, "id", run_id)}
    end

    def update_task(task_id, payload) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_test_pid)
      send(test_pid, {:update_task, task_id, payload})
      {:ok, Map.put(payload, "id", task_id)}
    end

    def agent_workspace_id("agent-1", _opts), do: {:ok, "workspace-1"}
  end

  defmodule TestDelivery do
    def deliver(task, run, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_test_pid)
      send(test_pid, {:deliver, task, run, opts})
      Application.get_env(:symphony_elixir, :scheduled_task_delivery_result, {:ok, run["id"]})
    end
  end

  setup do
    Application.put_env(:symphony_elixir, :scheduled_task_test_pid, self())
    Application.put_env(:symphony_elixir, :scheduled_task_due_tasks, [task()])
    Application.delete_env(:symphony_elixir, :scheduled_task_claim_result)
    Application.delete_env(:symphony_elixir, :scheduled_task_delivery_result)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :scheduled_task_test_pid)
      Application.delete_env(:symphony_elixir, :scheduled_task_due_tasks)
      Application.delete_env(:symphony_elixir, :scheduled_task_claim_result)
      Application.delete_env(:symphony_elixir, :scheduled_task_delivery_result)
    end)

    :ok
  end

  test "claims a due occurrence and records delivered metadata" do
    {:ok, pid} =
      Scheduler.start_link(
        name: nil,
        repository: TestRepository,
        delivery: TestDelivery,
        clock: fn -> ~U[2026-05-14 12:00:05Z] end,
        schedule_first_tick: false
      )

    assert %{total: 1, delivered: 1, failed: 0, skipped: 0} = Scheduler.tick(pid)

    assert_receive {:due_tasks, ~U[2026-05-14 12:00:05Z], 25}
    assert_receive {:claim_run, "scheduled-task-1", ~U[2026-05-14 12:00:00Z], ~U[2026-05-14 12:00:05Z]}
    assert_receive {:deliver, %{"id" => "scheduled-task-1"}, %{"id" => run_id}, opts}
    assert run_id == "11111111-1111-4111-8111-111111111111"
    assert Keyword.fetch!(opts, :repository) == TestRepository
    assert Keyword.fetch!(opts, :trace_id)

    assert_receive {:finish_run, ^run_id,
                    %{
                      "status" => "delivered",
                      "finished_at" => "2026-05-14T12:00:05Z",
                      "run_id" => ^run_id
                    }}

    assert_receive {:update_task, "scheduled-task-1",
                    %{
                      "last_run_status" => "delivered",
                      "last_error" => nil,
                      "last_run_at" => "2026-05-14T12:00:00Z",
                      "next_run_at" => "2026-05-14T13:00:00Z"
                    }}
  end

  test "skips already claimed occurrences without delivering" do
    Application.put_env(:symphony_elixir, :scheduled_task_claim_result, :conflict)

    {:ok, pid} =
      Scheduler.start_link(
        name: nil,
        repository: TestRepository,
        delivery: TestDelivery,
        clock: fn -> ~U[2026-05-14 12:00:05Z] end,
        schedule_first_tick: false
      )

    assert %{total: 1, delivered: 0, failed: 0, skipped: 1} = Scheduler.tick(pid)
    refute_receive {:deliver, _task, _run, _opts}
    refute_receive {:finish_run, _run_id, _payload}
  end

  test "failed delivery records the failure and advances next_run_at" do
    Application.put_env(:symphony_elixir, :scheduled_task_delivery_result, {:error, :provider_timeout})

    {:ok, pid} =
      Scheduler.start_link(
        name: nil,
        repository: TestRepository,
        delivery: TestDelivery,
        clock: fn -> ~U[2026-05-14 12:00:05Z] end,
        schedule_first_tick: false
      )

    assert %{total: 1, delivered: 0, failed: 1, skipped: 0} = Scheduler.tick(pid)

    assert_receive {:finish_run, "11111111-1111-4111-8111-111111111111",
                    %{
                      "status" => "failed",
                      "finished_at" => "2026-05-14T12:00:05Z",
                      "error" => "provider_timeout"
                    }}

    assert_receive {:update_task, "scheduled-task-1",
                    %{
                      "last_run_status" => "failed",
                      "last_error" => "provider_timeout",
                      "next_run_at" => "2026-05-14T13:00:00Z"
                    }}
  end

  defp task do
    %{
      "id" => "scheduled-task-1",
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "instructions" => "Run the scheduled check",
      "enabled" => true,
      "schedule" => %{"every" => "hour"},
      "timezone" => "Etc/UTC",
      "next_run_at" => "2026-05-14T12:00:00Z",
      "delivery" => %{"kind" => "scheduled_agent_message"},
      "source_work_item_id" => "work-item-1"
    }
  end
end
