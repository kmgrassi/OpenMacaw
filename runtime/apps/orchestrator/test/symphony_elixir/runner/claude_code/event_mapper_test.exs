defmodule SymphonyElixir.Runner.ClaudeCode.EventMapperTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Runner.ClaudeCode.EventMapper
  alias SymphonyElixirWeb.GatewaySocket.Notifications

  @timestamp ~U[2026-04-29 12:00:00Z]
  @opts [timestamp: @timestamp, provider: "anthropic", model: "sonnet"]

  test "maps assistant text deltas into contract notifications" do
    assert {:ok, event} =
             EventMapper.normalize(%{"method" => "message/delta", "params" => %{"textDelta" => "hello"}}, @opts)

    assert %{
             event: :notification,
             timestamp: @timestamp,
             message: "hello",
             metadata: %{runner: "claude_code", provider: "anthropic", model: "sonnet"},
             payload: %{
               "method" => "item/agentMessage/delta",
               "params" => %{"text" => "hello", "text_delta" => "hello"}
             }
           } = event

    assert {:ok, %{message: "hello", state: "delta"}} =
             Notifications.chat_delta_event("session-1", "run-1", event)
  end

  test "maps tool lifecycle messages into stable tool events" do
    assert {:ok,
            %{
              event: :tool_call_started,
              payload: %{
                "method" => "tool.can_use_tool",
                "params" => %{
                  "tool_name" => "Bash",
                  "tool_call_id" => "toolu_1",
                  "name" => "Bash",
                  "callId" => "toolu_1",
                  "input" => %{"command" => "mix test"},
                  "status" => "requested",
                  "phase" => "request",
                  "decision" => "allow",
                  "source" => "claude_code"
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "tool/can_use_tool",
                 "params" => %{
                   "toolName" => "Bash",
                   "toolUseId" => "toolu_1",
                   "input" => %{"command" => "mix test"},
                   "decision" => "allow"
                 }
               },
               @opts
             )

    assert {:ok,
            %{
              event: :tool_call_started,
              payload: %{
                "method" => "tool.started",
                "params" => %{
                  "tool_name" => "Bash",
                  "tool_call_id" => "toolu_1",
                  "name" => "Bash",
                  "callId" => "toolu_1",
                  "input" => %{"command" => "mix test"},
                  "status" => "started",
                  "source" => "claude_code"
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "tool/started",
                 "params" => %{
                   "tool" => "Bash",
                   "toolUseId" => "toolu_1",
                   "input" => %{"command" => "mix test"}
                 }
               },
               @opts
             )

    assert {:ok,
            %{
              event: :tool_call_completed,
              payload: %{
                "method" => "tool.completed",
                "params" => %{
                  "tool_name" => "Bash",
                  "tool_call_id" => "toolu_1",
                  "output" => %{"exitCode" => 0},
                  "status" => "completed"
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "tool/completed",
                 "params" => %{"tool" => "Bash", "toolUseId" => "toolu_1", "output" => %{"exitCode" => 0}}
               },
               @opts
             )

    assert {:ok,
            %{
              event: :tool_call_failed,
              message: "permission denied",
              payload: %{
                "method" => "tool.failed",
                "params" => %{
                  "tool_name" => "Write",
                  "tool_call_id" => "toolu_2",
                  "reason" => "permission denied",
                  "status" => "failed"
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "tool/failed",
                 "params" => %{"tool" => "Write", "toolUseId" => "toolu_2", "reason" => "permission denied"}
               },
               @opts
             )
  end

  test "normalizes usage updates with snake-case token keys" do
    assert {:ok,
            %{
              event: :notification,
              usage: %{"input_tokens" => 10, "output_tokens" => 4, "total_tokens" => 14},
              payload: %{
                "method" => "usage.updated",
                "params" => %{
                  "usage" => %{"input_tokens" => 10, "output_tokens" => 4, "total_tokens" => 14}
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "usage/updated",
                 "params" => %{"inputTokens" => 10, "outputTokens" => "4", "totalTokens" => 14}
               },
               @opts
             )
  end

  test "maps completed and failed turns with token snapshots" do
    assert {:ok,
            %{
              event: :turn_completed,
              message: "done",
              usage: %{"input_tokens" => 5, "output_tokens" => 2, "total_tokens" => 7},
              payload: %{
                "method" => "turn/completed",
                "params" => %{
                  "output" => "done",
                  "usage" => %{"input_tokens" => 5, "output_tokens" => 2, "total_tokens" => 7}
                }
              }
            }} =
             EventMapper.normalize(
               %{
                 "method" => "turn/completed",
                 "params" => %{
                   "result" => "done",
                   "usage" => %{"inputTokens" => 5, "outputTokens" => 2, "totalTokens" => 7}
                 }
               },
               @opts
             )

    assert {:ok,
            %{
              event: :turn_ended_with_error,
              message: "bridge exited",
              payload: %{"method" => "turn/failed", "params" => %{"reason" => "bridge exited", "retryable" => true}}
            }} =
             EventMapper.normalize(
               %{"method" => "turn/failed", "params" => %{"reason" => "bridge exited", "retryable" => true}},
               @opts
             )
  end

  test "maps approval and input required events into contract approval events" do
    assert {:ok,
            %{
              event: :approval_requested,
              payload: %{"method" => "approval.requested", "params" => %{"prompt" => "Allow Bash?"}}
            }} =
             EventMapper.normalize(
               %{"method" => "approval/input-required", "params" => %{"prompt" => "Allow Bash?"}},
               @opts
             )

    assert {:ok,
            %{
              event: :approval_resolved,
              payload: %{"method" => "approval.resolved", "params" => %{"decision" => "allow"}}
            }} =
             EventMapper.normalize(
               %{"method" => "approval/resolved", "params" => %{"decision" => "allow"}},
               @opts
             )
  end

  test "surfaces session start responses and unknown bridge messages without crashing" do
    assert {:ok,
            %{
              event: :session_started,
              metadata: %{bridge_id: "1"},
              payload: %{"method" => "session.started", "params" => %{"sessionId" => "sess_1"}}
            }} =
             EventMapper.normalize(%{"id" => "1", "result" => %{"sessionId" => "sess_1"}}, @opts)

    assert {:ok,
            %{
              event: :notification,
              payload: %{"method" => "sdk/unhandled", "params" => %{"type" => "future"}}
            }} =
             EventMapper.normalize(%{"method" => "sdk/unhandled", "params" => %{"type" => "future"}}, @opts)
  end

  test "normalizes a stream of bridge messages" do
    assert {:ok, [%{event: :notification}, %{event: :turn_completed}]} =
             EventMapper.normalize_many(
               [
                 %{"method" => "message/delta", "params" => %{"textDelta" => "done"}},
                 %{"method" => "turn/completed", "params" => %{"result" => "done"}}
               ],
               @opts
             )
  end
end
