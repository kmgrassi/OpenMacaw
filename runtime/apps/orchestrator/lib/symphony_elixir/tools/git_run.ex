defmodule SymphonyElixir.Tools.GitRun do
  @moduledoc """
  Workspace-scoped Git/GitHub command tool.

  Single command-shaped tool instead of one tool per GitHub action. Agents
  get full read/write access to `git` and `gh`. The only guardrail is the
  executable boundary: a `git.run` command must invoke `git` or `gh` —
  anything else is rejected (use `shell.exec` for other executables).

  There is no hardcoded `gh` subcommand denylist. Whether an agent may run
  `git.run` at all is governed by tool grants, not by a baked-in list of
  forbidden subcommands. Everything `git`/`gh` can do is allowed: commits,
  pushes (including `--force`), PR/issue/release/workflow CRUD, branch
  creation and deletion, merges, rebases, hard resets within the workspace,
  `gh api`, `gh secret` / `gh variable`, `gh auth`, `gh repo delete`, etc.
  """

  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.{PathSafety, PostgRESTClient, Supabase}
  alias SymphonyElixir.Runner.CodingTools.ShellExecutor

  @default_timeout_ms 30_000
  @default_output_limit_bytes 64_000
  @routing_match_table "routing_rule_match"

  @impl true
  def name, do: "git.run"

  @impl true
  def description do
    "Run a Git or GitHub CLI command in the registered workspace repository. " <>
      "Choose the binary by what you need: use `git` for local repository " <>
      "state and history (status, diff, add, commit, push, fetch, rebase, " <>
      "checkout); use `gh` for GitHub platform actions (pr create/view/edit/" <>
      "comment/review/merge, pr checks, issue, run, auth status). A typical " <>
      "flow is `git add` then `git commit` then `git push` then `gh pr create`. " <>
      "Full read/write access to both `git` and `gh`."
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["command"],
      "properties" => %{
        "command" => %{
          "type" => "string",
          "description" => """
          Single command line, must start with `git` or `gh`. Quoting
          follows POSIX shell rules (e.g. `--body "LGTM, merging"`).
          Commands run inside the workspace's checked-out repository, so omit
          `--repo` to act on the current repo (`gh` infers it from the local
          `origin` remote); pass `--repo owner/repo` only to target a
          different repository. Never guess an owner/repo slug.
          Read examples:
            gh pr list --state open --json number,title,reviewDecision
            gh pr view 123 --comments
            gh pr checks 123
            git log --oneline -n 20
            git status --short
          Write examples (allowed, full access):
            gh pr comment 123 --body "@codex review"
            gh pr review 123 --approve --body "LGTM"
            gh pr merge 123 --squash --delete-branch
            gh issue create --title "..." --body "..."
            gh run rerun 9876543210
            git push origin feat/x
            git checkout -b feat/y
          The only restriction is the executable: the command must start
          with `git` or `gh`. Use shell.exec for anything else.
          """
        },
        "cwd" => %{
          "type" => ["string", "null"],
          "description" => "Optional workspace-relative directory. Defaults to the registered workspace root."
        },
        "timeout_ms" => %{"type" => ["integer", "null"], "minimum" => 1000, "maximum" => 120_000},
        "output_limit_bytes" => %{"type" => ["integer", "null"], "minimum" => 1024, "maximum" => 256_000}
      }
    }
  end

  @impl true
  def bundle, do: [:manager, :coding]

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    with {:ok, command} <- command(arguments),
         {:ok, argv} <- split_command(command),
         :ok <- authorize(argv),
         {:ok, workspace_root} <- workspace_root(arguments, context),
         input <- shell_input(arguments, argv),
         {:ok, result} <- ShellExecutor.run(input, shell_options(arguments, workspace_root)) do
      {:ok, %{output: normalize_result(result, command, workspace_root, argv)}}
    else
      {:error, {:command_blocked, reason, argv}} ->
        {:ok, %{output: blocked_result(reason, argv)}}

      {:error, reason} ->
        {:ok, %{output: error_result(reason)}}
    end
  end

  def execute(_arguments, _context), do: {:error, :invalid_git_run_context}

  defp command(arguments) do
    case map_value(arguments, :command) do
      command when is_binary(command) ->
        command = String.trim(command)
        if command == "", do: {:error, :missing_command}, else: {:ok, command}

      _other ->
        {:error, :missing_command}
    end
  end

  defp split_command(command) do
    case OptionParser.split(command) do
      [] -> {:error, :missing_command}
      argv when is_list(argv) -> {:ok, argv}
    end
  rescue
    _error -> {:error, :invalid_command_syntax}
  end

  @doc """
  Pure policy check for a parsed argv. Returns `:ok` when the command may
  run, or `{:error, {:command_blocked, reason, argv}}` when it must not.

  Exposed (rather than `defp`) so the policy can be unit-tested directly,
  without shell-executing real `git`/`gh` — never drive auth-mutating or
  destructive commands through `execute/2` in tests.
  """
  @spec authorize([String.t()]) :: :ok | {:error, {:command_blocked, :unsupported_executable, [String.t()]}}
  def authorize(["git" | _rest]), do: :ok
  def authorize(["gh" | _rest]), do: :ok
  def authorize(argv), do: {:error, {:command_blocked, :unsupported_executable, argv}}

  defp workspace_root(arguments, context) do
    cond do
      root = string_value(arguments, :workspace_root) ->
        canonical_workspace_root(root)

      root = string_value(context, :workspace_root) ->
        canonical_workspace_root(root)

      root = context |> map_value(:session) |> string_value(:workspace_root) ->
        canonical_workspace_root(root)

      true ->
        workspace_root_from_routing(context)
    end
  end

  defp canonical_workspace_root(root) do
    with {:ok, canonical} <- PathSafety.canonicalize(root),
         true <- File.dir?(canonical) do
      {:ok, canonical}
    else
      false -> {:error, {:workspace_root_not_found, root}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp workspace_root_from_routing(context) do
    session = map_value(context, :session) || %{}
    workspace_id = string_value(session, :workspace_id) || string_value(context, :workspace_id)
    agent_id = string_value(session, :agent_id) || string_value(context, :agent_id)

    with {:ok, config} <- routing_config(),
         {:ok, rule_ids} <- agent_rule_ids(config, workspace_id, agent_id),
         {:ok, roots} <- local_workspace_roots(config, workspace_id, rule_ids),
         root when is_binary(root) <- List.first(roots) do
      canonical_workspace_root(root)
    else
      nil -> {:error, :workspace_root_not_registered}
      {:ok, []} -> {:error, :workspace_root_not_registered}
      {:error, _reason} = error -> error
      _other -> {:error, :workspace_root_not_registered}
    end
  end

  defp agent_rule_ids(_config, nil, _agent_id), do: {:ok, []}
  defp agent_rule_ids(_config, _workspace_id, nil), do: {:ok, []}

  defp agent_rule_ids(config, workspace_id, agent_id) do
    query = %{
      "select" => "rule_id",
      "workspace_id" => "eq.#{workspace_id}",
      "kind" => "eq.agent_id",
      "value" => "eq.#{agent_id}"
    }

    case PostgRESTClient.get(routing_client(config), @routing_match_table, query, log_metadata: %{operation: "git_run.agent_rule_ids", table: @routing_match_table}) do
      {:ok, rows} when is_list(rows) ->
        {:ok, rows |> Enum.map(&Map.get(&1, "rule_id")) |> Enum.filter(&is_binary/1)}

      {:ok, body} ->
        {:error, {:invalid_routing_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  defp local_workspace_roots(config, workspace_id, rule_ids) do
    query =
      %{
        "select" => "value,rule_id",
        "workspace_id" => "eq.#{workspace_id}",
        "kind" => "eq.local_workspace_root",
        "key" => "eq.path"
      }
      |> maybe_scope_rule_ids(rule_ids)

    case PostgRESTClient.get(routing_client(config), @routing_match_table, query, log_metadata: %{operation: "git_run.local_workspace_roots", table: @routing_match_table}) do
      {:ok, rows} when is_list(rows) ->
        {:ok, rows |> Enum.map(&Map.get(&1, "value")) |> Enum.filter(&is_binary/1) |> Enum.uniq()}

      {:ok, body} ->
        {:error, {:invalid_routing_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  defp maybe_scope_rule_ids(query, []), do: query

  defp maybe_scope_rule_ids(query, rule_ids) do
    Map.put(query, "rule_id", "in.(#{Enum.join(rule_ids, ",")})")
  end

  defp shell_input(arguments, argv) do
    %{
      "argv" => argv,
      "cwd" => map_value(arguments, :cwd) || ".",
      "timeout_ms" => bounded_integer(map_value(arguments, :timeout_ms), 1000, 120_000),
      "output_limit_bytes" => bounded_integer(map_value(arguments, :output_limit_bytes), 1024, 256_000)
    }
  end

  defp shell_options(arguments, workspace_root) do
    %{
      workspace_root: workspace_root,
      command_id: map_value(arguments, :id) || Ecto.UUID.generate(),
      timeout_ms: bounded_integer(map_value(arguments, :timeout_ms), 1000, 120_000) || @default_timeout_ms,
      output_limit_bytes: bounded_integer(map_value(arguments, :output_limit_bytes), 1024, 256_000) || @default_output_limit_bytes,
      env_allowlist: ["CI", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "HOME", "LANG", "LC_ALL", "PATH", "TERM"]
    }
  end

  defp normalize_result(result, command, workspace_root, argv) do
    output = result["output"] || result["stdout"] || ""
    ok? = result["success"] == true

    %{
      "tool" => name(),
      "command" => command,
      "argv" => argv,
      "cwd" => result["cwd"],
      "workspace_root" => workspace_root,
      "ok" => ok?,
      "exit_code" => result["exit_status"],
      "stdout" => result["stdout"] || "",
      "stderr" => result["stderr"] || "",
      "output" => output,
      "output_truncated" => result["output_truncated"] == true,
      "timed_out" => result["timed_out"] == true,
      "diagnosis" => diagnosis(ok?, output, result)
    }
  end

  defp blocked_result(:unsupported_executable, argv) do
    %{
      "tool" => name(),
      "ok" => false,
      "blocked" => true,
      "reason" => "unsupported_executable",
      "argv" => argv,
      "diagnosis" => "Only git and gh commands are allowed through git.run. Use shell.exec for other executables."
    }
  end

  defp blocked_result(reason, argv) do
    %{
      "tool" => name(),
      "ok" => false,
      "blocked" => true,
      "reason" => Atom.to_string(reason),
      "argv" => argv,
      "diagnosis" => "Command blocked by policy."
    }
  end

  defp error_result(reason) do
    %{
      "tool" => name(),
      "ok" => false,
      "error" => inspect(reason),
      "diagnosis" => error_diagnosis(reason)
    }
  end

  defp diagnosis(true, _output, _result), do: nil

  defp diagnosis(false, output, %{"timed_out" => true}) when is_binary(output) do
    "The command timed out before completion. Narrow the query or increase timeout_ms."
  end

  defp diagnosis(false, output, _result) when is_binary(output) do
    cond do
      String.contains?(output, "not a git repository") ->
        "The selected workspace root is not inside a Git repository. Register or choose the repository root."

      String.contains?(output, "gh auth login") or String.contains?(output, "not logged in") ->
        "GitHub CLI is not authenticated for this local runtime. Set GH_TOKEN/GITHUB_TOKEN in the runtime environment."

      String.contains?(output, "command not found") ->
        "The requested executable is not installed or not on PATH for the runtime process."

      true ->
        "The command exited non-zero. Review stdout/stderr for the Git or GitHub CLI error."
    end
  end

  defp error_diagnosis(:workspace_root_not_registered) do
    "Register a local runtime helper with a workspace root before assigning local Git tools."
  end

  defp error_diagnosis({:executable_not_found, "git"}), do: "Git is not installed or not on PATH for the runtime process."
  defp error_diagnosis({:executable_not_found, "gh"}), do: "GitHub CLI is not installed or not on PATH for the runtime process."
  defp error_diagnosis({:workspace_root_not_found, _root}), do: "The registered workspace root no longer exists on this machine."
  defp error_diagnosis(reason), do: "git.run could not start: #{inspect(reason)}"

  defp routing_config do
    endpoint = System.get_env("LAUNCHER_SUPABASE_URL") || System.get_env("SUPABASE_URL")
    api_key = System.get_env("LAUNCHER_SUPABASE_SERVICE_KEY") || System.get_env("SUPABASE_SERVICE_ROLE_KEY")

    cond do
      not is_binary(endpoint) or endpoint == "" -> {:error, :supabase_unconfigured}
      not is_binary(api_key) or api_key == "" -> {:error, :supabase_unconfigured}
      true -> {:ok, %{endpoint: Supabase.rest_endpoint!(endpoint: endpoint), api_key: api_key}}
    end
  end

  defp routing_client(config), do: PostgRESTClient.new(config, req_options())
  defp req_options, do: Application.get_env(:symphony_elixir, :git_run_req_options, [])

  defp bounded_integer(value, min, max) when is_integer(value), do: value |> max(min) |> min(max)
  defp bounded_integer(_value, _min, _max), do: nil

  defp string_value(map, key) when is_map(map) do
    case map_value(map, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp string_value(_map, _key), do: nil

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  defp map_value(_map, _key), do: nil
end
