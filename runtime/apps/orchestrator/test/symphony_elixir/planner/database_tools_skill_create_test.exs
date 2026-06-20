defmodule SymphonyElixir.Planner.DatabaseToolsSkillCreateTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "skill.create validates target agent and writes a draft skill" do
    Req.Test.stub(__MODULE__, fn conn ->
      params = URI.decode_query(conn.query_string)

      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/agent"} ->
          assert params["id"] == "eq.agent-1"
          assert params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "agent-1", "workspace_id" => "workspace-1"}]))

        {"POST", "/rest/v1/skill"} ->
          assert {"prefer", "return=representation"} in conn.req_headers
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "workspace_id" => "workspace-1",
                   "agent_id" => "agent-1",
                   "name" => "debug-tool-failures",
                   "description" => "Use when a tool call fails.",
                   "body" => "Inspect the schema and preserve the exact error.",
                   "status" => "draft",
                   "copied_from_skill_id" => nil,
                   "created_by_agent_id" => "learning-agent-1",
                   "created_by_user_id" => "user-1",
                   "source_run_id" => "run-1"
                 }

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            201,
            Jason.encode!([%{"id" => "skill-1", "workspace_id" => "workspace-1", "agent_id" => "agent-1"}])
          )
      end
    end)

    assert {:ok, %{"id" => "skill-1"}} =
             DatabaseTools.execute(
               "skill.create",
               %{
                 "agentId" => "agent-1",
                 "name" => "debug-tool-failures",
                 "description" => "Use when a tool call fails.",
                 "body" => "Inspect the schema and preserve the exact error."
               },
               workspace_id: "workspace-1",
               agent_id: "learning-agent-1",
               user_id: "user-1",
               session_id: "run-1"
             )
  end

  test "skill.create rejects invalid Agent Skills names before writing" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when the skill name is invalid")
    end)

    assert {:error, {:invalid_argument, "name", "must match ^[a-z0-9-]+$"}} =
             DatabaseTools.execute("skill.create", %{
               "workspace_id" => "workspace-1",
               "agentId" => "agent-1",
               "name" => "Invalid Skill",
               "description" => "Use when invalid.",
               "body" => "Do not write this skill."
             })
  end
end
