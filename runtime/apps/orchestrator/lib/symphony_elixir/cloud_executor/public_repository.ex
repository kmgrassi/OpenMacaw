defmodule SymphonyElixir.CloudExecutor.PublicRepository do
  @moduledoc """
  Materializes public Git repository resources for container execution.

  This module is intentionally transport-neutral. AWS/ECS task launch code can
  pass the same request shape to an executor container, and the container uses
  this module to clone repositories into a task-local workspace and execute
  read-only inspection commands.
  """

  alias SymphonyElixir.PathSafety

  @workspace_root "/workspace"
  @resources_dir "resources"
  @alias_regex ~r/^[a-z0-9_-]+$/
  @default_timeout_ms 60_000
  @default_command_timeout_ms 10_000
  @max_output_bytes 65_536
  @read_only_commands ~w(cat find grep head ls pwd rg sed tail wc)
  @git_read_only_subcommands ~w(
    branch describe diff grep log ls-files remote rev-parse show status
  )

  # Read-only execution still needs argument-level containment for commands
  # whose options can spawn subprocesses or mutate the cloned workspace.
  @deny_flags %{
    "find" => ~w(-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls),
    "grep" => ~w(--exec --output --files-with-matches=/dev/stdin),
    "rg" => ~w(--pre --pre-glob --hostname-bin -O --output),
    "sed" => ~w(-i --in-place),
    "cat" => [],
    "head" => [],
    "tail" => [],
    "ls" => [],
    "pwd" => [],
    "wc" => []
  }

  @git_deny_flags %{
    "branch" => ~w(--edit-description -d -D -m -M --delete --rename --create-reflog),
    "describe" => [],
    "diff" => ~w(--ext-diff --textconv --output),
    "grep" => ~w(--open-files-in-pager -O --ext-grep),
    "log" => ~w(--ext-diff --textconv --output),
    "ls-files" => [],
    "remote" => ~w(add remove rm set-url rename prune update),
    "rev-parse" => [],
    "show" => ~w(--ext-diff --textconv --output),
    "status" => []
  }

  @global_deny_prefixes ~w(--exec --exec-path --filter --upload-pack --receive-pack --eval)

  @type request :: map()
  @type result :: {:ok, map()} | {:error, map()}

  @spec run(request(), keyword()) :: result()
  def run(request, opts \\ []) when is_map(request) and is_list(opts) do
    workspace_root = Keyword.get(opts, :workspace_root, @workspace_root)

    with {:ok, normalized} <- normalize_request(request),
         {:ok, workspace} <- prepare_workspace(workspace_root),
         {:ok, materialized} <- materialize_resources(normalized.resources, workspace, opts),
         {:ok, commands} <- run_commands(normalized.commands, workspace, opts) do
      {:ok,
       %{
         "workspace" => workspace,
         "resources" => materialized,
         "commands" => commands
       }}
    end
  end

  @spec normalize_request(map()) :: {:ok, map()} | {:error, map()}
  def normalize_request(request) when is_map(request) do
    resources = Map.get(request, "resources") || Map.get(request, :resources)
    commands = Map.get(request, "commands") || Map.get(request, :commands) || default_commands(resources)

    with {:ok, resources} <- normalize_resources(resources),
         {:ok, commands} <- normalize_commands(commands) do
      {:ok,
       %{
         resources: resources,
         commands: commands,
         metadata: request_metadata(request)
       }}
    end
  end

  @spec resource_path(Path.t(), String.t()) :: {:ok, Path.t()} | {:error, map()}
  def resource_path(workspace, alias_slug) when is_binary(workspace) and is_binary(alias_slug) do
    with :ok <- validate_alias(alias_slug),
         {:ok, resources_root} <- PathSafety.canonicalize(Path.join(workspace, @resources_dir)),
         {:ok, path} <- PathSafety.canonicalize(Path.join(resources_root, alias_slug)),
         :ok <- ensure_under_root(resources_root, path) do
      {:ok, path}
    else
      {:error, reason} -> {:error, error("invalid_resource_path", reason)}
    end
  end

  @spec command_cwd(Path.t(), String.t() | nil) :: {:ok, Path.t()} | {:error, map()}
  def command_cwd(workspace, cwd) when is_binary(workspace) do
    cwd = blank_to_default(cwd, ".")

    with :ok <- validate_relative_path(cwd),
         {:ok, workspace} <- PathSafety.canonicalize(workspace),
         {:ok, resolved} <- PathSafety.canonicalize(Path.expand(cwd, workspace)),
         :ok <- ensure_under_root(workspace, resolved),
         true <- File.dir?(resolved) || {:error, {:cwd_not_found, cwd}} do
      {:ok, resolved}
    else
      {:error, %{} = error} -> {:error, error}
      {:error, reason} -> {:error, error("cwd_denied", reason)}
    end
  end

  defp normalize_resources(resources) when is_list(resources) and resources != [] do
    resources
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {resource, index}, {:ok, acc} ->
      case normalize_resource(resource, index) do
        {:ok, normalized} -> {:cont, {:ok, [normalized | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp normalize_resources(_resources), do: {:error, error("missing_resources", "resources must be a non-empty list")}

  defp normalize_resource(resource, index) when is_map(resource) do
    with {:ok, alias_slug} <- required_string(resource, "alias"),
         :ok <- validate_alias(alias_slug),
         {:ok, url} <- repository_url(resource),
         :ok <- validate_public_url(url),
         {:ok, ref} <- required_string(resource, "ref") do
      {:ok,
       %{
         "alias" => alias_slug,
         "url" => url,
         "ref" => ref,
         "kind" => string_value(resource, "kind") || "git_repository",
         "provider" => string_value(resource, "provider") || "git",
         "resource_id" => string_value(resource, "resource_id"),
         "grant_id" => string_value(resource, "grant_id"),
         "required" => Map.get(resource, "required", Map.get(resource, :required, true)),
         "index" => index
       }}
    end
  end

  defp normalize_resource(_resource, index), do: {:error, error("invalid_resource", "resource #{index} must be an object")}

  defp normalize_commands(commands) when is_list(commands) do
    commands
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, []}, fn {command, index}, {:ok, acc} ->
      case normalize_command(command, index) do
        {:ok, normalized} -> {:cont, {:ok, [normalized | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp normalize_commands(_commands), do: {:error, error("invalid_commands", "commands must be a list")}

  defp normalize_command(command, index) when is_map(command) do
    argv = Map.get(command, "argv") || Map.get(command, :argv)

    with {:ok, argv} <- argv_list(argv),
         :ok <- validate_read_only_argv(argv) do
      {:ok,
       %{
         "name" => string_value(command, "name") || "command-#{index + 1}",
         "argv" => argv,
         "cwd" => string_value(command, "cwd") || ".",
         "index" => index
       }}
    end
  end

  defp normalize_command(_command, index), do: {:error, error("invalid_command", "command #{index} must be an object")}

  defp default_commands(resources) when is_list(resources) do
    Enum.map(resources, fn resource ->
      alias_slug = string_value(resource, "alias") || "repo"

      %{
        "name" => "git-head-#{alias_slug}",
        "argv" => ["git", "rev-parse", "HEAD"],
        "cwd" => Path.join([@resources_dir, alias_slug])
      }
    end)
  end

  defp default_commands(_resources), do: []

  defp prepare_workspace(workspace_root) do
    workspace = Path.expand(workspace_root)
    resources = Path.join(workspace, @resources_dir)

    with :ok <- File.mkdir_p(resources),
         {:ok, workspace} <- PathSafety.canonicalize(workspace),
         {:ok, resources} <- PathSafety.canonicalize(resources),
         :ok <- ensure_under_root(workspace, resources) do
      {:ok, workspace}
    else
      {:error, reason} -> {:error, error("workspace_prepare_failed", reason)}
    end
  end

  defp materialize_resources(resources, workspace, opts) do
    resources
    |> Enum.reduce_while({:ok, []}, fn resource, {:ok, acc} ->
      case materialize_resource(resource, workspace, opts) do
        {:ok, materialized} -> {:cont, {:ok, [materialized | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp materialize_resource(resource, workspace, opts) do
    git = Keyword.get(opts, :git_path) || System.find_executable("git")
    timeout_ms = Keyword.get(opts, :clone_timeout_ms, @default_timeout_ms)

    with {:ok, git} <- require_git(git),
         {:ok, path} <- resource_path(workspace, resource["alias"]),
         :ok <- ensure_empty_path(path),
         {:ok, _output} <- run_system(git, ["clone", "--no-checkout", resource["url"], path], workspace, timeout_ms),
         {:ok, _output} <- run_system(git, ["-C", path, "checkout", "--detach", resource["ref"]], workspace, timeout_ms),
         {:ok, head} <- run_system(git, ["-C", path, "rev-parse", "HEAD"], workspace, timeout_ms) do
      {:ok,
       %{
         "resource_id" => resource["resource_id"],
         "grant_id" => resource["grant_id"],
         "alias" => resource["alias"],
         "path" => Path.relative_to(path, workspace),
         "kind" => resource["kind"],
         "provider" => resource["provider"],
         "locator" => resource["url"],
         "ref" => resource["ref"],
         "commit" => String.trim(head),
         "required" => resource["required"],
         "status" => "materialized",
         "credential_ref" => nil
       }}
    else
      {:error, %{} = reason} ->
        {:error, Map.put_new(reason, "alias", resource["alias"])}

      {:error, reason} ->
        {:error, error("materialization_failed", reason, %{"alias" => resource["alias"]})}
    end
  end

  defp run_commands(commands, workspace, opts) do
    commands
    |> Enum.reduce_while({:ok, []}, fn command, {:ok, acc} ->
      case run_command(command, workspace, opts) do
        {:ok, result} -> {:cont, {:ok, [result | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, Enum.reverse(values)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp run_command(command, workspace, opts) do
    [program | args] = command["argv"]
    timeout_ms = Keyword.get(opts, :command_timeout_ms, @default_command_timeout_ms)

    with {:ok, cwd} <- command_cwd(workspace, command["cwd"]),
         {:ok, executable} <- resolve_command(program, opts) do
      case run_system(executable, args, cwd, timeout_ms) do
        {:ok, output} ->
          {:ok,
           %{
             "name" => command["name"],
             "argv" => command["argv"],
             "cwd" => Path.relative_to(cwd, workspace),
             "status" => "completed",
             "output" => truncate_output(output)
           }}

        {:error, %{"exit_code" => exit_code} = reason} ->
          {:ok,
           %{
             "name" => command["name"],
             "argv" => command["argv"],
             "cwd" => Path.relative_to(cwd, workspace),
             "status" => "failed",
             "exit_code" => exit_code,
             "output" => Map.get(reason, "output", "")
           }}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp run_system(program, args, cwd, timeout_ms) do
    task =
      Task.async(fn ->
        System.cmd(program, args, cd: cwd, stderr_to_stdout: true, parallelism: true)
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, {output, 0}} -> {:ok, output}
      {:ok, {output, code}} -> {:error, error("command_failed", "command exited with #{code}", %{"exit_code" => code, "output" => truncate_output(output)})}
      nil -> {:error, error("command_timeout", "command timed out after #{timeout_ms}ms")}
    end
  catch
    :exit, reason -> {:error, error("command_crashed", inspect(reason))}
  end

  defp ensure_empty_path(path) do
    case File.ls(path) do
      {:ok, []} ->
        # Directory exists and is empty; ensure it is still present.
        File.mkdir_p(path)

      {:ok, _entries} ->
        {:error, error("resource_path_not_empty", path)}

      {:error, :enoent} ->
        # Path does not exist; create it.
        File.mkdir_p(path)

      {:error, :enotdir} ->
        # A regular file (or other non-directory) is in the way. Returning a
        # structured error here matches the error-tuple convention used by
        # `run/2` and avoids crashing on `File.ls!/1`'s `File.Error`.
        {:error, error("resource_path_not_directory", path)}

      {:error, reason} ->
        {:error, error("resource_path_unreadable", reason, %{"path" => path})}
    end
  end

  defp require_git(nil), do: {:error, error("git_not_found", "git executable not found")}
  defp require_git(path) when is_binary(path), do: {:ok, path}

  defp resolve_command("git", opts), do: require_git(Keyword.get(opts, :git_path) || System.find_executable("git"))

  defp resolve_command(program, _opts) when program in @read_only_commands do
    case System.find_executable(program) do
      nil -> {:error, error("command_not_found", program)}
      path -> {:ok, path}
    end
  end

  defp resolve_command(program, _opts), do: {:error, error("command_not_allowed", program)}

  defp validate_read_only_argv([]), do: {:error, error("invalid_command", "argv must not be empty")}

  defp validate_read_only_argv(["git", subcommand | rest])
       when subcommand in @git_read_only_subcommands do
    validate_git_args(subcommand, rest)
  end

  defp validate_read_only_argv(["git" | _args]),
    do: {:error, error("command_not_allowed", "git command is not read-only")}

  defp validate_read_only_argv([program | rest]) when program in @read_only_commands do
    validate_command_args(program, rest)
  end

  defp validate_read_only_argv([program | _args]), do: {:error, error("command_not_allowed", program)}

  defp validate_command_args(program, args) do
    deny = Map.get(@deny_flags, program, [])
    validate_argv_tokens(program, args, deny)
  end

  defp validate_git_args(subcommand, args) do
    deny = Map.get(@git_deny_flags, subcommand, [])
    validate_argv_tokens("git " <> subcommand, args, deny)
  end

  defp validate_argv_tokens(_context, [], _deny), do: :ok

  defp validate_argv_tokens(context, [token | rest], deny) do
    cond do
      not is_binary(token) ->
        {:error, error("invalid_command", "argv entries must be strings")}

      String.contains?(token, <<0>>) ->
        {:error, error("invalid_command", "argv entries must not contain null bytes")}

      denied_token?(token, deny) or denied_global?(token) ->
        {:error, error("command_not_allowed", "argument not permitted for #{context}: #{token}")}

      true ->
        validate_argv_tokens(context, rest, deny)
    end
  end

  defp denied_token?(token, deny) when is_list(deny) do
    Enum.any?(deny, fn entry -> token == entry or String.starts_with?(token, entry <> "=") end)
  end

  defp denied_global?(token) do
    Enum.any?(@global_deny_prefixes, fn prefix ->
      token == prefix or String.starts_with?(token, prefix <> "=")
    end)
  end

  defp argv_list(argv) when is_list(argv) and argv != [] do
    if Enum.all?(argv, &(is_binary(&1) and String.trim(&1) != "" and not String.contains?(&1, <<0>>))) do
      {:ok, argv}
    else
      {:error, error("invalid_command", "argv entries must be non-empty strings")}
    end
  end

  defp argv_list(_argv), do: {:error, error("invalid_command", "argv must be a non-empty list")}

  defp repository_url(resource) do
    case string_value(resource, "url") || string_value(resource, "locator") || string_value(resource, "repository_url") do
      nil -> {:error, error("missing_repository_url", "resource url is required")}
      url -> {:ok, url}
    end
  end

  defp validate_public_url(url) do
    case URI.parse(url) do
      %URI{scheme: scheme, host: host, userinfo: nil} when scheme in ["https", "http"] and is_binary(host) ->
        :ok

      %URI{userinfo: userinfo} when is_binary(userinfo) ->
        {:error, error("repository_url_contains_credentials", "public clone URLs must not include credentials")}

      _ ->
        {:error, error("invalid_repository_url", "repository URL must be http(s)")}
    end
  end

  defp validate_alias(alias_slug) do
    if Regex.match?(@alias_regex, alias_slug) do
      :ok
    else
      {:error, error("invalid_resource_alias", alias_slug)}
    end
  end

  defp validate_relative_path(path) when is_binary(path) do
    cond do
      Path.type(path) == :absolute ->
        {:error, error("cwd_denied", {:absolute, path})}

      String.contains?(path, <<0>>) ->
        {:error, error("cwd_denied", {:null_byte, path})}

      Enum.any?(Path.split(path), &(&1 == "..")) ->
        {:error, error("cwd_denied", {:traversal, path})}

      true ->
        :ok
    end
  end

  defp validate_relative_path(_path), do: {:error, error("cwd_denied", :not_binary)}

  defp ensure_under_root(root, path) do
    root = Path.expand(root)
    path = Path.expand(path)
    prefix = root <> "/"

    if path == root or String.starts_with?(path <> "/", prefix) do
      :ok
    else
      {:error, {:path_outside_workspace, path, root}}
    end
  end

  defp request_metadata(request) do
    %{
      "workspace_id" => string_value(request, "workspace_id"),
      "agent_id" => string_value(request, "agent_id"),
      "run_id" => string_value(request, "run_id"),
      "session_id" => string_value(request, "session_id"),
      "execution_mode" => string_value(request, "execution_mode") || "planning_read_only"
    }
  end

  defp required_string(map, key) do
    case string_value(map, key) do
      nil -> {:error, error("missing_field", key)}
      value -> {:ok, value}
    end
  end

  defp string_value(map, key) when is_map(map) do
    value = Map.get(map, key) || Map.get(map, String.to_atom(key))

    if is_binary(value) do
      value = String.trim(value)
      if value == "", do: nil, else: value
    end
  end

  defp string_value(_map, _key), do: nil

  defp blank_to_default(nil, default), do: default
  defp blank_to_default("", default), do: default
  defp blank_to_default(value, _default), do: value

  defp truncate_output(output) when byte_size(output) <= @max_output_bytes, do: output
  defp truncate_output(output), do: binary_part(output, 0, @max_output_bytes)

  defp error(code, detail, extra \\ %{}) do
    Map.merge(%{"code" => code, "detail" => inspect(detail)}, extra)
  end
end
