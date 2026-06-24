defmodule SymphonyElixir.Runner.Planner.SessionTest do
  use SymphonyElixir.Runner.PlannerTestSupport

  alias SymphonyElixir.Schema.ExecutionProfile

  test "starts without a workspace and exposes only planner tools" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    assert Planner.requires_workspace?() == false

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert session.model == "gpt-test"
    assert session.tool_names == @planner_tool_names
    refute "linear_graphql" in session.tool_names
    assert session.instructions =~ "Planning profile scope: global / global"
    assert session.instructions =~ "Work item table guidance:"
    assert session.instructions =~ "state \"todo\" is planned but not manager-runnable"
    assert session.instructions =~ "delegate.when \"now\""
    assert session.instructions =~ "set state to \"running\" or \"awaiting_review\""
    assert session.instructions =~ "Do not set poll_cadence_seconds for one-shot manager tests"
    assert session.instructions =~ "intent \"implement\""
    assert session.instructions =~ "Work item routing guidance:"
    assert session.instructions =~ "task.create routing.intent is the primary dispatch hint"
    assert session.instructions =~ "Use intent instead of concrete routing fields"
    assert session.instructions =~ "implement"
    assert session.instructions =~ "address_review"
    assert session.instructions =~ "fix_tests"
    assert session.instructions =~ "task.create accepts optional top-level repository and runner_kind fields"
    refute session.instructions =~ "task.status"
    refute session.instructions =~ "shell.exec"
    refute session.instructions =~ "repository inspection tools"
    refute session.instructions =~ "inspect available repository context"
    assert session.instructions =~ "Use only canonical runtime runner_kind values"

    for runner_kind <- ExecutionProfile.supported_runner_kinds() do
      assert session.instructions =~ runner_kind
    end

    assert session.instructions =~ "Do not invent aliases"
  end

  test "uses supplied effective grant definitions instead of planner role defaults" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:grant_scoped_request, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "resp-grants",
              "status" => "completed",
              "output" => [
                %{
                  "type" => "message",
                  "role" => "assistant",
                  "content" => [%{"type" => "output_text", "text" => "No task tool available."}]
                }
              ]
            })
          )
      end
    end)

    effective_tool_names = @planner_tool_names -- ["task.create"]

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "toolDefinitions" => ToolRegistry.specs(effective_tool_names),
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    refute "task.create" in session.tool_names
    refute session.instructions =~ "inspect available repository context"

    assert {:ok, %{"response_id" => "resp-grants", "output_text" => "No task tool available."}} =
             Planner.run_turn(session, "Create a task", %WorkItem{id: "work-1", identifier: "PLAN-1"})

    assert_received {:grant_scoped_request, request}
    provider_names = Enum.map(request["tools"], & &1["name"])

    refute "task_create" in provider_names
    assert "plan_create" in provider_names
  end

  test "omits repository inspection routing instructions" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "toolDefinitions" => ToolRegistry.specs(["plan.create", "task.create"]),
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert session.tool_names == ["plan.create", "task.create"]
    refute session.instructions =~ "repository inspection tools"
    refute session.instructions =~ "inspect available repository context"
    refute session.instructions =~ "scheduled_task.read"
    refute session.instructions =~ "scheduled_task.list"
    refute session.instructions =~ "shell.exec"
    refute session.instructions =~ "task.status"
  end

  test "Responses planner preserves canonical schemas from explicit tool definitions" do
    test_pid = self()

    schema = %{
      "type" => "object",
      "required" => ["plan_id", "name"],
      "properties" => %{
        "plan_id" => %{"type" => "string"},
        "name" => %{"type" => "string"}
      }
    }

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:explicit_schema_request, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "resp-explicit-schema",
              "status" => "completed",
              "output" => [
                %{
                  "type" => "message",
                  "role" => "assistant",
                  "content" => [%{"type" => "output_text", "text" => "Done."}]
                }
              ]
            })
          )
      end
    end)

    {:ok, session} =
      Planner.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "tool_definitions" => [
            %{"name" => "task.create", "description" => "Create task", "parameters_schema" => schema}
          ],
          "agent" => %{id: "agent-1", workspace_id: "workspace-1", type: "planning"}
        },
        nil
      )

    assert {:ok, %{"output_text" => "Done."}} =
             Planner.run_turn(session, "Create a task", %WorkItem{id: "work-1", identifier: "PLAN-1", title: "Plan work"})

    assert_received {:explicit_schema_request, request}
    assert [%{"name" => "task_create", "parameters" => ^schema}] = request["tools"]
  end

  test "falls back to workflow stored_agent for planning identity" do
    File.write!(Workflow.workflow_file_path(), """
    ---
    tracker:
      kind: memory
    stored_agent:
      id: agent-from-workflow
      workspace_id: workspace-from-workflow
      type: planning
      tool_policy:
        planning:
          destination: database
    ---
    Prompt
    """)

    WorkflowStore.force_reload()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test"
               },
               nil
             )

    assert session.workspace_id == "workspace-from-workflow"
    assert session.tool_names == @planner_tool_names
    assert session.instructions =~ "Stored agent type: planning"
  end

  test "start_session includes resolved planning profile instructions" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      params = URI.decode_query(conn.query_string)

      case {params["scope_type"], params["scope_id"], params["workspace_id"]} do
        {"eq.agent", "eq.agent-1", "eq.workspace-1"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "scope_type" => "agent",
                "scope_id" => "agent-1",
                "workspace_id" => "workspace-1",
                "instructions" => "Agent override",
                "definition_of_done" => ["agent done"]
              }
            ])
          )

        {"eq.workspace", "eq.workspace-1", "eq.workspace-1"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "scope_type" => "workspace",
                "scope_id" => "workspace-1",
                "workspace_id" => "workspace-1",
                "environment_notes" => "Use local docker compose"
              }
            ])
          )

        {"eq.global", "eq.global", "is.null"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "scope_type" => "global",
                "scope_id" => "global",
                "workspace_id" => nil,
                "instructions" => "Global override",
                "repo_boundaries" => %{"default" => "Keep edits minimal"}
              }
            ])
          )
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "agent" => %{
                   id: "agent-1",
                   workspace_id: "workspace-1",
                   type: "planning",
                   tool_policy: %{}
                 }
               },
               nil
             )

    assert session.instructions =~ "Agent override"
    assert session.instructions =~ "Use local docker compose"
    assert session.instructions =~ "Keep edits minimal"
  end
end
