defmodule SymphonyElixir.Planner.RepositoryTools do
  @moduledoc """
  Read-only repository tools for planner agents.

  Repository access is scoped to a materialized workspace directory. All paths
  are canonicalized before use so traversal and symlink escapes cannot leave the
  workspace root.
  """

  alias SymphonyElixir.Planner.RepositoryIndex
  alias SymphonyElixir.{Config, PathSafety}

  @tools ["repo.list", "repo.search", "repo.read_file", "repo.read_symbols"]
  @default_depth 2
  @max_depth 8
  @default_limit 50
  @max_limit 200
  @default_file_byte_limit 65_536
  @max_file_byte_limit 262_144
  @default_snippet_chars 240
  @max_snippet_chars 1_000
  @search_timeout_ms 5_000

  @spec tool_names() :: [String.t()]
  def tool_names, do: @tools

  @spec execute(String.t(), term(), keyword()) :: {:ok, term()} | {:error, term()}
  def execute(tool, arguments, opts \\ [])

  @spec execute(String.t(), term(), keyword()) :: {:ok, term()} | {:error, term()}
  def execute("repo.list", arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace} <- resolve_workspace(args, opts),
         {:ok, path} <- optional_path(args),
         {:ok, depth} <- bounded_integer(args, "max_depth", @default_depth, 0, @max_depth),
         {:ok, limit} <- bounded_integer(args, "limit", @default_limit, 1, @max_limit),
         {:ok, directory} <- resolve_path(workspace, path, :allow_directory),
         :ok <- ensure_allowed_read_path(workspace, directory, path),
         {:ok, entries} <- list_entries(workspace, directory, depth, limit) do
      {:ok, %{"workspace_id" => Map.get(args, "workspace_id"), "path" => relative_path(workspace, directory), "entries" => entries}}
    end
  end

  def execute("repo.search", arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace} <- resolve_workspace(args, opts),
         {:ok, query} <- required_string(args, "query"),
         {:ok, path} <- optional_path(args),
         {:ok, limit} <- bounded_integer(args, "limit", @default_limit, 1, @max_limit),
         {:ok, snippet_chars} <- bounded_integer(args, "snippet_chars", @default_snippet_chars, 40, @max_snippet_chars),
         {:ok, search_root} <- resolve_path(workspace, path, :allow_file_or_directory),
         :ok <- ensure_allowed_read_path(workspace, search_root, path),
         {:ok, matches} <- search_matches(workspace, search_root, query, limit, snippet_chars, opts) do
      {:ok, %{"workspace_id" => Map.get(args, "workspace_id"), "query" => query, "matches" => matches}}
    end
  end

  def execute("repo.read_file", arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace} <- resolve_workspace(args, opts),
         {:ok, path} <- required_string(args, "path"),
         {:ok, byte_limit} <- bounded_integer(args, "byte_limit", @default_file_byte_limit, 1, @max_file_byte_limit),
         {:ok, file_path} <- resolve_path(workspace, path, :allow_file),
         :ok <- ensure_allowed_read_path(workspace, file_path, path),
         {:ok, content, bytes_read, truncated} <- read_file(file_path, byte_limit) do
      {:ok,
       %{
         "workspace_id" => Map.get(args, "workspace_id"),
         "path" => relative_path(workspace, file_path),
         "content" => content,
         "bytes_read" => bytes_read,
         "truncated" => truncated
       }}
    end
  end

  def execute("repo.read_symbols", arguments, opts) do
    with {:ok, args} <- normalize_arguments(arguments),
         {:ok, workspace} <- resolve_workspace(args, opts) do
      RepositoryIndex.read_symbols(workspace, args, opts)
    end
  end

  def execute(tool, _arguments, _opts), do: {:error, {:unsupported_repository_tool, tool, @tools}}

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "repo.list",
        "description" => "List files and directories under a materialized workspace using read-only path-safe access.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id"],
          "properties" =>
            common_properties(%{
              "path" => nullable_string_schema("Relative path to list. Defaults to the workspace root."),
              "max_depth" => integer_schema("Maximum recursive depth from path.", 0, @max_depth),
              "limit" => integer_schema("Maximum entries to return.", 1, @max_limit)
            })
        }
      },
      %{
        "name" => "repo.search",
        "description" => "Search repository text with a controlled ripgrep backend and bounded snippets.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id", "query"],
          "properties" =>
            common_properties(%{
              "path" => nullable_string_schema("Relative file or directory to search. Defaults to the workspace root."),
              "query" => string_schema("Search query."),
              "limit" => integer_schema("Maximum matches to return.", 1, @max_limit),
              "snippet_chars" => integer_schema("Maximum characters returned for each line snippet.", 40, @max_snippet_chars)
            })
        }
      },
      %{
        "name" => "repo.read_file",
        "description" => "Read a bounded text file from a materialized workspace using path-safe access.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id", "path"],
          "properties" =>
            common_properties(%{
              "path" => string_schema("Relative file path to read."),
              "byte_limit" => integer_schema("Maximum bytes to read.", 1, @max_file_byte_limit)
            })
        }
      },
      %{
        "name" => "repo.read_symbols",
        "description" => "Read a bounded symbol index for definitions, routes, and tests in a materialized workspace.",
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id"],
          "properties" =>
            common_properties(%{
              "path" => nullable_string_schema("Optional path prefix inside the repository."),
              "query" => nullable_string_schema("Optional case-insensitive query over path, kind, name, and signature."),
              "kinds" => %{
                "type" => ["array", "null"],
                "description" => "Optional symbol kinds to include.",
                "items" => %{"type" => "string", "enum" => ["module", "type", "function", "route", "test"]}
              },
              "limit" => integer_schema("Maximum symbols to return.", 1, @max_limit)
            })
        }
      }
    ]
  end

  @spec tool_spec(String.t()) :: map()
  def tool_spec(name) when is_binary(name) do
    Enum.find(tool_specs(), &(&1["name"] == name)) || raise ArgumentError, "unknown repository tool #{inspect(name)}"
  end

  defp common_properties(properties) do
    Map.merge(
      %{
        "workspace_id" => string_schema("Workspace identifier whose materialized checkout is under the configured workspace root."),
        "repo_id" => nullable_string_schema("Optional repository identifier for future repo-cache routing."),
        "repository_id" => nullable_string_schema("Optional repository identifier alias for future repo-cache routing.")
      },
      properties
    )
  end

  defp list_entries(workspace, directory, max_depth, limit) do
    if File.dir?(directory) do
      {:ok,
       directory
       |> walk_entries(max_depth, limit)
       |> Enum.map(&entry_payload(workspace, &1))}
    else
      {:error, {:not_a_directory, relative_path(workspace, directory)}}
    end
  end

  defp walk_entries(directory, max_depth, limit) do
    {entries, _count} = do_walk_entries(directory, 0, max_depth, limit, [], 0)
    Enum.reverse(entries)
  end

  defp do_walk_entries(_directory, _depth, _max_depth, limit, entries, count) when count >= limit, do: {entries, count}

  defp do_walk_entries(directory, depth, max_depth, limit, entries, count) do
    children =
      directory
      |> File.ls!()
      |> Enum.sort()
      |> Enum.map(&Path.join(directory, &1))

    Enum.reduce_while(children, {entries, count}, fn child, {acc, current_count} ->
      if current_count >= limit do
        {:halt, {acc, current_count}}
      else
        walk_child(child, depth, max_depth, limit, acc, current_count)
      end
    end)
  end

  defp walk_child(child, depth, max_depth, limit, entries, count) do
    case File.lstat(child) do
      {:ok, stat} ->
        entry = {child, stat}
        count = count + 1
        entries = [entry | entries]

        cond do
          count >= limit ->
            {:halt, {entries, count}}

          stat.type == :directory and depth < max_depth ->
            {entries, count} = do_walk_entries(child, depth + 1, max_depth, limit, entries, count)
            {:cont, {entries, count}}

          true ->
            {:cont, {entries, count}}
        end

      {:error, _reason} ->
        {:cont, {entries, count}}
    end
  end

  defp entry_payload(workspace, {path, %File.Stat{} = stat}) do
    %{
      "path" => relative_path(workspace, path),
      "type" => Atom.to_string(stat.type),
      "size" => stat.size
    }
  end

  defp search_matches(workspace, search_root, query, limit, snippet_chars, opts) do
    rg = Keyword.get(opts, :rg_path) || System.find_executable("rg")

    if is_binary(rg) do
      search_path = relative_path(workspace, search_root)

      args = [
        "--json",
        "--line-number",
        "--column",
        "--color",
        "never",
        "--hidden",
        "--max-count",
        Integer.to_string(limit),
        "--",
        query,
        search_path
      ]

      case run_rg(rg, args, workspace, Keyword.get(opts, :search_timeout_ms, @search_timeout_ms)) do
        {output, status} when status in [0, 1] ->
          {:ok, parse_rg_json(output, limit, snippet_chars)}

        {output, status} ->
          {:error, {:search_failed, status, String.slice(output, 0, 1_000)}}
      end
    else
      {:error, :ripgrep_not_found}
    end
  end

  defp run_rg(rg, args, workspace, timeout_ms) do
    task = Task.async(fn -> System.cmd(rg, args, cd: workspace, stderr_to_stdout: true, parallelism: true) end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      nil -> {"ripgrep timed out after #{timeout_ms}ms", 124}
    end
  catch
    :exit, reason -> {inspect(reason), 1}
  end

  defp parse_rg_json(output, limit, snippet_chars) do
    output
    |> String.split("\n", trim: true)
    |> Enum.reduce_while([], fn line, acc ->
      if length(acc) >= limit do
        {:halt, acc}
      else
        {:cont, maybe_add_rg_match(line, acc, snippet_chars)}
      end
    end)
    |> Enum.reverse()
  end

  defp maybe_add_rg_match(line, acc, snippet_chars) do
    case Jason.decode(line) do
      {:ok, %{"type" => "match", "data" => data}} -> maybe_add_match_payload(data, acc, snippet_chars)
      _ -> acc
    end
  end

  defp maybe_add_match_payload(data, acc, snippet_chars) do
    [match_payload(data, snippet_chars) | acc]
  end

  defp match_payload(data, snippet_chars) do
    line = get_in(data, ["lines", "text"]) || ""
    path = data |> get_in(["path", "text"]) |> normalize_result_path()

    %{
      "path" => path,
      "line" => Map.get(data, "line_number"),
      "column" => match_column(data),
      "snippet" => bounded_snippet(line, snippet_chars)
    }
  end

  defp match_column(%{"submatches" => [%{"start" => start} | _]}) when is_integer(start), do: start + 1
  defp match_column(_data), do: nil

  defp normalize_result_path("./" <> path), do: path
  defp normalize_result_path(path), do: path

  defp read_file(path, byte_limit) do
    if File.regular?(path) do
      read_regular_file(path, byte_limit)
    else
      {:error, {:not_a_file, path}}
    end
  end

  defp read_regular_file(path, byte_limit) do
    case File.open(path, [:read, :binary]) do
      {:ok, io} ->
        content = IO.binread(io, byte_limit + 1)
        File.close(io)
        handle_file_read_content(content, path, byte_limit)

      {:error, reason} ->
        {:error, {:file_read_failed, reason}}
    end
  end

  defp handle_file_read_content(:eof, _path, _byte_limit), do: {:ok, "", 0, false}
  defp handle_file_read_content({:error, reason}, _path, _byte_limit), do: {:error, {:file_read_failed, reason}}
  defp handle_file_read_content(content, path, byte_limit), do: bounded_file_content(content, path, byte_limit)

  defp bounded_file_content(content, path, byte_limit) do
    bytes = byte_size(content)
    truncated = bytes > byte_limit
    bounded = if truncated, do: binary_part(content, 0, byte_limit), else: content

    if String.valid?(bounded) do
      {:ok, bounded, byte_size(bounded), truncated}
    else
      {:error, {:non_utf8_file, path}}
    end
  end

  defp resolve_workspace(args, opts) do
    with {:ok, workspace_id} <- required_string(args, "workspace_id"),
         :ok <- validate_path_segment(workspace_id),
         {:ok, root} <- workspace_root(opts),
         {:ok, workspace} <- PathSafety.canonicalize(Path.join(root, workspace_id)),
         {:ok, canonical_root} <- PathSafety.canonicalize(root),
         :ok <- ensure_under_root(canonical_root, workspace),
         true <- File.dir?(workspace) || {:error, {:workspace_not_found, workspace_id}} do
      {:ok, workspace}
    end
  end

  defp workspace_root(opts) do
    root = Keyword.get(opts, :workspace_root) || Config.settings!().workspace.root
    PathSafety.canonicalize(root)
  end

  defp resolve_path(workspace, path, kind) do
    with :ok <- validate_relative_path(path),
         {:ok, resolved} <- PathSafety.canonicalize(Path.expand(path, workspace)),
         :ok <- ensure_under_root(workspace, resolved),
         :ok <- validate_existing_path(resolved, kind) do
      {:ok, resolved}
    end
  end

  defp validate_existing_path(path, :allow_directory) do
    if File.dir?(path), do: :ok, else: {:error, {:path_not_directory, path}}
  end

  defp validate_existing_path(path, :allow_file) do
    if File.regular?(path), do: :ok, else: {:error, {:path_not_file, path}}
  end

  defp validate_existing_path(path, :allow_file_or_directory) do
    if File.exists?(path), do: :ok, else: {:error, {:path_not_found, path}}
  end

  defp ensure_allowed_read_path(workspace, resolved, requested_path) do
    relative = relative_path(workspace, resolved)

    if is_binary(relative) do
      :ok
    else
      {:error, {:invalid_path, requested_path}}
    end
  end

  defp ensure_under_root(root, path) do
    root_prefix = root <> "/"

    if path == root or String.starts_with?(path <> "/", root_prefix) do
      :ok
    else
      {:error, {:path_outside_workspace, path, root}}
    end
  end

  defp validate_relative_path(path) do
    cond do
      Path.type(path) == :absolute ->
        {:error, {:invalid_path, :absolute, path}}

      String.contains?(path, <<0>>) ->
        {:error, {:invalid_path, :null_byte, path}}

      Enum.any?(Path.split(path), &(&1 == "..")) ->
        {:error, {:invalid_path, :traversal, path}}

      true ->
        :ok
    end
  end

  defp validate_path_segment(segment) do
    if segment != "" and segment not in [".", ".."] and not String.contains?(segment, ["/", "\\", <<0>>, "\n", "\r"]) do
      :ok
    else
      {:error, {:invalid_workspace_id, segment}}
    end
  end

  defp relative_path(workspace, path) do
    case Path.relative_to(path, workspace) do
      "" -> "."
      relative -> relative
    end
  end

  defp bounded_snippet(line, snippet_chars) do
    line
    |> String.trim_trailing()
    |> String.slice(0, snippet_chars)
  end

  defp optional_path(args) do
    case Map.get(args, "path") do
      nil -> {:ok, "."}
      "" -> {:ok, "."}
      path when is_binary(path) -> {:ok, path}
      _ -> {:error, {:invalid_argument, "path", "must be a string"}}
    end
  end

  defp bounded_integer(args, key, default, min, max) do
    value = Map.get(args, key, default)

    cond do
      is_integer(value) and value >= min and value <= max ->
        {:ok, value}

      is_integer(value) ->
        {:error, {:invalid_argument, key, "must be between #{min} and #{max}"}}

      true ->
        {:error, {:invalid_argument, key, "must be an integer"}}
    end
  end

  defp normalize_arguments(arguments) when is_map(arguments) do
    {:ok, Map.new(arguments, fn {key, value} -> {to_string(key), value} end)}
  end

  defp normalize_arguments(_arguments), do: {:error, :invalid_arguments}

  defp required_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, {:missing_argument, key}}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, {:missing_argument, key}}
    end
  end

  defp string_schema(description), do: %{"type" => "string", "description" => description}
  defp nullable_string_schema(description), do: %{"type" => ["string", "null"], "description" => description}

  defp integer_schema(description, minimum, maximum) do
    %{"type" => ["integer", "null"], "description" => description, "minimum" => minimum, "maximum" => maximum}
  end
end
