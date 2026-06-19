defmodule SymphonyElixir.Runner.LocalRelayToolTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Registry}
  alias SymphonyElixir.Runner.LocalRelay
  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.WorkItem

  setup do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)
    :ok
  end

  test "dispatch frame includes normalized and provider-specific tool definitions" do
    parent = self()
    helper = start_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "agent_context" => "Always inspect repository files before answering.",
          "tool_definitions" => [read_file_tool()],
          "tool_calling_config" => %{"max_iterations" => 3}
        },
        nil
      )

    assert {:ok, _result} = LocalRelay.run_turn(session, "Read the file", build_work_item())

    assert_receive {:dispatch_frame, frame}
    assert frame["protocol"] == ProtocolExtensions.protocol_version()
    assert frame["tool_frame_types"] == ProtocolExtensions.tool_frame_types()
    assert frame["tool_calling_mode"] == "helper_managed"
    assert frame["tool_calling_config"]["max_iterations"] == 3
    assert frame["tool_calling_config"]["timeout_per_tool_ms"] == 30_000
    assert [%{"role" => "system", "content" => context_message}, %{"role" => "user", "content" => "Read the file"}] = frame["messages"]
    assert context_message =~ "Agent instructions:\nAlways inspect repository files before answering."
    assert context_message =~ "workspace_id: workspace-tools"
    assert context_message =~ "agent_id: agent-1"

    assert [
             %{
               "name" => "read_file",
               "parameters_schema" => %{"properties" => %{"path" => %{"type" => "string"}}}
             }
           ] = frame["tool_definitions"]

    assert [
             %{
               "type" => "function",
               "function" => %{
                 "name" => "read_file",
                 "parameters" => %{"properties" => %{"path" => %{"type" => "string"}}}
               }
             }
           ] = frame["provider_tool_specs"]
  end

  test "dispatch frame does not promote work item descriptions to agent instructions" do
    parent = self()
    helper = start_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_definitions" => [read_file_tool()]
        },
        nil
      )

    work_item = %{build_work_item() | description: "User-authored task body"}

    assert {:ok, _result} = LocalRelay.run_turn(session, "Read the file", work_item)

    assert_receive {:dispatch_frame, frame}
    assert [%{"role" => "system", "content" => context_message}, %{"role" => "user", "content" => "Read the file"}] = frame["messages"]
    refute context_message =~ "Agent instructions:"
    refute context_message =~ "User-authored task body"
    assert context_message =~ "workspace_id: workspace-tools"
  end

  test "dispatch frame replays persisted chat history before the current prompt" do
    SymphonyElixir.Runner.ManagerTestSupport.configure_history_adapter([
      %{"role" => "user", "content" => "current persisted prompt", "run_id" => "run-current", "created_at" => "2026-05-12T10:01:00Z"},
      %{"role" => "assistant", "content" => "previous answer", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:01Z"},
      %{"role" => "user", "content" => "previous prompt", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"}
    ])

    parent = self()
    helper = start_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "message_recorder_scope" => %{
            agent_id: "agent-1",
            workspace_id: "workspace-tools",
            session_key: "agent:agent-1:main",
            session_thread_id: "thread-1",
            user_id: "user-1"
          },
          "tool_definitions" => [read_file_tool()]
        },
        nil
      )

    work_item = %{build_work_item() | metadata: %{"run_id" => "run-current", "session_id" => "agent:agent-1:main"}}

    assert {:ok, _result} = LocalRelay.run_turn(session, "new prompt", work_item)

    assert_receive {:dispatch_frame, frame}

    assert [
             %{"role" => "system"},
             %{"role" => "user", "content" => "previous prompt"},
             %{"role" => "assistant", "content" => "previous answer"},
             %{"role" => "user", "content" => "new prompt"}
           ] = frame["messages"]
  end

  test "cloud-managed tool request injects declared runtime context arguments" do
    parent = self()
    helper = start_plans_tool_request_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "user_id" => "user-1",
          "model" => "qwen",
          "tool_calling_mode" => "cloud_managed",
          "tool_definitions" => [plans_tool()]
        },
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "List plans", build_work_item())
    assert result["output_text"] == "done"

    assert_receive {:tool_execution_request,
                    %{
                      "name" => "get_plans",
                      "arguments" => %{"workspace_id" => "workspace-tools", "userId" => "user-1"},
                      "context" => %{
                        "agent_id" => "agent-1",
                        "workspace_id" => "workspace-tools",
                        "user_id" => "user-1",
                        "session_id" => "session-1"
                      }
                    }}
  end

  test "invalid tool definitions return a typed fatal error before dispatch" do
    parent = self()
    helper = start_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_definitions" => [%{read_file_tool() | "name" => "ReadFile"}]
        },
        nil
      )

    assert {:error, {:fatal, {:invalid_tool_definition, message}}} =
             LocalRelay.run_turn(session, "Read the file", build_work_item())

    assert message =~ "invalid tool name"
    refute_received {:dispatch_frame, _frame}
  end

  test "cloud-managed tool request dispatches execution request and emits tool events" do
    parent = self()
    helper = start_tool_request_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_calling_mode" => "cloud_managed",
          "tool_definitions" => [read_file_tool()],
          "on_message" => fn event -> send(parent, {:runner_event, event}) end
        },
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "Read README.md", build_work_item())
    assert result["output_text"] == "done"

    assert_receive {:tool_execution_request,
                    %{
                      "type" => "tool_execution_request",
                      "tool_call_id" => "call-1",
                      "name" => "read_file",
                      "arguments" => %{"path" => "README.md"},
                      "execution_kind" => "filesystem_read",
                      "execution_config" => %{"allowed_paths" => ["README.md"]}
                    }}

    assert_receive {:runner_event, %{event: :tool_call_started, payload: %{"tool_call_id" => "call-1", "tool_name" => "read_file"}}}
    assert_receive {:runner_event, %{event: :tool_call_completed, payload: %{"tool_call_id" => "call-1", "success" => true}}}
  end

  test "cloud-managed mixed tool set routes by execution metadata" do
    parent = self()
    helper = start_mixed_tool_request_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_calling_mode" => "cloud_managed",
          "tool_definitions" => ToolRegistry.specs(["echo"]) ++ [read_file_tool()]
        },
        nil
      )

    assert {:ok, result} = LocalRelay.run_turn(session, "Use mixed tools", build_work_item())
    assert result["output_text"] == "done"

    assert_receive {:tool_execution_request, %{"name" => "read_file", "execution_kind" => "filesystem_read"}}
    refute_received {:tool_execution_request, %{"name" => "echo"}}

    assert_receive {:mixed_continuation, %{"messages" => messages}}
    assert Enum.any?(messages, &(Map.get(&1, "tool_call_id") == "call-runtime" and String.contains?(Map.get(&1, "content", ""), "runtime")))
    assert Enum.any?(messages, &(Map.get(&1, "tool_call_id") == "call-helper" and Map.get(&1, "content") == "contents"))
  end

  test "protocol extension declares and builds tool frame shapes" do
    assert ProtocolExtensions.protocol_version() == 1
    assert "tool_definitions" in ProtocolExtensions.tool_frame_types()
    assert "tool_call_request" in ProtocolExtensions.tool_frame_types()
    assert "tool_execution_request" in ProtocolExtensions.tool_frame_types()
    assert "tool_call_result" in ProtocolExtensions.tool_frame_types()

    assert %{
             "type" => "tool_execution_request",
             "protocol" => 1,
             "correlation_id" => "correlation-1",
             "tool_call_id" => "call-1",
             "name" => "read_file",
             "arguments" => %{"path" => "README.md"}
           } =
             ProtocolExtensions.tool_execution_request(
               "correlation-1",
               %{"id" => "call-1", "name" => "read_file", "arguments" => %{"path" => "README.md"}},
               nil,
               %{"workspace_id" => "workspace-tools"}
             )

    assert %{"context" => %{"workspace_id" => "workspace-tools"}} =
             ProtocolExtensions.tool_execution_request(
               "correlation-1",
               %{"id" => "call-1", "name" => "read_file", "arguments" => %{"path" => "README.md"}},
               nil,
               %{"workspace_id" => "workspace-tools"}
             )
  end

  test "cloud-managed mode honors the session timeout" do
    parent = self()
    helper = start_timeout_then_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: true}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "timeout_ms" => 20,
          "tool_calling_mode" => "cloud_managed",
          "tool_calling_config" => %{"total_timeout_ms" => 1_000},
          "tool_definitions" => [read_file_tool()]
        },
        nil
      )

    assert {:error, {:retryable, :local_runner_timeout}} = LocalRelay.run_turn(session, "Read README.md", build_work_item())
    assert_receive {:helper_cancelled, _frame}

    {:ok, retry_session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_calling_mode" => "cloud_managed",
          "tool_definitions" => [read_file_tool()]
        },
        nil
      )

    assert {:ok, %{"output_text" => "after timeout"}} =
             LocalRelay.run_turn(retry_session, "Retry after timeout", build_work_item())
  end

  test "tool definitions require a helper that advertises tool calling before dispatch" do
    parent = self()
    helper = start_completion_helper(parent)

    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen", capabilities: %{tool_calls: false}}]
    })

    {:ok, session} =
      LocalRelay.start_session(
        %{
          "workspace_id" => "workspace-tools",
          "agent_id" => "agent-1",
          "model" => "qwen",
          "tool_definitions" => [read_file_tool()]
        },
        nil
      )

    assert {:error, {:fatal, :capability_missing}} = LocalRelay.run_turn(session, "Read README.md", build_work_item())
    refute_received {:dispatch_frame, _frame}
  end

  test "protocol extension drops malformed tool call entries" do
    assert [
             %{"id" => "call-1", "name" => "read_file", "arguments" => %{}},
             %{"id" => "call-2", "name" => "search", "arguments" => %{"query" => "relay"}}
           ] =
             ProtocolExtensions.normalize_tool_calls(%{
               "tool_calls" => [
                 "not a map",
                 %{"id" => "call-1", "name" => "read_file"},
                 %{"id" => "", "name" => "read_file"},
                 %{"id" => "call-missing-name"},
                 %{"tool_call_id" => "call-2", "name" => "search", "arguments" => %{"query" => "relay"}},
                 %{"id" => "call-bad-args", "name" => "", "arguments" => "README.md"}
               ]
             })
  end

  defp start_completion_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:dispatch_frame, frame})
          Registry.complete(correlation_id, %{"output_text" => "done"})
      end
    end)
  end

  defp start_tool_request_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "correlation_id" => correlation_id,
            "tool_calls" => [
              %{"id" => "call-1", "name" => "read_file", "arguments" => %{"path" => "README.md"}}
            ]
          })

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})

              Registry.tool_call_result(correlation_id, %{
                "type" => "tool_call_result",
                "correlation_id" => correlation_id,
                "tool_call_id" => "call-1",
                "success" => true,
                "output" => "contents"
              })

              receive do
                {:local_relay_frame, _continuation} ->
                  Registry.complete(correlation_id, %{"output_text" => "done"})
              end
          end
      end
    end)
  end

  defp start_plans_tool_request_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "correlation_id" => correlation_id,
            "tool_calls" => [
              %{"id" => "call-1", "name" => "get_plans", "arguments" => %{}}
            ]
          })

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})

              Registry.tool_call_result(correlation_id, %{
                "type" => "tool_call_result",
                "correlation_id" => correlation_id,
                "tool_call_id" => "call-1",
                "success" => true,
                "output" => "[]"
              })

              receive do
                {:local_relay_frame, _continuation} ->
                  Registry.complete(correlation_id, %{"output_text" => "done"})
              end
          end
      end
    end)
  end

  defp start_mixed_tool_request_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "correlation_id" => correlation_id,
            "tool_calls" => [
              %{"id" => "call-runtime", "name" => "echo", "arguments" => %{"message" => "runtime"}},
              %{"id" => "call-helper", "name" => "read_file", "arguments" => %{"path" => "README.md"}}
            ]
          })

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})

              Registry.tool_call_result(correlation_id, %{
                "type" => "tool_call_result",
                "correlation_id" => correlation_id,
                "tool_call_id" => "call-helper",
                "success" => true,
                "output" => "contents"
              })
          end

          receive do
            {:local_relay_frame, continuation} ->
              send(parent, {:mixed_continuation, continuation})
              Registry.complete(correlation_id, %{"output_text" => "done"})
          end
      end
    end)
  end

  defp start_timeout_then_completion_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, _frame} ->
          receive do
            {:local_relay_cancel, frame} -> send(parent, {:helper_cancelled, frame})
          end
      end

      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.complete(correlation_id, %{"output_text" => "after timeout"})
      end
    end)
  end

  defp read_file_tool do
    %{
      "name" => "read_file",
      "description" => "Read contents of a file",
      "parameters_schema" => %{
        "type" => "object",
        "properties" => %{"path" => %{"type" => "string"}},
        "required" => ["path"]
      },
      "execution_kind" => "filesystem_read",
      "execution_config" => %{"allowed_paths" => ["README.md"]},
      "runner_kind" => "local_relay"
    }
  end

  defp plans_tool do
    %{
      "name" => "get_plans",
      "description" => "List workspace plans",
      "parameters_schema" => %{
        "type" => "object",
        "properties" => %{
          "workspace_id" => %{"type" => "string"},
          "userId" => %{"type" => "string"}
        },
        "required" => ["workspace_id"]
      },
      "execution_kind" => "api",
      "execution_config" => %{},
      "runner_kind" => "local_relay"
    }
  end

  defp build_work_item do
    %WorkItem{
      id: "wi-#{System.unique_integer([:positive])}",
      identifier: "TEST-1",
      title: "Test work item",
      description: "A test work item",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{"session_id" => "session-1"}
    }
  end
end
