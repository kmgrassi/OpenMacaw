# git.run smoke script.
#
# Exercises the SymphonyElixir.Tools.GitRun tool end-to-end against a real
# temp workspace. Run with:
#
#     cd apps/orchestrator
#     mix run scripts/smoke_git_run.exs
#
# Optional: run against a real GitHub repo to confirm gh writes work too.
# Set SMOKE_GITHUB_REPO=owner/name and SMOKE_GITHUB_PR=<num> to enable the
# gh-pr probe section. That section makes a *read* gh call only — it does
# not post comments or merge anything. To exercise writes against a real
# repo, run the printed commands manually.

alias SymphonyElixir.Tools.GitRun

defmodule SmokeGitRun do
  def run_case(label, command, opts) do
    {expect, root} = {opts[:expect], opts[:root]}
    {:ok, %{output: output}} = GitRun.execute(%{"command" => command}, %{workspace_root: root})

    ok? =
      case expect do
        :ok -> output["ok"] == true and not (output["blocked"] == true)
        :blocked -> output["blocked"] == true
        :exec_fail_ok -> not (output["blocked"] == true)
      end

    status = if ok?, do: "PASS", else: "FAIL"
    IO.puts("  [#{status}] #{label}\n         $ #{command}\n         => ok=#{inspect(output["ok"])} blocked=#{inspect(output["blocked"])} reason=#{inspect(output["reason"])}")
    ok?
  end

  def main do
    root = Path.join(System.tmp_dir!(), "git-run-smoke-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)

    {_, 0} = System.cmd("git", ["init"], cd: root, stderr_to_stdout: true)
    File.write!(Path.join(root, "README.md"), "hello\n")
    {_, 0} = System.cmd("git", ["add", "."], cd: root, stderr_to_stdout: true)

    {_, 0} =
      System.cmd(
        "git",
        ["-c", "user.email=smoke@example.com", "-c", "user.name=Smoke", "commit", "-m", "init"],
        cd: root,
        stderr_to_stdout: true
      )

    IO.puts("\n=== Allowed git ops ===")

    results =
      [
        {"git status --short", "git status --short", :ok},
        {"git log --oneline -n 5", "git log --oneline -n 5", :ok},
        {"git branch (create)", "git branch topic", :ok},
        {"git branch --list", "git branch --list", :ok}
      ]
      |> Enum.map(fn {label, cmd, expect} ->
        run_case(label, cmd, expect: expect, root: root)
      end)

    IO.puts("\n=== gh ops (authorize passes; gh CLI may fail if not installed/authed) ===")

    gh_results =
      [
        {"gh repo delete", "gh repo delete owner/repo --yes"},
        {"gh secret list", "gh secret list"},
        {"gh secret set", "gh secret set FOO --body bar"},
        {"gh variable set", "gh variable set FOO --body bar"},
        {"gh auth login", "gh auth login"},
        {"gh auth logout", "gh auth logout"},
        {"gh auth refresh", "gh auth refresh"},
        {"gh auth switch", "gh auth switch"},
        {"gh auth setup-git", "gh auth setup-git"},
        {"gh auth token", "gh auth token"},
        {"gh api (repo info)", "gh api /repos/owner/name"},
        {"gh api -X DELETE", "gh api -X DELETE /repos/owner/name"},
        {"gh api graphql", "gh api graphql -f query=query{viewer{login}}"}
      ]
      |> Kernel.++([
        {"gh auth status", "gh auth status"},
        {"gh pr list", "gh pr list --state open --limit 1"},
        {"gh pr comment (write — not actually called against real repo)", "gh pr comment 1 --body smoke"},
        {"gh pr review", "gh pr review 1 --approve --body smoke"},
        {"gh pr merge", "gh pr merge 1 --squash"},
        {"gh issue create", "gh issue create --title smoke --body smoke"},
        {"gh run rerun", "gh run rerun 1"}
      ])
      |> Enum.map(fn {label, cmd} -> run_case(label, cmd, expect: :exec_fail_ok, root: root) end)

    IO.puts("\n=== Non-git executables blocked ===")

    nonexec_results =
      [
        {"rm", "rm -rf /tmp/anywhere"},
        {"curl", "curl https://example.com"},
        {"bash", "bash -c 'echo hi'"}
      ]
      |> Enum.map(fn {label, cmd} -> run_case(label, cmd, expect: :blocked, root: root) end)

    File.rm_rf(root)

    all = results ++ gh_results ++ nonexec_results
    passed = Enum.count(all, & &1)
    total = length(all)

    IO.puts("\n=== Summary ===")
    IO.puts("  #{passed}/#{total} smoke cases passed")

    if passed == total do
      IO.puts("  ALL GREEN")
    else
      IO.puts("  Some cases failed; inspect output above.")
      System.halt(1)
    end
  end
end

SmokeGitRun.main()
