defmodule SymphonyElixir.Orchestrator.SnapshotStateTest do
  use SymphonyElixir.TestSupport

  import SymphonyElixir.TestSupport.OrchestratorStatus

  test "snapshot returns :timeout when snapshot server is unresponsive" do
    server_name = Module.concat(__MODULE__, :UnresponsiveSnapshotServer)
    parent = self()

    pid =
      spawn(fn ->
        Process.register(self(), server_name)
        send(parent, :snapshot_server_ready)

        receive do
          :stop -> :ok
        end
      end)

    assert_receive :snapshot_server_ready, 1_000
    assert Orchestrator.snapshot(server_name, 10) == :timeout

    send(pid, :stop)
  end

  test "orchestrator snapshot does not query launcher workspace capacity" do
    parent = self()
    pid = start_orchestrator!(__MODULE__, :SnapshotWithoutLauncherReentry)

    :sys.replace_state(pid, fn state ->
      if is_reference(state.tick_timer_ref), do: Process.cancel_timer(state.tick_timer_ref)
      %{state | tick_timer_ref: nil, tick_token: nil, next_poll_due_at_ms: nil}
    end)

    launcher =
      spawn(fn ->
        Process.register(self(), SymphonyElixir.Launcher.Server)
        send(parent, :launcher_registered)

        receive do
          {:"$gen_call", from, request} ->
            send(parent, {:unexpected_launcher_call, request})
            GenServer.reply(from, {:ok, 0})

            receive do
              :stop -> :ok
            end

          :stop ->
            :ok
        end
      end)

    on_exit(fn ->
      if Process.alive?(launcher), do: send(launcher, :stop)
    end)

    assert_receive :launcher_registered, 1_000

    snapshot = Orchestrator.snapshot(pid, 100)

    assert is_map(snapshot)
    refute_received {:unexpected_launcher_call, _request}
  end

  test "orchestrator snapshot reflects last codex update and session id" do
    issue_id = "issue-snapshot"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-188",
        title: "Snapshot test",
        description: "Capture codex state"
      })

    pid = start_orchestrator!(__MODULE__, :SnapshotOrchestrator)
    attach_running_issue!(pid, issue)
    now = DateTime.utc_now()

    send(pid, {:codex_worker_update, issue_id, %{event: :session_started, session_id: "thread-live-turn-live", timestamp: now}})

    send(
      pid,
      {:codex_worker_update, issue_id, %{event: :notification, payload: %{method: "some-event"}, timestamp: now}}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.issue_id == issue_id
    assert snapshot_entry.session_id == "thread-live-turn-live"
    assert snapshot_entry.turn_count == 1
    assert snapshot_entry.last_codex_timestamp == now

    assert snapshot_entry.last_codex_message == %{
             event: :notification,
             message: %{method: "some-event"},
             timestamp: now
           }
  end

  test "orchestrator snapshot tracks codex thread totals and app-server pid" do
    issue_id = "issue-usage-snapshot"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-201",
        title: "Usage snapshot test",
        description: "Collect usage stats"
      })

    pid = start_orchestrator!(__MODULE__, :UsageOrchestrator)
    process_ref = make_ref()
    attach_running_issue!(pid, issue, %{ref: process_ref})
    now = DateTime.utc_now()

    send(pid, {:codex_worker_update, issue_id, %{event: :session_started, session_id: "thread-usage-turn-usage", timestamp: now}})

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "thread/tokenUsage/updated",
           "params" => %{
             "tokenUsage" => %{
               "total" => %{"inputTokens" => 12, "outputTokens" => 4, "totalTokens" => 16}
             }
           }
         },
         timestamp: now,
         codex_app_server_pid: "4242"
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_app_server_pid == "4242"
    assert snapshot_entry.codex_input_tokens == 12
    assert snapshot_entry.codex_output_tokens == 4
    assert snapshot_entry.codex_total_tokens == 16
    assert snapshot_entry.turn_count == 1
    assert is_integer(snapshot_entry.runtime_seconds)

    send(pid, {:DOWN, process_ref, :process, self(), :normal})
    completed_state = :sys.get_state(pid)

    assert completed_state.codex_totals.input_tokens == 12
    assert completed_state.codex_totals.output_tokens == 4
    assert completed_state.codex_totals.total_tokens == 16
    assert is_integer(completed_state.codex_totals.seconds_running)
  end

  test "orchestrator snapshot tracks turn completed usage when present" do
    issue_id = "issue-turn-completed-usage"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-202",
        title: "Turn completed usage test",
        description: "Track final turn usage"
      })

    pid = start_orchestrator!(__MODULE__, :TurnCompletedUsageOrchestrator)
    process_ref = make_ref()
    attach_running_issue!(pid, issue, %{ref: process_ref})

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :turn_completed,
         payload: %{method: "turn/completed", usage: %{"input_tokens" => "12", "output_tokens" => 4, "total_tokens" => 16}},
         timestamp: DateTime.utc_now()
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_input_tokens == 12
    assert snapshot_entry.codex_output_tokens == 4
    assert snapshot_entry.codex_total_tokens == 16

    send(pid, {:DOWN, process_ref, :process, self(), :normal})
    completed_state = :sys.get_state(pid)
    assert completed_state.codex_totals.input_tokens == 12
    assert completed_state.codex_totals.output_tokens == 4
    assert completed_state.codex_totals.total_tokens == 16
  end

  test "orchestrator snapshot tracks codex token-count cumulative usage payloads" do
    issue_id = "issue-token-count-snapshot"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-220",
        title: "Token count snapshot test",
        description: "Validate token-count style payloads"
      })

    pid = start_orchestrator!(__MODULE__, :TokenCountOrchestrator)
    process_ref = make_ref()
    attach_running_issue!(pid, issue, %{ref: process_ref})
    now = DateTime.utc_now()

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "codex/event/token_count",
           "params" => %{
             "msg" => %{
               "type" => "token_count",
               "info" => %{
                 "total_token_usage" => %{"input_tokens" => "2", "output_tokens" => 2, "total_tokens" => 4}
               }
             }
           }
         },
         timestamp: now
       }}
    )

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "codex/event/token_count",
           "params" => %{
             "msg" => %{
               "type" => "token_count",
               "info" => %{
                 "total_token_usage" => %{"prompt_tokens" => 10, "completion_tokens" => 5, "total_tokens" => 15}
               }
             }
           }
         },
         timestamp: DateTime.utc_now()
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_input_tokens == 10
    assert snapshot_entry.codex_output_tokens == 5
    assert snapshot_entry.codex_total_tokens == 15

    send(pid, {:DOWN, process_ref, :process, self(), :normal})
    completed_state = :sys.get_state(pid)
    assert completed_state.codex_totals.input_tokens == 10
    assert completed_state.codex_totals.output_tokens == 5
    assert completed_state.codex_totals.total_tokens == 15
  end

  test "orchestrator snapshot tracks codex rate-limit payloads" do
    issue_id = "issue-rate-limit-snapshot"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-221",
        title: "Rate limit snapshot test",
        description: "Capture codex rate limit state"
      })

    pid = start_orchestrator!(__MODULE__, :RateLimitOrchestrator)
    attach_running_issue!(pid, issue)

    rate_limits = %{
      "limit_id" => "codex",
      "primary" => %{"remaining" => 90, "limit" => 100},
      "secondary" => nil,
      "credits" => %{"has_credits" => false, "unlimited" => false, "balance" => nil}
    }

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "codex/event/token_count",
           "params" => %{
             "msg" => %{
               "type" => "event_msg",
               "payload" => %{"type" => "token_count", "rate_limits" => rate_limits}
             }
           }
         },
         timestamp: DateTime.utc_now()
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert snapshot.rate_limits == rate_limits
  end

  test "orchestrator token accounting prefers total_token_usage over last_token_usage in token_count payloads" do
    issue_id = "issue-token-precedence"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-222",
        title: "Token precedence",
        description: "Prefer per-event deltas"
      })

    pid = start_orchestrator!(__MODULE__, :TokenPrecedenceOrchestrator)
    attach_running_issue!(pid, issue)

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "codex/event/token_count",
           "params" => %{
             "msg" => %{
               "type" => "event_msg",
               "payload" => %{
                 "type" => "token_count",
                 "info" => %{
                   "last_token_usage" => %{"input_tokens" => 2, "output_tokens" => 1, "total_tokens" => 3},
                   "total_token_usage" => %{"input_tokens" => 200, "output_tokens" => 100, "total_tokens" => 300}
                 }
               }
             }
           }
         },
         timestamp: DateTime.utc_now()
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_input_tokens == 200
    assert snapshot_entry.codex_output_tokens == 100
    assert snapshot_entry.codex_total_tokens == 300
  end

  test "orchestrator token accounting accumulates monotonic thread token usage totals" do
    issue_id = "issue-thread-token-usage"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-223",
        title: "Thread token usage",
        description: "Accumulate absolute thread totals"
      })

    pid = start_orchestrator!(__MODULE__, :ThreadTokenUsageOrchestrator)
    attach_running_issue!(pid, issue)

    for usage <- [
          %{"input_tokens" => 8, "output_tokens" => 3, "total_tokens" => 11},
          %{"input_tokens" => 10, "output_tokens" => 4, "total_tokens" => 14}
        ] do
      send(
        pid,
        {:codex_worker_update, issue_id,
         %{
           event: :notification,
           payload: %{
             "method" => "thread/tokenUsage/updated",
             "params" => %{"tokenUsage" => %{"total" => usage}}
           },
           timestamp: DateTime.utc_now()
         }}
      )
    end

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_input_tokens == 10
    assert snapshot_entry.codex_output_tokens == 4
    assert snapshot_entry.codex_total_tokens == 14
  end

  test "orchestrator token accounting ignores last_token_usage without cumulative totals" do
    issue_id = "issue-last-token-ignored"

    issue =
      build_issue(issue_id, %{
        identifier: "MT-224",
        title: "Last token ignored",
        description: "Ignore delta-only token reports"
      })

    pid = start_orchestrator!(__MODULE__, :LastTokenIgnoredOrchestrator)
    attach_running_issue!(pid, issue)

    send(
      pid,
      {:codex_worker_update, issue_id,
       %{
         event: :notification,
         payload: %{
           "method" => "codex/event/token_count",
           "params" => %{
             "msg" => %{
               "type" => "event_msg",
               "payload" => %{
                 "type" => "token_count",
                 "info" => %{
                   "last_token_usage" => %{"input_tokens" => 8, "output_tokens" => 3, "total_tokens" => 11}
                 }
               }
             }
           }
         },
         timestamp: DateTime.utc_now()
       }}
    )

    snapshot = GenServer.call(pid, :snapshot)
    assert %{running: [snapshot_entry]} = snapshot
    assert snapshot_entry.codex_input_tokens == 0
    assert snapshot_entry.codex_output_tokens == 0
    assert snapshot_entry.codex_total_tokens == 0
  end

  test "orchestrator snapshot includes retry backoff entries" do
    pid = start_orchestrator!(__MODULE__, :RetryOrchestrator)

    retry_entry = %{
      attempt: 2,
      timer_ref: nil,
      due_at_ms: System.monotonic_time(:millisecond) + 5_000,
      identifier: "MT-500",
      error: "agent exited: :boom"
    }

    :sys.replace_state(pid, fn state -> %{state | retry_attempts: %{"mt-500" => retry_entry}} end)

    snapshot = GenServer.call(pid, :snapshot)
    assert is_list(snapshot.retrying)

    assert [
             %{issue_id: "mt-500", attempt: 2, due_in_ms: due_in_ms, identifier: "MT-500", error: "agent exited: :boom"}
           ] = snapshot.retrying

    assert due_in_ms > 0
  end
end
