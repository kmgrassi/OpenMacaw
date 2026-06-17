defmodule SymphonyElixir.ToolExecutionContextTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolExecutionContext

  test "normalizes canonical tool execution context fields" do
    assert ToolExecutionContext.normalize(%{
             :agentId => "agent-1",
             "workspace_id" => "workspace-1",
             :user_id => nil,
             :sessionId => "",
             :requestId => "request-1",
             :trace_id => "trace-1",
             :metadata => %{"source" => "test"}
           }) == %{
             "agent_id" => "agent-1",
             "workspace_id" => "workspace-1",
             "request_id" => "request-1",
             "trace_id" => "trace-1",
             "metadata" => %{"source" => "test"}
           }
  end

  test "preserves atom compatibility keys used by coding tools" do
    on_event = fn _event -> :ok end

    assert ToolExecutionContext.normalize(%{
             workspace_root: "/tmp/workspace",
             on_event: on_event,
             env_allowlist: ["PATH"]
           }) == %{
             "workspace_root" => "/tmp/workspace",
             "on_event" => on_event,
             "env_allowlist" => ["PATH"],
             workspace_root: "/tmp/workspace",
             on_event: on_event,
             env_allowlist: ["PATH"]
           }
  end

  test "normalizes repository context to the canonical string key only" do
    assert ToolExecutionContext.normalize(%{repository: "kmgrassi/openmacaw"}) == %{
             "repository" => "kmgrassi/openmacaw"
           }
  end

  test "builds context from session, metadata, execution profile, and extra values" do
    session = %{
      metadata: %{"workspace_id" => "workspace-from-metadata", "agent_id" => "agent-1"},
      execution_profile: %{"user_id" => "user-1"},
      dispatch_frame: %{"session_id" => "session-1"}
    }

    assert ToolExecutionContext.from_session(session, %{workspace_id: "workspace-extra", request_id: "request-1"}) ==
             %{
               "agent_id" => "agent-1",
               "workspace_id" => "workspace-extra",
               "user_id" => "user-1",
               "session_id" => "session-1",
               "request_id" => "request-1"
             }
  end

  test "injects only schema-declared context arguments without overwriting model values" do
    tool = %{
      "parameters_schema" => %{
        "type" => "object",
        "properties" => %{
          "workspace_id" => %{"type" => "string"},
          "userId" => %{"type" => "string"},
          "limit" => %{"type" => "number"}
        }
      }
    }

    assert ToolExecutionContext.inject_arguments(
             %{"workspace_id" => "explicit-workspace", "limit" => 10},
             tool,
             %{"workspace_id" => "runtime-workspace", "user_id" => "user-1", "agent_id" => "agent-1"}
           ) == %{
             "workspace_id" => "explicit-workspace",
             "limit" => 10,
             "userId" => "user-1"
           }
  end
end
