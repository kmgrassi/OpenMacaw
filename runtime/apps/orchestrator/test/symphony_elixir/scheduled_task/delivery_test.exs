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
      "delivery" => %{"kind" => "scheduled_agent_message"},
      "source_work_item_id" => "work-item-1",
      "created_by_user_id" => "user-1"
    }

    scheduled_run_id = "11111111-1111-4111-8111-111111111111"
    run = %{"id" => scheduled_run_id, "scheduled_for" => "2026-05-14T12:00:00Z"}

    assert {:ok, ^scheduled_run_id} =
             Delivery.deliver(task, run,
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               trace_id: "trace-1"
             )

    assert_receive {:post_message, scope, "Check the account", opts}

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
             "scheduled_task_id" => "scheduled-task-1",
             "scheduled_task_run_id" => scheduled_run_id,
             "scheduled_for" => "2026-05-14T12:00:00Z",
             "source_work_item_id" => "work-item-1"
           }
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

  defmodule TestPlatformLearningClient do
    def post_job(kind, payload, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :scheduled_task_delivery_test_pid)
      send(test_pid, {:platform_learning_job, kind, payload, opts})

      case Application.get_env(:symphony_elixir, :scheduled_task_delivery_test_platform_result) do
        {:error, _} = error -> error
        _ -> {:ok, %{"accepted" => true}}
      end
    end
  end

  test "routes learning_reflection rows to the platform learning client (not ChatGateway)" do
    task = %{
      "id" => "scheduled-task-2",
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "source_work_item_id" => "work-item-7",
      "next_run_at" => "2026-05-18T12:00:00Z",
      "delivery" => %{
        "kind" => "learning_reflection",
        "sourceRunId" => "run-9001",
        "sourceTaskId" => "work-item-7"
      }
    }

    scheduled_run_id = "33333333-3333-4333-8333-333333333333"
    run = %{"id" => scheduled_run_id, "scheduled_for" => "2026-05-18T12:00:01Z"}

    assert {:ok, ^scheduled_run_id} =
             Delivery.deliver(task, run,
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               platform_learning_client: TestPlatformLearningClient,
               trace_id: "trace-reflect-1"
             )

    # ChatGateway must NOT be called for learning_* kinds.
    refute_received {:post_message, _, _, _}

    assert_receive {:platform_learning_job, "learning_reflection", payload, opts}

    assert payload["kind"] == "learning_reflection"
    assert payload["workspace_id"] == "workspace-1"
    assert payload["agent_id"] == "agent-1"
    assert payload["scheduled_task_id"] == "scheduled-task-2"
    assert payload["scheduled_task_run_id"] == scheduled_run_id
    assert payload["scheduled_run_id"] == scheduled_run_id
    assert payload["source_work_item_id"] == "work-item-7"
    assert payload["scheduled_for"] == "2026-05-18T12:00:01Z"
    assert payload["trace_id"] == "trace-reflect-1"

    assert payload["delivery"] == %{
             "kind" => "learning_reflection",
             "sourceRunId" => "run-9001",
             "sourceTaskId" => "work-item-7"
           }

    assert Keyword.get(opts, :trace_id) == "trace-reflect-1"
  end

  test "routes learning_distillation rows to the platform learning client" do
    task = %{
      "id" => "scheduled-task-3",
      "workspace_id" => "workspace-1",
      "delivery" => %{"kind" => "learning_distillation", "windowDays" => 7}
    }

    scheduled_run_id = "44444444-4444-4444-8444-444444444444"
    run = %{"id" => scheduled_run_id}

    assert {:ok, ^scheduled_run_id} =
             Delivery.deliver(task, run,
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               platform_learning_client: TestPlatformLearningClient
             )

    assert_receive {:platform_learning_job, "learning_distillation", payload, _opts}
    assert payload["delivery"]["windowDays"] == 7
  end

  test "surfaces platform-handler errors as scheduler-visible failures" do
    Application.put_env(
      :symphony_elixir,
      :scheduled_task_delivery_test_platform_result,
      {:error, :missing_platform_learning_endpoint}
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :scheduled_task_delivery_test_platform_result)
    end)

    task = %{
      "id" => "scheduled-task-4",
      "workspace_id" => "workspace-1",
      "delivery" => %{"kind" => "learning_reflection", "sourceRunId" => "run-4"}
    }

    assert {:error, {:platform_learning_handler_failed, :missing_platform_learning_endpoint}} =
             Delivery.deliver(task, %{"id" => "run-4"},
               repository: TestRepository,
               chat_gateway: TestChatGateway,
               platform_learning_client: TestPlatformLearningClient
             )
  end
end
