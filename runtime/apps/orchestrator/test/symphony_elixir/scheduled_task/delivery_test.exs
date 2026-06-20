defmodule SymphonyElixir.ScheduledTask.DeliveryTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ScheduledTask.Delivery

  defmodule TestRepository do
    def agent_workspace_id("agent-1", _opts), do: {:ok, "workspace-1"}
    def agent_workspace_id(_agent_id, _opts), do: {:error, :missing_workspace_context}
  end

  defmodule TestChatGateway do
    def post_message(scope, body, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_delivery_test_pid)
      send(test_pid, {:post_message, scope, body, opts})
      {:ok, Keyword.fetch!(opts, :run_id)}
    end
  end

  defmodule TestLearningSampler do
    def sample("workspace-1", %{"strategy" => "random_recent_run", "messageWindow" => 10}, _opts) do
      {:ok,
       %{
         "group" => "run:sample-run-1",
         "workspace_id" => "workspace-1",
         "messages" => [
           %{"role" => "user", "content" => "Please fix the retry bug."},
           %{"role" => "assistant", "content" => "I fixed it by adding a retry guard."}
         ]
       }}
    end
  end

  defmodule EmptyLearningSampler do
    def sample("workspace-1", %{"strategy" => "random_recent_run"}, _opts), do: {:ok, nil}
  end

  setup do
    Application.put_env(:symphony_elixir, :scheduled_task_delivery_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :scheduled_task_delivery_test_pid)
    end)
  end

  test "posts instructions through ChatGateway with scheduled metadata" do
    task = %{
      "id" => "scheduled-task-1",
      "workspace_id" => nil,
      "agent_id" => "agent-1",
      "instructions" => "Check the account",
      "delivery" => %{
        "kind" => "scheduled_agent_message",
        "metadata" => %{
          "kind" => "learning_meta_agent_daily_review",
          "sampling" => %{"strategy" => "random_recent_run", "messageWindow" => 10}
        }
      },
      "source_work_item_id" => "work-item-1",
      "created_by_user_id" => "user-1"
    }

    scheduled_run_id = "11111111-1111-4111-8111-111111111111"
    run = %{"id" => scheduled_run_id, "scheduled_for" => "2026-05-14T12:00:00Z"}

    assert {:ok, ^scheduled_run_id} =
             Delivery.deliver(task, run,
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               learning_sampler: TestLearningSampler,
               trace_id: "trace-1"
             )

    assert_receive {:post_message, scope, body, opts}
    assert body =~ "Check the account"
    assert body =~ "Transcript sample for this scheduled learning review"
    assert body =~ "Please fix the retry bug."

    assert scope == %{
             agent_id: "agent-1",
             workspace_id: "workspace-1",
             user_id: "user-1",
             session_key: "agent:agent-1:scheduled",
             history_window: 0
           }

    assert Keyword.fetch!(opts, :run_id) == scheduled_run_id
    assert Keyword.fetch!(opts, :await?) == true
    refute Keyword.has_key?(opts, :agent)

    assert Keyword.fetch!(opts, :metadata) == %{
             "source" => "scheduled_task",
             "kind" => "scheduled_agent_message",
             "sampling" => %{"strategy" => "random_recent_run", "messageWindow" => 10},
             "sample" => %{"status" => "attached", "group" => "run:sample-run-1"},
             "scheduled_task_id" => "scheduled-task-1",
             "scheduled_task_run_id" => scheduled_run_id,
             "scheduled_for" => "2026-05-14T12:00:00Z",
             "source_work_item_id" => "work-item-1"
           }
  end

  test "marks learning sample metadata unavailable when no recent transcript exists" do
    task = %{
      "id" => "scheduled-task-1",
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "instructions" => "Check the account",
      "delivery" => %{
        "kind" => "scheduled_agent_message",
        "metadata" => %{"sampling" => %{"strategy" => "random_recent_run"}}
      },
      "created_by_user_id" => "user-1"
    }

    assert {:ok, "run-1"} =
             Delivery.deliver(task, %{"id" => "run-1"},
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               learning_sampler: EmptyLearningSampler
             )

    assert_receive {:post_message, _scope, body, opts}
    assert body =~ "No recent transcript sample was available"
    assert Keyword.fetch!(opts, :metadata)["sample"] == %{"status" => "unavailable"}
  end

  test "accepts atom-keyed scheduled task inputs without converting dynamic atoms" do
    task = %{
      id: "scheduled-task-atom",
      workspace_id: nil,
      agent_id: "agent-1",
      instructions: "Check the atom-keyed task",
      delivery: %{kind: "scheduled_agent_message"},
      source_work_item_id: "work-item-atom",
      created_by_user_id: "user-atom"
    }

    scheduled_run_id = "22222222-2222-4222-8222-222222222222"
    run = %{id: scheduled_run_id, scheduled_for: "2026-05-14T12:00:00Z"}

    assert {:ok, ^scheduled_run_id} =
             Delivery.deliver(task, run,
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               trace_id: "trace-atom"
             )

    assert_receive {:post_message, scope, "Check the atom-keyed task", opts}

    assert scope == %{
             agent_id: "agent-1",
             workspace_id: "workspace-1",
             user_id: "user-atom",
             session_key: "agent:agent-1:scheduled",
             history_window: 0
           }

    assert Keyword.fetch!(opts, :metadata) == %{
             "source" => "scheduled_task",
             "kind" => "scheduled_agent_message",
             "scheduled_task_id" => "scheduled-task-atom",
             "scheduled_task_run_id" => scheduled_run_id,
             "scheduled_for" => "2026-05-14T12:00:00Z",
             "source_work_item_id" => "work-item-atom"
           }
  end

  test "rejects arbitrary delivery kinds" do
    task = %{
      "id" => "scheduled-task-1",
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "instructions" => "Check the account",
      "delivery" => %{"kind" => "shell"}
    }

    assert {:error, :unsupported_delivery_kind} =
             Delivery.deliver(task, %{"id" => "run-1"},
               repository: TestRepository,
               chat_gateway: TestChatGateway
             )
  end
end
