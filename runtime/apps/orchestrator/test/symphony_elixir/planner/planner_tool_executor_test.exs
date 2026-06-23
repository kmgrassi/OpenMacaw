defmodule SymphonyElixir.Planner.PlannerToolExecutorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planner.PlannerToolExecutor

  test "decodes JSON arguments and preserves malformed strings" do
    assert PlannerToolExecutor.decode_arguments(~s({"name":"Task"})) == %{"name" => "Task"}
    assert PlannerToolExecutor.decode_arguments("{") == "{"
    assert PlannerToolExecutor.decode_arguments(nil) == %{}
  end

  test "adds workspace_id only for planner database tools" do
    session = %{workspace_id: "workspace-1"}

    assert PlannerToolExecutor.maybe_put_workspace_id(%{"name" => "Task"}, "task.create", session) == %{
             "name" => "Task",
             "workspace_id" => "workspace-1"
           }

    assert PlannerToolExecutor.maybe_put_workspace_id(%{"agentId" => "agent-2"}, "agent_tool_grant.create", session) == %{
             "agentId" => "agent-2",
             "workspace_id" => "workspace-1"
           }

    assert PlannerToolExecutor.maybe_put_workspace_id(%{"command" => "pwd"}, "shell.exec", session) == %{"command" => "pwd"}
  end

  test "returns dynamic-tool shaped output for registry execution" do
    session = %{tool_names: ["echo"], agent_id: "agent-1", workspace_id: "workspace-1"}

    assert %{"success" => true, "output" => output} =
             PlannerToolExecutor.execute(session, "echo", %{"message" => "hello"})

    assert Jason.decode!(output) == %{
             "arguments" => %{"message" => "hello"},
             "context" => %{}
           }
  end

  test "reports not_allowed using the session allowlist" do
    session = %{tool_names: ["plan.create"], agent_id: "agent-1", workspace_id: "workspace-1"}

    assert %{"success" => false, "output" => output} =
             PlannerToolExecutor.execute(session, "task.create", %{})

    assert Jason.decode!(output) == %{
             "error" => %{
               "message" => ~s(Dynamic tool "task.create" is not allowed by this agent's tool policy.),
               "supportedTools" => ["plan.create"]
             }
           }
  end
end
