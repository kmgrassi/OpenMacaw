defmodule SymphonyElixir.Tools.GitRunTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.Tools.GitRun

  setup do
    previous_req_options = Application.get_env(:symphony_elixir, :git_run_req_options)

    on_exit(fn ->
      if previous_req_options do
        Application.put_env(:symphony_elixir, :git_run_req_options, previous_req_options)
      else
        Application.delete_env(:symphony_elixir, :git_run_req_options)
      end
    end)

    root = Path.join(System.tmp_dir!(), "symphony-git-run-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf(root) end)

    %{root: root}
  end

  test "is exposed as a manager and coding tool" do
    assert {:ok, GitRun} = ToolRegistry.get("git.run")
    assert "git.run" in ToolRegistry.bundle(:manager)
    assert "git.run" in ToolRegistry.bundle(:coding)
  end

  test "runs a git command in a workspace root", %{root: root} do
    assert {_output, 0} = System.cmd("git", ["init"], cd: root, stderr_to_stdout: true)
    File.write!(Path.join(root, "README.md"), "hello\n")

    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "git status --short"}, %{workspace_root: root})

    assert output["tool"] == "git.run"
    assert output["ok"] == true
    assert output["argv"] == ["git", "status", "--short"]
    assert output["stdout"] =~ "README.md"
  end

  test "allows git write commands (git branch creation)", %{root: root} do
    assert {_output, 0} = System.cmd("git", ["init"], cd: root, stderr_to_stdout: true)
    File.write!(Path.join(root, "README.md"), "hello\n")
    assert {_, 0} = System.cmd("git", ["add", "."], cd: root, stderr_to_stdout: true)

    assert {_, 0} =
             System.cmd(
               "git",
               ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
               cd: root,
               stderr_to_stdout: true
             )

    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "git branch topic"}, %{workspace_root: root})

    assert output["ok"] == true
    refute output["blocked"] == true
    assert output["argv"] == ["git", "branch", "topic"]
  end

  test "allows gh pr write commands at the authorize layer", %{root: root} do
    # `gh pr comment` is no longer policy-blocked. The command may still
    # exit non-zero if gh isn't installed or authed in the test env, but
    # it must not be rejected with `blocked: true`.
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "gh pr comment 1 --body hi"}, %{workspace_root: root})

    refute output["blocked"] == true
    assert output["argv"] == ["gh", "pr", "comment", "1", "--body", "hi"]
  end

  test "allows gh repo delete at the authorize layer", %{root: root} do
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "gh repo delete owner/repo --yes"}, %{workspace_root: root})

    refute output["blocked"] == true
    assert output["argv"] == ["gh", "repo", "delete", "owner/repo", "--yes"]
  end

  test "allows gh secret subcommands at the authorize layer", %{root: root} do
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "gh secret list"}, %{workspace_root: root})

    refute output["blocked"] == true
    assert output["argv"] == ["gh", "secret", "list"]

    assert {:ok, %{output: set_output}} =
             GitRun.execute(%{"command" => "gh secret set FOO --body bar"}, %{workspace_root: root})

    refute set_output["blocked"] == true
    assert set_output["argv"] == ["gh", "secret", "set", "FOO", "--body", "bar"]
  end

  test "allows gh variable subcommands at the authorize layer", %{root: root} do
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "gh variable set FOO --body bar"}, %{workspace_root: root})

    refute output["blocked"] == true
    assert output["argv"] == ["gh", "variable", "set", "FOO", "--body", "bar"]
  end

  test "allows gh auth subcommands at the authorize layer", %{root: root} do
    for sub <- ~w(login logout refresh switch setup-git token) do
      assert {:ok, %{output: output}} =
               GitRun.execute(%{"command" => "gh auth #{sub}"}, %{workspace_root: root})

      refute output["blocked"] == true
      assert output["argv"] == ["gh", "auth", sub]
    end
  end

  test "allows gh api calls at the authorize layer", %{root: root} do
    for cmd <- [
          "gh api /repos/owner/name",
          "gh api -X DELETE /repos/owner/name",
          "gh api graphql -f query=query{viewer{login}}",
          "gh api /repos/owner/name/actions/secrets/FOO -X PUT --field encrypted_value=..."
        ] do
      assert {:ok, %{output: output}} =
               GitRun.execute(%{"command" => cmd}, %{workspace_root: root})

      refute output["blocked"] == true
      assert ["gh", "api" | _rest] = output["argv"]
    end
  end

  test "allows gh auth status (the inspection auth subcommand)", %{root: root} do
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "gh auth status"}, %{workspace_root: root})

    refute output["blocked"] == true
    assert output["argv"] == ["gh", "auth", "status"]
  end

  test "blocks non-git/gh executables", %{root: root} do
    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "rm -rf /"}, %{workspace_root: root})

    assert output["ok"] == false
    assert output["blocked"] == true
    assert output["reason"] == "unsupported_executable"
  end

  test "resolves workspace root from local runtime routing matches", %{root: root} do
    Application.put_env(:symphony_elixir, :git_run_req_options, plug: {Req.Test, __MODULE__})

    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
    System.put_env("SUPABASE_URL", "https://test.supabase.co")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", "test-key")

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
    end)

    assert {_output, 0} = System.cmd("git", ["init"], cd: root, stderr_to_stdout: true)

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/routing_rule_match"
      params = URI.decode_query(conn.query_string)

      response =
        case params["kind"] do
          "eq.agent_id" -> [%{"rule_id" => "rule-1"}]
          "eq.local_workspace_root" -> [%{"rule_id" => "rule-1", "value" => root}]
        end

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(response))
    end)

    assert {:ok, %{output: output}} =
             GitRun.execute(%{"command" => "git status --short"}, %{
               session: %{workspace_id: "workspace-1", agent_id: "agent-1"}
             })

    assert output["ok"] == true
    assert Path.basename(output["workspace_root"]) == Path.basename(root)
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
