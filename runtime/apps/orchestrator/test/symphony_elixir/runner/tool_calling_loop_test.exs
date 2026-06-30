defmodule SymphonyElixir.Runner.ToolCallingLoopTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.Runner.ToolCallingLoop

  setup do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)
    :ok
  end

  test "runs cloud-managed tool loop through continuation to final completion" do
    parent = self()
    helper = start_continuation_helper(parent)
    register_helper(helper)

    assert {:ok, result} = ToolCallingLoop.run(session(parent), %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
    assert result["output_text"] == "final answer"

    assert_receive {:initial_dispatch, %{"prompt" => "Read README.md"}}
    assert_receive {:tool_execution_request, %{"name" => "read_file", "arguments" => %{"path" => "README.md"}}}

    assert_receive {:continuation_frame,
                    %{
                      "messages" => [
                        %{"role" => "user"},
                        %{"role" => "assistant", "tool_calls" => [_]},
                        %{"role" => "tool", "content" => "file contents"}
                      ],
                      "tool_call_iteration" => 1
                    }}

    assert_receive {:runner_event, %{event: :tool_call_started, payload: %{"tool_name" => "read_file"}}}
    assert_receive {:runner_event, %{event: :tool_call_completed, payload: %{"success" => true}}}
  end

  test "enforces max iteration limit" do
    helper = start_repeating_helper()
    register_helper(helper)

    assert {:error, {:fatal, {:max_tool_call_iterations_exceeded, 1}}} =
             ToolCallingLoop.run(session(self()), %{max_iterations: 1, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
  end

  test "invalid tool names become tool error content and continue" do
    parent = self()
    helper = start_invalid_tool_helper(parent)
    register_helper(helper)

    assert {:ok, result} = ToolCallingLoop.run(session(parent), %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
    assert result["output_text"] == "handled invalid tool"

    assert_receive {:continuation_frame, %{"messages" => messages}}
    assert Enum.any?(messages, &match?(%{"role" => "tool", "content" => "Unsupported tool: missing_tool"}, &1))
    refute_received {:tool_execution_request, _frame}
    assert_receive {:runner_event, %{event: :tool_call_failed, payload: %{"tool_name" => "missing_tool", "success" => false}}}
  end

  test "per-tool timeout becomes failed tool result and continues" do
    parent = self()
    helper = start_tool_timeout_helper(parent)
    register_helper(helper)

    assert {:ok, result} = ToolCallingLoop.run(session(parent), %{max_iterations: 3, timeout_per_tool_ms: 10, total_timeout_ms: 1_000})
    assert result["output_text"] == "handled timeout"

    assert_receive {:continuation_frame, %{"messages" => messages}}
    assert Enum.any?(messages, &match?(%{"role" => "tool", "content" => ":tool_execution_timeout"}, &1))
    assert_receive {:runner_event, %{event: :tool_call_failed, payload: %{"tool_name" => "read_file", "success" => false}}}
  end

  test "policy ask denial becomes a tool error without dispatching the helper tool" do
    parent = self()
    helper = start_policy_denial_helper(parent)
    register_helper(helper)

    session =
      parent
      |> session()
      |> Map.put(:policies, [
        %{
          "scope" => "session",
          "kind" => "ask_on_tool",
          "params" => %{"tools" => ["read_file"]},
          "enabled" => true
        }
      ])
      |> Map.put(:policy_approval_callback, fn request ->
        send(parent, {:approval_request, request})
        :denied
      end)

    assert {:ok, result} = ToolCallingLoop.run(session, %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
    assert result["output_text"] == "handled policy denial"

    assert_receive {:approval_request, %{"tool_name" => "read_file"}}
    assert_receive {:continuation_frame, %{"messages" => messages}}
    assert Enum.any?(messages, &match?(%{"role" => "tool", "content" => "policy_denied"}, &1))
    refute_received {:tool_execution_request, _frame}

    assert_receive {:runner_event, %{event: :approval_requested, payload: %{"approval_state" => "requested"}}}
    assert_receive {:runner_event, %{event: :approval_resolved, payload: %{"approval_state" => "denied"}}}
    assert_receive {:runner_event, %{event: :tool_call_failed, payload: %{"approval_state" => "denied", "error_code" => "policy_denied"}}}
  end

  test "total timeout cancels the loop" do
    helper = start_never_finishing_helper()
    register_helper(helper)

    assert {:error, {:retryable, :local_runner_timeout}} =
             ToolCallingLoop.run(session(self()), %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 10})
  end

  test "relay errors preserve retryable classification" do
    helper = start_relay_error_helper(%{"error_code" => "local_runtime_offline"})
    register_helper(helper)

    assert {:error, {:retryable, :local_runtime_offline}} =
             ToolCallingLoop.run(session(self()), %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
  end

  test "progress error events preserve typed retryability" do
    helper = start_progress_error_helper(%{"type" => "progress", "event" => "error", "error_code" => "generation_timeout"})
    register_helper(helper)

    assert {:error, {:retryable, :generation_timeout}} =
             ToolCallingLoop.run(session(self()), %{max_iterations: 3, timeout_per_tool_ms: 100, total_timeout_ms: 1_000})
  end

  defp start_continuation_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:initial_dispatch, frame})
          request_read_file(correlation_id)

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})

              Registry.tool_call_result(correlation_id, %{
                "type" => "tool_call_result",
                "tool_call_id" => "call-1",
                "success" => true,
                "output" => "file contents"
              })
          end

          receive do
            {:local_relay_frame, frame} ->
              send(parent, {:continuation_frame, frame})
              Registry.complete(correlation_id, %{"output_text" => "final answer"})
          end
      end
    end)
  end

  defp start_repeating_helper do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          request_read_file(correlation_id)
          await_execution_result_and_repeat(correlation_id)
      end
    end)
  end

  defp await_execution_result_and_repeat(correlation_id) do
    receive do
      {:local_relay_tool_execution_request, _frame} ->
        Registry.tool_call_result(correlation_id, %{
          "type" => "tool_call_result",
          "tool_call_id" => "call-1",
          "success" => true,
          "output" => "file contents"
        })
    end

    receive do
      {:local_relay_frame, _frame} ->
        request_read_file(correlation_id)
    end
  end

  defp start_invalid_tool_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [%{"id" => "call-invalid", "name" => "missing_tool", "arguments" => %{}}]
          })

          receive do
            {:local_relay_frame, frame} ->
              send(parent, {:continuation_frame, frame})
              Registry.complete(correlation_id, %{"output_text" => "handled invalid tool"})
          end
      end
    end)
  end

  defp start_tool_timeout_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          request_read_file(correlation_id)

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})
          end

          receive do
            {:local_relay_frame, frame} ->
              send(parent, {:continuation_frame, frame})
              Registry.complete(correlation_id, %{"output_text" => "handled timeout"})
          end
      end
    end)
  end

  defp start_policy_denial_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          request_read_file(correlation_id)

          receive do
            {:local_relay_tool_execution_request, frame} ->
              send(parent, {:tool_execution_request, frame})
          after
            50 ->
              :ok
          end

          receive do
            {:local_relay_frame, frame} ->
              send(parent, {:continuation_frame, frame})
              Registry.complete(correlation_id, %{"output_text" => "handled policy denial"})
          end
      end
    end)
  end

  defp start_never_finishing_helper do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, _frame} ->
          receive do
            {:local_relay_cancel, _frame} -> :ok
          end
      end
    end)
  end

  defp start_relay_error_helper(error_frame) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.error(correlation_id, error_frame)
      end
    end)
  end

  defp start_progress_error_helper(error_frame) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id}} ->
          Registry.progress(correlation_id, error_frame)
      end
    end)
  end

  defp request_read_file(correlation_id) do
    Registry.tool_call_request(correlation_id, %{
      "type" => "tool_call_request",
      "tool_calls" => [%{"id" => "call-1", "name" => "read_file", "arguments" => %{"path" => "README.md"}}]
    })
  end

  defp register_helper(helper) do
    Registry.register(%{
      workspace_id: "workspace-tools",
      machine_id: "machine-1",
      pid: helper,
      runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen"}]
    })
  end

  defp session(parent) do
    correlation_id = Ecto.UUID.generate()

    %{
      workspace_id: "workspace-tools",
      target_runner_kind: "openai_compatible",
      provider: "local",
      model: "qwen",
      on_message: fn event -> send(parent, {:runner_event, event}) end,
      correlation_id: correlation_id,
      dispatch_frame: %{
        "type" => "dispatch",
        "correlation_id" => correlation_id,
        "workspace_id" => "workspace-tools",
        "target_runner_kind" => "openai_compatible",
        "provider" => "local",
        "model" => "qwen",
        "prompt" => "Read README.md"
      },
      tool_definitions: [
        %{
          "name" => "read_file",
          "description" => "Read a file",
          "parameters_schema" => %{"type" => "object"},
          "execution_kind" => "filesystem_read",
          "execution_config" => %{"allowed_paths" => ["README.md"]}
        }
      ]
    }
  end
end
