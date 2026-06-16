defmodule SymphonyElixir.Planner.DatabaseToolsAgentToolGrantTest do
  use SymphonyElixir.Planner.DatabaseToolsCase

  test "agent_tool_grant.create verifies scope and writes a system-authored grant" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      send(test_pid, {:request, conn.method, conn.request_path, URI.decode_query(conn.query_string)})

      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/agent"} ->
          json(conn, 200, [%{"id" => "agent-2", "workspace_id" => "workspace-1"}])

        {"GET", "/rest/v1/tool"} ->
          json(conn, 200, [%{"id" => "tool-read", "slug" => "repo.read_file", "name" => "Read File", "enabled" => true}])

        {"GET", "/rest/v1/agent_tool_grant"} ->
          json(conn, 200, [])

        {"POST", "/rest/v1/agent_tool_grant"} ->
          assert {"prefer", "resolution=merge-duplicates,return=representation"} in conn.req_headers
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert Jason.decode!(body) == %{
                   "agent_id" => "agent-2",
                   "workspace_id" => "workspace-1",
                   "tool_id" => "tool-read",
                   "mode" => "include",
                   "source" => "system",
                   "reason" => "operability signature repo.read_file",
                   "created_by_user_id" => nil
                 }

          json(conn, 201, [
            %{
              "id" => "grant-1",
              "agent_id" => "agent-2",
              "workspace_id" => "workspace-1",
              "tool_id" => "tool-read",
              "mode" => "include",
              "source" => "system"
            }
          ])
      end
    end)

    assert {:ok, %{"grant" => %{"id" => "grant-1"}, "tool" => %{"slug" => "repo.read_file"}}} =
             DatabaseTools.execute("agent_tool_grant.create", %{
               "workspace_id" => "workspace-1",
               "agentId" => "agent-2",
               "toolSlug" => "repo.read_file",
               "reason" => "operability signature repo.read_file"
             })

    assert_received {:request, "GET", "/rest/v1/agent", %{"id" => "eq.agent-2", "workspace_id" => "eq.workspace-1"}}
    assert_received {:request, "GET", "/rest/v1/tool", %{"slug" => "eq.repo.read_file"} = tool_query}
    assert tool_query["or"] == "(workspace_id.is.null,workspace_id.eq.workspace-1)"

    assert_received {:request, "GET", "/rest/v1/agent_tool_grant",
                     %{
                       "agent_id" => "eq.agent-2",
                       "workspace_id" => "eq.workspace-1",
                       "tool_id" => "eq.tool-read"
                     }}

    assert_received {:request, "POST", "/rest/v1/agent_tool_grant", %{"on_conflict" => "agent_id,workspace_id,tool_id"}}
  end

  test "agent_tool_grant.update backs off when the same system grant already exists" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/agent"} ->
          json(conn, 200, [%{"id" => "agent-2", "workspace_id" => "workspace-1"}])

        {"GET", "/rest/v1/tool"} ->
          json(conn, 200, [%{"id" => "tool-read", "slug" => "repo.read_file", "name" => "Read File", "enabled" => true}])

        {"GET", "/rest/v1/agent_tool_grant"} ->
          json(conn, 200, [
            %{
              "id" => "grant-1",
              "agent_id" => "agent-2",
              "workspace_id" => "workspace-1",
              "tool_id" => "tool-read",
              "mode" => "include",
              "source" => "system"
            }
          ])

        {"POST", "/rest/v1/agent_tool_grant"} ->
          flunk("repeated system grants must not be written")
      end
    end)

    assert {:error, :system_tool_grant_backoff} =
             DatabaseTools.execute("agent_tool_grant.update", %{
               "workspace_id" => "workspace-1",
               "agentId" => "agent-2",
               "toolSlug" => "repo.read_file",
               "mode" => "include",
               "reason" => "operability signature repo.read_file"
             })
  end

  defp json(conn, status, body) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(body))
  end
end
