defmodule SymphonyElixir.Integration.ManagerLocalSmokeTest do
  @moduledoc """
  End-to-end smoke for the manager-on-local path.

  Stubs the local-relay registry plus a PostgREST endpoint so the
  manager can dispatch a turn through `LocalRelay`, exercise capability
  negotiation, round-trip a `snooze` tool call, and complete — all
  in-process. Catches wire and capability regressions on the manager
  path without needing a real helper binary or network. See
  `docs/local-model-readiness-runtime-prs.md` PR4.

  Note: the helper stub advertises `runtime_managed_tools` without the
  retired `manager_tool_calling` key so this test catches capability
  rename regressions.
  """

  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.Manager.ModelClient
  alias SymphonyElixir.Manager.Scheduler
  alias SymphonyElixir.Manager.WorkItemRow
  alias SymphonyElixir.Runner.LlmToolRunner, as: Manager
  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.WorkItem

  defmodule OnboardingGatewayConfig do
    def fetch("workspace", workspace_id) do
      {:ok,
       %Resolved{
         scope_type: "workspace",
         scope_id: workspace_id,
         config_hash: "onboarding-hash",
         version: 1,
         config_json: %{
           "runners" => %{
             "planner" => %{
               "agent_id" => "planning-agent-1",
               "provider" => "local",
               "model" => "qwen",
               "target_runner_kind" => "openai_compatible"
             },
             "codex" => %{
               "agent_id" => "coding-agent-1",
               "provider" => "local",
               "model" => "qwen",
               "target_runner_kind" => "openai_compatible"
             },
             "manager" => %{
               "agent_id" => "manager-agent-1",
               "provider" => "local",
               "model" => "qwen",
               "target_runner_kind" => "openai_compatible",
               "min_cadence_ms" => 60_000
             }
           }
         }
       }}
    end

    def fetch(_scope_type, _scope_id), do: {:error, :not_found}
  end

  defmodule OnboardingWorkItemsSource do
    def due_work_items(workspace_id, agent_id, now, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :manager_local_smoke_test_pid)
      send(test_pid, {:onboarding_due_query, {workspace_id, agent_id, now, opts}})

      reference_now = Application.fetch_env!(:symphony_elixir, :manager_local_smoke_now)

      rows = [
        %WorkItemRow{
          id: "00000000-0000-0000-0000-000000000101",
          identifier: "ONBOARD-1",
          title: "Verify default manager launch",
          state: "running",
          workspace_id: "00000000-0000-0000-0000-000000000001",
          next_poll_at: DateTime.add(reference_now, -5, :second),
          manager_runner_id: "manager-agent-1",
          metadata: %{"runner_type" => "manager", "source" => "onboarding_smoke"}
        }
      ]

      {:ok, Enum.map(rows, &WorkItemRow.to_work_item/1)}
    end
  end

  defmodule OnboardingAgentInventory do
    def get_agent("manager-agent-1") do
      {:ok,
       %Agent{
         id: "manager-agent-1",
         workspace_id: "00000000-0000-0000-0000-000000000001",
         created_by_user_id: "user-1",
         type: "manager"
       }}
    end
  end

  defmodule OnboardingExecutionProfile do
    def resolve("manager-agent-1", workspace_id, _opts) do
      {:ok,
       %{
         agent_id: "manager-agent-1",
         workspace_id: workspace_id,
         runner_kind: "manager",
         provider: "local",
         model: "qwen",
         api_key: "local-runtime"
       }}
    end
  end

  setup do
    Registry.reset!()

    Application.put_env(:symphony_elixir, :manager_responses_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :manager_openai_compatible_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :manager_tools_req_options, plug: {Req.Test, __MODULE__})
    Application.put_env(:symphony_elixir, :manager_local_smoke_test_pid, self())
    Application.put_env(:symphony_elixir, :manager_local_smoke_now, ~U[2026-05-11 12:00:00Z])

    Application.put_env(:symphony_elixir, :manager_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_responses_req_options)
      Application.delete_env(:symphony_elixir, :manager_openai_compatible_req_options)
      Application.delete_env(:symphony_elixir, :manager_tools_req_options)
      Application.delete_env(:symphony_elixir, :manager_local_smoke_test_pid)
      Application.delete_env(:symphony_elixir, :manager_local_smoke_now)
      Application.delete_env(:symphony_elixir, :manager_tools)
      Registry.reset!()
    end)

    :ok
  end

  test "negotiates capabilities, round-trips a snooze tool call, and emits turn events" do
    test_pid = self()
    helper = start_manager_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:work_items_patch, URI.decode_query(conn.query_string), Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    on_message = fn message -> send(test_pid, {:manager_event, message}) end

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1",
          on_message: on_message
        },
        nil
      )

    assert session.model_client == ModelClient.LocalRelay
    assert session.api_key == "local-runtime"

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"response_id" => correlation_id, "output_text" => "Snoozed via local relay."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert is_binary(correlation_id)

    # Helper received a dispatch frame with capability requirements and provider tool specs.
    assert_received {:manager_dispatch,
                     %{
                       "type" => "dispatch",
                       "target_runner_kind" => "openai_compatible",
                       "provider" => "local",
                       "model" => "qwen",
                       "capability_requirements" => capability_requirements,
                       "provider_tool_specs" => provider_tool_specs
                     }}

    assert is_map(capability_requirements)
    assert capability_requirements != %{}

    assert Enum.map(provider_tool_specs, &get_in(&1, ["function", "name"])) ==
             Enum.map(ToolRegistry.bundle(:manager), &String.replace(&1, ".", "_"))

    # snooze round-tripped: PostgREST patch hit, continuation frame carried tool output.
    assert_received {:work_items_patch, %{"id" => "eq.work-1", "workspace_id" => "eq.workspace-1"}, %{"next_poll_at" => next_poll_at}}
    assert {:ok, _datetime, _offset} = DateTime.from_iso8601(next_poll_at)

    assert_received {:manager_continuation,
                     %{
                       "type" => "dispatch",
                       "tool_outputs" => [%{"call_id" => "call-1", "output" => output}],
                       "messages" => [%{"role" => "tool", "tool_call_id" => "call-1", "content" => content}]
                     }}

    assert content == output
    assert %{"work_item_id" => "work-1", "next_poll_at" => _next_poll_at} = Jason.decode!(output)

    # Lifecycle events emitted via on_message.
    assert_received {:manager_event, %{event: :tool_call_completed, payload: %{"params" => %{"tool" => "snooze"}}}}

    assert_received {:manager_event,
                     %{
                       event: :notification,
                       payload: %{"params" => %{"textDelta" => "Snoozed via local relay."}}
                     }}

    assert_received {:manager_event, %{event: :turn_completed, payload: %{"id" => ^correlation_id}}}

    assert :ok = Manager.stop_session(session)
  end

  test "maps provider-safe local relay git_run tool call back to git.run with command arguments" do
    test_pid = self()
    helper = start_provider_safe_git_run_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    on_message = fn message -> send(test_pid, {:manager_event, message}) end

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1",
          "tool_definitions" => ToolRegistry.specs(["git.run"]),
          on_message: on_message
        },
        nil
      )

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"output_text" => "There are 2 open PRs."}} =
             Manager.run_turn(session, "How many open PRs are in https://github.com/kmgrassi/OpenMacaw?", work_item)

    assert_received {:manager_dispatch, frame}
    assert ["git_run"] = provider_tool_names(frame)
    assert [%{"name" => "git.run", "execution_kind" => "helper"}] = frame["tool_definitions"]

    assert_received {:helper_tool_execution_request,
                     %{
                       "name" => "git.run",
                       "arguments" => %{
                         "command" => "gh pr list --repo kmgrassi/OpenMacaw --state open --json number --jq length"
                       }
                     }}

    assert_received {:manager_event,
                     %{
                       event: :tool_call_completed,
                       payload: %{"params" => %{"tool" => "git.run"}}
                     }}

    assert :ok = Manager.stop_session(session)
  end

  test "returns retryable local_runtime_offline when no helper is registered" do
    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "local",
          "model" => "qwen",
          "workspace_id" => "workspace-1"
        },
        nil
      )

    assert session.model_client == ModelClient.LocalRelay

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:error, {:retryable, :local_runtime_offline}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert :ok = Manager.stop_session(session)
  end

  test "scheduler launches onboarding manager agent through local relay and receives result frame" do
    test_pid = self()
    helper = start_manager_completion_helper(test_pid)

    Registry.register(%{
      workspace_id: "00000000-0000-0000-0000-000000000001",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    scheduler_registry = :"manager_onboarding_smoke_registry_#{System.unique_integer([:positive])}"
    start_supervised!({Elixir.Registry, keys: :unique, name: scheduler_registry})

    now = Application.fetch_env!(:symphony_elixir, :manager_local_smoke_now)

    {:ok, scheduler} =
      Scheduler.start_link(
        "00000000-0000-0000-0000-000000000001",
        "manager-agent-1",
        registry: scheduler_registry,
        work_item_source: OnboardingWorkItemsSource,
        session_resolver: OnboardingExecutionProfile,
        agent_inventory: OnboardingAgentInventory,
        clock: fn -> now end,
        schedule_first_tick: false
      )

    assert %{
             status: :running,
             agent_id: "manager-agent-1",
             provider: "local",
             model: "qwen",
             batch: %{total: 1, ok: 1, error: 0}
           } = Scheduler.tick(scheduler)

    assert_received {:onboarding_due_query, {"00000000-0000-0000-0000-000000000001", "manager-agent-1", _now, _opts}}

    assert_received {:manager_dispatch,
                     %{
                       "type" => "dispatch",
                       "workspace_id" => "00000000-0000-0000-0000-000000000001",
                       "agent_id" => "manager-agent-1",
                       "target_runner_kind" => "openai_compatible",
                       "provider" => "local",
                       "model" => "qwen",
                       "capability_requirements" => capability_requirements,
                       "tool_calling_mode" => "runtime_managed"
                     }}

    assert capability_requirements["runtime_managed_tools"] == true
    refute Map.has_key?(capability_requirements, "manager_tool_calling")

    assert %{status: :running, last_tick_at: ^now, last_decision_count: 1, last_error: nil} =
             Scheduler.status(scheduler)
  end

  test "next local manager start uses the changed effective grant tool set" do
    test_pid = self()
    helper = start_manager_completion_helper(test_pid)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-1",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "ollama",
          model: "qwen",
          capabilities: %{runtime_managed_tools: true}
        }
      ]
    })

    {:ok, first_session} =
      Manager.start_session(manager_config(ToolRegistry.specs(["snooze"])), nil)

    assert {:ok, _result} = Manager.run_turn(first_session, ~s({"due_tasks":[]}), work_item())
    assert_received {:manager_dispatch, first_frame}
    assert provider_tool_names(first_frame) == ["snooze"]
    assert :ok = Manager.stop_session(first_session)

    {:ok, second_session} =
      Manager.start_session(manager_config(ToolRegistry.specs(["dispatch_runner"])), nil)

    assert {:ok, _result} = Manager.run_turn(second_session, ~s({"due_tasks":[]}), work_item())
    assert_received {:manager_dispatch, second_frame}
    assert provider_tool_names(second_frame) == ["dispatch_runner"]
    assert :ok = Manager.stop_session(second_session)
  end

  defp start_manager_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:manager_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-1",
                "name" => "snooze",
                "arguments" => %{"work_item_id" => "work-1", "seconds" => 300}
              }
            ]
          })

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:manager_continuation, continuation})

              Registry.complete(correlation_id, %{
                "output_text" => "Snoozed via local relay.",
                "usage" => %{"total_tokens" => 9}
              })
          end
      end
    end)
  end

  defp start_manager_completion_helper(parent) do
    spawn_link(fn -> manager_completion_loop(parent) end)
  end

  defp start_provider_safe_git_run_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:manager_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-git",
                "name" => "git.run",
                "arguments" => %{
                  "command" => "gh pr list --repo kmgrassi/OpenMacaw --state open --json number --jq length"
                }
              }
            ]
          })

          receive do
            {:local_relay_tool_execution_request, request} ->
              send(parent, {:helper_tool_execution_request, request})

              Registry.tool_call_result(correlation_id, %{
                "type" => "tool_call_result",
                "tool_call_id" => "call-git",
                "success" => true,
                "output" => %{"ok" => true, "stdout" => "2\n", "stderr" => ""}
              })
          end

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:manager_continuation, continuation})

              Registry.complete(correlation_id, %{
                "output_text" => "There are 2 open PRs.",
                "usage" => %{"total_tokens" => 9}
              })
          end
      end
    end)
  end

  defp manager_completion_loop(parent) do
    receive do
      {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
        send(parent, {:manager_dispatch, frame})

        Registry.complete(correlation_id, %{
          "id" => correlation_id,
          "output" => [
            %{"type" => "message", "content" => [%{"type" => "output_text", "text" => "completed"}]}
          ],
          "usage" => %{"total_tokens" => 1}
        })

        manager_completion_loop(parent)
    end
  end

  defp manager_config(tool_definitions) do
    %{
      "provider" => "local",
      "model" => "qwen",
      "workspace_id" => "workspace-1",
      "tool_definitions" => tool_definitions
    }
  end

  defp provider_tool_names(frame) do
    frame
    |> Map.fetch!("provider_tool_specs")
    |> Enum.map(&get_in(&1, ["function", "name"]))
  end

  defp work_item, do: %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}
end
