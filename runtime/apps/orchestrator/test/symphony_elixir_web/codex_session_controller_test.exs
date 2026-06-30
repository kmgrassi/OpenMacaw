defmodule SymphonyElixirWeb.CodexSessionControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]
  import SymphonyElixir.AppServerTestSupport

  alias SymphonyElixir.Codex.SessionRegistry

  @endpoint SymphonyElixirWeb.Endpoint
  @service_role_key "service-role-test-key"

  setup do
    start_test_endpoint()
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", @service_role_key)

    if Process.whereis(SessionRegistry) do
      Supervisor.terminate_child(SymphonyElixir.Supervisor, SessionRegistry)
      Supervisor.restart_child(SymphonyElixir.Supervisor, SessionRegistry)
    else
      start_supervised!(SessionRegistry)
    end

    :ok
  end

  test "creates a Codex session and accepts input over the protected API" do
    with_test_root("symphony-elixir-codex-session-controller", fn test_root ->
      workspace_root = Path.join(test_root, "workspaces")
      workspace = Path.join(workspace_root, "MT-1302")
      codex_binary = Path.join(test_root, "fake-codex")

      File.mkdir_p!(workspace)

      write_executable!(codex_binary, """
      #!/bin/sh

      while IFS= read -r line; do
        case "$line" in
          *'"id":1'*)
            printf '%s\\n' '{"id":1,"result":{}}'
            ;;
          *'"method":"thread/start"'*)
            printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-1302"}}}'
            ;;
          *'"method":"turn/start"'*)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-1302"}}}'
            printf '%s\\n' '{"method":"turn/completed","params":{"turnId":"turn-1302"}}'
            ;;
        esac
      done
      """)

      write_workflow_file!(Workflow.workflow_file_path(),
        workspace_root: workspace_root,
        codex_command: "#{codex_binary} app-server"
      )

      conn =
        authed_conn()
        |> post("/api/v1/internal/codex/sessions", %{"workspace" => workspace})

      assert %{"ok" => true, "session" => %{"session_id" => session_id, "thread_id" => "thread-1302"}} =
               json_response(conn, 200)

      conn =
        authed_conn()
        |> post("/api/v1/internal/codex/sessions/#{session_id}/input", %{
          "prompt" => "continue",
          "issue" => %{"identifier" => "MT-1302", "title" => "API input"}
        })

      assert %{"ok" => true, "session" => %{"status" => "running", "thread_id" => "thread-1302"}} =
               json_response(conn, 200)
    end)
  end

  test "rejects unauthenticated Codex session requests" do
    conn = post(build_conn(), "/api/v1/internal/codex/sessions", %{"workspace" => "/tmp/workspace"})

    assert %{"error" => %{"code" => "auth_required"}} = json_response(conn, 401)
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64))

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end

  defp authed_conn do
    build_conn()
    |> put_req_header("authorization", "Bearer #{@service_role_key}")
  end
end
