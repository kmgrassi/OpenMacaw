defmodule SymphonyElixir.Manager.SchedulerTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.Manager.Scheduler
  alias SymphonyElixir.Manager.SchedulerTestSupport.ErrorChatGateway
  alias SymphonyElixir.Manager.SchedulerTestSupport.ErrorSessionResolver
  alias SymphonyElixir.Manager.SchedulerTestSupport.ErrorWorkItemSource
  alias SymphonyElixir.Manager.SchedulerTestSupport.RaisingChatGateway
  alias SymphonyElixir.Manager.SchedulerTestSupport.ReturningErrorWorkItemSource
  alias SymphonyElixir.Manager.WorkItemRow
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestAgentInventory
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestChatGateway
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestExecutionProfile
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestGatewayConfig
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestRunner
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestSecretResolver
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestToolDefinitionResolver
  alias SymphonyElixir.Manager.SchedulerTestSupport.TestWorkItemSource

  setup do
    registry = :"manager_scheduler_registry_#{System.unique_integer([:positive])}"

    Application.put_env(:symphony_elixir, :manager_scheduler_test_pid, self())
    Application.put_env(:symphony_elixir, :manager_scheduler_rows, [])
    Application.put_env(:symphony_elixir, :manager_scheduler_session_resolver, TestExecutionProfile)
    Application.put_env(:symphony_elixir, :launcher_gateway_config_adapter, TestGatewayConfig)
    Application.delete_env(:symphony_elixir, :manager_tool_definition_resolver)
    Application.delete_env(:symphony_elixir, :manager_scheduler_tool_definitions)
    Application.delete_env(:symphony_elixir, :manager_scheduler_gateway_config)

    start_supervised!({Registry, keys: :unique, name: registry})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_scheduler_test_pid)
      Application.delete_env(:symphony_elixir, :manager_scheduler_rows)
      Application.delete_env(:symphony_elixir, :manager_scheduler_gateway_config)
      Application.delete_env(:symphony_elixir, :manager_scheduler_session_resolver)
      Application.delete_env(:symphony_elixir, :manager_tool_definition_resolver)
      Application.delete_env(:symphony_elixir, :manager_scheduler_tool_definitions)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_adapter)
    end)

    %{registry: registry}
  end

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

    assert_received {:due_query,
                     {"workspace-1", "manager-agent-1", ^now, opts}}

    assert Keyword.fetch!(opts, :states) == ["running"]
    assert Keyword.fetch!(opts, :plan_ids) == ["00000000-0000-0000-0000-000000000010"]
    assert Keyword.fetch!(opts, :limit) == 7
  end

  test "workspace due_task_query states restrict poll query on each tick", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "due_task_query" => %{"states" => ["running"]}
        }
      }
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
        "manager" => %{
          agent_id => %{"due_task_query" => %{"plan_ids" => [plan_a]}}
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
      "runners" => %{
        "manager" => %{"min_cadence_ms" => 30_000}
      }
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

    # Cached state still reflects the old cadence until a tick fires.
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

  test "resolved manager session includes granted tool definitions", %{registry: registry} do
    Application.put_env(:symphony_elixir, :manager_tool_definition_resolver, TestToolDefinitionResolver)

    Application.put_env(:symphony_elixir, :manager_scheduler_gateway_config, %{
      "runners" => %{
        "manager" => %{
          "provider" => "local",
          "model" => "qwen3-coder:30b"
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
      "runners" => %{
        "manager" => %{
          "provider" => "local",
          "model" => "qwen3-coder:30b"
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

  test "resolved manager session is reused when persisted identity is unchanged", %{
    registry: registry
  } do
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
           } =
             Scheduler.tick(pid)

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
                     %{
                       "provider" => "local",
                       "model" => "qwen",
                       "api_key" => "local-runtime"
                     }}

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

  test "manager turn exceptions are logged with structured class, message, and tick phase", %{registry: registry} do
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

  test "status records provider errors and becomes unhealthy after repeated failures", %{registry: registry} do
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

  defp decode_logged_events!(log) do
    log
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/(\{.*\})/, line) do
        [_, json] -> [Jason.decode!(json)]
        _ -> []
      end
    end)
  end

  defp event!(events, event_name) do
    Enum.find(events, &(Map.get(&1, "event") == event_name)) ||
      flunk("expected log event #{event_name}, got: #{inspect(Enum.map(events, &Map.get(&1, "event")))}")
  end

end
