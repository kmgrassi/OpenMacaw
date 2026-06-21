defmodule SymphonyElixir.Manager.SchedulerSessionResolutionTest do
  use SymphonyElixir.Manager.SchedulerCase

  test "persisted manager config starts a runnable manager session", %{registry: registry} do
    workspace_id = "workspace-1"

    row = %WorkItemRow{
      id: "00000000-0000-0000-0000-000000000001",
      identifier: "WI-1",
      title: "Address review",
      state: "running",
      workspace_id: workspace_id,
      next_poll_at: ~U[2026-04-25 11:59:00Z],
      metadata: %{}
    }

    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [row])

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "openai",
          "model" => "gpt-test",
          "api_key" => "sk-test",
          "credential_id" => "credential-1"
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link(workspace_id, "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, %{"workspace_id" => ^workspace_id, "model" => "gpt-test"}}

    assert %{
             status: :running,
             missing: [],
             provider: "openai",
             model: "gpt-test",
             last_decision_count: 1,
             batch: %{total: 1}
           } = Scheduler.tick(pid)

    assert_received {:post_message, %{workspace_id: ^workspace_id}, body, opts}
    assert %{"due_tasks" => [work_item]} = Jason.decode!(body)
    assert work_item["id"] == row.id
    assert opts[:work_item_ids] == [row.id]
    refute_received {:manager_session_started, _config}
  end

  test "resolved manager session includes the agent context", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "openai",
          "model" => "gpt-test",
          "api_key" => "sk-test",
          "context" => "Always respond in haiku."
        }
      }
    })

    {:ok, _pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, %{"agent_context" => "Always respond in haiku."}}
  end

  test "resolved manager session omits agent_context when no context is set", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "openai",
          "model" => "gpt-test",
          "api_key" => "sk-test"
        }
      }
    })

    {:ok, _pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, config}
    refute Map.has_key?(config, "agent_context")
  end

  test "resolved manager session includes granted tool definitions", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_tool_definition_resolver, TestToolDefinitionResolver)

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"provider" => "local", "model" => "qwen3-coder:30b"}}
    })

    {:ok, _pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, %{"tool_definitions" => tool_definitions}}

    assert [
             %{
               "name" => "git.run",
               "parameters_schema" => %{"properties" => %{"command" => %{"type" => "string"}}},
               "execution_kind" => "shell"
             }
           ] = tool_definitions
  end

  test "resolved manager session refreshes when granted tool definitions change", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_tool_definition_resolver, TestToolDefinitionResolver)

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"provider" => "local", "model" => "qwen3-coder:30b"}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, %{"tool_definitions" => [%{"name" => "git.run"}]}}

    Application.put_env(:symphony_elixir, :manager_scheduler_tool_definitions, [
      %{
        "name" => "scheduled_task.list",
        "description" => "List scheduled tasks",
        "parameters_schema" => %{"type" => "object", "properties" => %{}},
        "execution_kind" => "database"
      }
    ])

    assert %{status: :running, batch: %{total: 0}} = Scheduler.tick(pid)

    assert_received {:manager_session_started,
                     %{
                       "tool_definitions" => [
                         %{"name" => "scheduled_task.list", "execution_kind" => "database"}
                       ]
                     }}
  end

  test "resolved manager session is reused when persisted identity is unchanged", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "openai",
          "model" => "gpt-test",
          "api_key" => "sk-test",
          "credential_id" => "credential-1"
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started, %{"workspace_id" => "workspace-1"}}

    assert %{status: :running, batch: %{total: 0}} = Scheduler.tick(pid)
    refute_received {:manager_session_started, _config}
  end

  test "missing manager credential is idle and skips due work", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [
      %WorkItemRow{
        id: "00000000-0000-0000-0000-000000000001",
        identifier: "WI-1",
        title: "Address review",
        state: "running",
        workspace_id: "workspace-1",
        next_poll_at: ~U[2026-04-25 11:59:00Z],
        metadata: %{}
      }
    ])

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"provider" => "openai", "model" => "gpt-test"}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    assert %{
             status: :idle_awaiting_credential,
             missing: ["credential"],
             idle_reason: :credential_missing,
             batch: %{total: 0}
           } = Scheduler.tick(pid)

    refute_received {:due_query, _query}
    refute_received {:post_message, _scope, _body, _opts}
  end

  test "logs idle scheduler skip reason without polling", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{"manager" => %{"provider" => "openai", "model" => "gpt-test"}}
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        clock: fn -> ~U[2026-04-25 12:00:00Z] end,
        schedule_first_tick: false
      )

    log = capture_log(fn -> assert %{batch: %{total: 0}} = Scheduler.tick(pid) end)
    events = decode_logged_events!(log)

    assert %{
             "skip_reason" => "missing_session",
             "due_count" => 0,
             "picked_count" => 0,
             "skipped_count" => 1,
             "scheduler_health" => "idle_awaiting_credential"
           } = event!(events, "manager_work_item_poll_skipped")

    refute Enum.any?(events, &(Map.get(&1, "event") == "manager_work_item_poll_started"))
  end

  test "local manager config resolves without a hosted credential", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "local",
          "model" => "qwen",
          "target_runner_kind" => "openai_compatible"
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started,
                     %{"provider" => "local", "model" => "qwen", "api_key" => "local-runtime"}}

    assert %{status: :running, provider: "local", model: "qwen", missing: []} = Scheduler.status(pid)
  end

  test "persisted manager credential_id resolves through agent inventory", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [])

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "agent_id" => "manager-agent-1",
          "provider" => "openai",
          "model" => "gpt-test",
          "credential_id" => "credential-1:OPENAI_API_KEY"
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        agent_inventory: TestAgentInventory,
        secret_resolver: TestSecretResolver,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started,
                     %{
                       "agent_id" => "manager-agent-1",
                       "credential_id" => "credential-1:OPENAI_API_KEY",
                       "api_key" => "sk-stored"
                     }}

    assert %{status: :running, credential_id: "credential-1:OPENAI_API_KEY", agent_id: "manager-agent-1"} =
             Scheduler.status(pid)
  end

  test "persisted manager credential row id resolves through agent inventory", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [])

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "agent_id" => "manager-agent-1",
          "provider" => "openai",
          "model" => "gpt-test",
          "credential_id" => "credential-1"
        }
      }
    })

    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        runner: TestRunner,
        agent_inventory: TestAgentInventory,
        secret_resolver: TestSecretResolver,
        schedule_first_tick: false
      )

    assert_received {:manager_session_started,
                     %{
                       "agent_id" => "manager-agent-1",
                       "credential_id" => "credential-1:OPENAI_API_KEY",
                       "api_key" => "sk-stored"
                     }}

    assert %{status: :running, credential_id: "credential-1:OPENAI_API_KEY", agent_id: "manager-agent-1"} =
             Scheduler.status(pid)
  end

  test "session resolver errors surface structured error codes and inspectable reasons",
       %{registry: registry} do
    {:ok, pid} =
      Scheduler.start_link("workspace-1", "manager-agent-1",
        registry: registry,
        work_item_source: TestWorkItemSource,
        chat_gateway: TestChatGateway,
        session_resolver: ErrorSessionResolver,
        schedule_first_tick: false
      )

    assert %{
             status: :error,
             reason: "{:adapter_failed, :timeout}",
             last_error: %{
               kind: "adapter_failed",
               error_code: "manager_session_resolution_failed",
               retryable: false
             }
           } = Scheduler.status(pid)
  end
end
