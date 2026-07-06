defmodule SymphonyElixir.CloudExecutor.CodingExecutor do
  @moduledoc """
  Stdio-framed executor for container-backed coding tools.

  The executor prepares a task-local workspace, then reads one JSON frame per
  line from stdin and writes one JSON frame per line to stdout. It intentionally
  reuses the Runtime coding tool executors so `shell.exec` and `apply_patch`
  keep the same containment, timeout, output-cap, env allowlist, and patch
  safety semantics as the local-helper path.
  """

  alias SymphonyElixir.CloudExecutor.PublicRepository
  alias SymphonyElixir.{PathSafety, PolicyGate}
  alias SymphonyElixir.Runner.CodingTools.ShellExecutor
  alias SymphonyElixir.Tools.ApplyPatch
  alias SymphonyElixir.Tools.ShellExec

  @schema_version "1"
  @default_workspace_root "/workspace"
  @default_repository_alias "repo"

  @type request :: map()
  @type prepared :: %{
          required(:workspace_root) => Path.t(),
          required(:tool_workspace) => Path.t(),
          required(:materialized_repository) => map() | nil,
          required(:env_allowlist) => [String.t()] | nil
        }

  @spec prepare(request(), keyword()) :: {:ok, prepared()} | {:error, map()}
  def prepare(request, opts \\ []) when is_map(request) and is_list(opts) do
    workspace_root = Keyword.get(opts, :workspace_root) || string_value(request, "workspace_root") || @default_workspace_root

    with {:ok, workspace_root} <- prepare_workspace_root(workspace_root),
         {:ok, tool_workspace, materialized_repository} <- prepare_tool_workspace(request, workspace_root, opts) do
      {:ok,
       %{
         workspace_root: workspace_root,
         tool_workspace: tool_workspace,
         materialized_repository: materialized_repository,
         env_allowlist: env_allowlist(request)
       }}
    end
  end

  @spec run_loop(prepared(), keyword()) :: :ok
  def run_loop(prepared, opts \\ []) when is_map(prepared) and is_list(opts) do
    input = Keyword.get(opts, :input, IO.stream(:stdio, :line))
    output = Keyword.get(opts, :output, &write_stdout/1)
    ensure_policy_engine_started()

    output.(
      progress_frame("executor_ready", %{
        "workspace_root" => prepared.workspace_root,
        "tool_workspace" => prepared.tool_workspace,
        "repository" => prepared.materialized_repository
      })
    )

    input
    |> Stream.map(&String.trim_trailing(&1, "\n"))
    |> Enum.reduce(%{}, fn line, running ->
      handle_line(line, prepared, output, running)
    end)
    |> await_running(output)

    :ok
  end

  @spec execute_frame(map(), prepared(), (map() -> term())) :: {map(), map()}
  def execute_frame(%{"type" => "tool_execution_request"} = frame, prepared, output) when is_function(output, 1) do
    tool_call_id = string_value(frame, "tool_call_id") || "tool-call"
    name = string_value(frame, "name")
    arguments = Map.get(frame, "arguments") || %{}
    started_at = monotonic_ms()

    output.(progress_frame("tool_call_started", %{"tool_call_id" => tool_call_id, "name" => name}))

    {success?, tool_output} =
      case execute_tool(name, arguments, prepared, tool_call_id, output, frame) do
        {:ok, success?, result} -> {success?, result}
        {:error, reason} -> {false, error_output("tool_execution_failed", reason)}
      end

    duration_ms = max(monotonic_ms() - started_at, 0)

    result =
      tool_call_result_frame(
        Map.get(frame, "correlation_id"),
        tool_call_id,
        success?,
        tool_output,
        duration_ms
      )

    output.(result)
    {%{}, result}
  end

  def execute_frame(%{"type" => "cancel"} = frame, _prepared, output) when is_function(output, 1) do
    command_id = string_value(frame, "command_id") || string_value(frame, "tool_call_id")

    result =
      case ShellExecutor.cancel(command_id) do
        :ok -> progress_frame("cancelled", %{"command_id" => command_id})
        {:error, reason} -> error_frame(Map.get(frame, "correlation_id"), "cancel_failed", inspect(reason))
      end

    output.(result)
    {%{}, result}
  end

  def execute_frame(frame, _prepared, output) when is_function(output, 1) do
    result = error_frame(Map.get(frame, "correlation_id"), "unsupported_frame", "Unsupported executor frame")
    output.(result)
    {%{}, result}
  end

  defp handle_line("", _prepared, _output, running), do: running

  defp handle_line(line, prepared, output, running) do
    case Jason.decode(line) do
      {:ok, %{} = frame} ->
        dispatch_frame(frame, prepared, output, running)

      {:ok, _other} ->
        output.(error_frame(nil, "invalid_frame", "Frame must be a JSON object"))
        running

      {:error, error} ->
        output.(error_frame(nil, "invalid_json", Exception.message(error)))
        running
    end
  end

  defp dispatch_frame(%{"type" => "tool_execution_request"} = frame, prepared, output, running) do
    tool_call_id = string_value(frame, "tool_call_id") || "tool-call"

    task =
      Task.async(fn ->
        {_running, result} = execute_frame(frame, prepared, output)
        result
      end)

    Map.put(running, task.ref, %{task: task, correlation_id: Map.get(frame, "correlation_id"), tool_call_id: tool_call_id})
  end

  defp dispatch_frame(%{"type" => "cancel"} = frame, _prepared, output, running) do
    command_id = cancel_command_id(frame, running)

    result =
      case ShellExecutor.cancel(command_id) do
        :ok -> progress_frame("cancelled", %{"command_id" => command_id})
        {:error, reason} -> error_frame(Map.get(frame, "correlation_id"), "cancel_failed", inspect(reason))
      end

    output.(result)
    running
  end

  defp dispatch_frame(frame, _prepared, output, running) do
    output.(error_frame(Map.get(frame, "correlation_id"), "unsupported_frame", "Unsupported executor frame"))
    running
  end

  defp cancel_command_id(frame, running) do
    string_value(frame, "command_id") || string_value(frame, "tool_call_id") ||
      command_id_for_correlation(Map.get(frame, "correlation_id"), running)
  end

  defp command_id_for_correlation(correlation_id, running) when is_binary(correlation_id) and correlation_id != "" do
    running
    |> Map.values()
    |> Enum.find_value(fn
      %{correlation_id: ^correlation_id, tool_call_id: tool_call_id} -> tool_call_id
      _entry -> nil
    end)
  end

  defp command_id_for_correlation(_correlation_id, _running), do: nil

  defp await_running(running, output) when map_size(running) == 0 do
    output.(progress_frame("executor_complete", %{}))
    :ok
  end

  defp await_running(running, output) do
    running
    |> Map.values()
    |> Enum.map(& &1.task)
    |> Task.yield_many(:infinity)
    |> Enum.each(fn
      {_task, {:ok, _result}} ->
        :ok

      {task, nil} ->
        Task.shutdown(task, :brutal_kill)

      {_task, {:exit, reason}} ->
        output.(error_frame(nil, "tool_task_crashed", inspect(reason)))
    end)

    output.(progress_frame("executor_complete", %{}))
    :ok
  end

  defp execute_tool(name, arguments, prepared, tool_call_id, output, frame) when name in ["shell.exec", "apply_patch"] and is_map(arguments) do
    case PolicyGate.evaluate(%{type: :tool_call, target: name, data: arguments, session: policy_session(frame, prepared)}) do
      :allow -> execute_allowed_tool(name, arguments, prepared, tool_call_id, output)
      {:deny, reason} -> {:error, {:policy_denied, reason}}
      {:ask, reason} -> {:error, {:policy_ask, reason}}
    end
  end

  defp execute_tool(name, _arguments, _prepared, _tool_call_id, _output, _frame) do
    {:error, {:unsupported_tool, name}}
  end

  defp execute_allowed_tool("shell.exec", arguments, prepared, tool_call_id, output) do
    context = %{
      workspace_root: prepared.tool_workspace,
      env_allowlist: prepared.env_allowlist,
      on_event: fn event -> output.(progress_frame(to_string(event.event), stringify_keys(event.payload))) end
    }

    arguments = Map.put_new(arguments, "id", tool_call_id)

    case ShellExec.execute(arguments, context) do
      {:ok, %{output: result}} -> {:ok, result["success"] == true, result}
      {:error, reason} -> {:error, reason}
    end
  end

  defp execute_allowed_tool("apply_patch", arguments, prepared, _tool_call_id, output) do
    context = %{
      workspace_root: prepared.tool_workspace,
      on_event: fn event -> output.(progress_frame(to_string(event.event), stringify_keys(event.payload))) end
    }

    case ApplyPatch.execute(arguments, context) do
      {:ok, %{output: result}} -> {:ok, result["success"] == true, result}
      {:error, reason} -> {:error, reason}
    end
  end

  defp policy_session(frame, prepared) do
    context = Map.get(frame, "context") || %{}
    metadata = Map.get(frame, "metadata") || %{}

    %{
      workspace_id: Map.get(frame, "workspace_id") || Map.get(context, "workspace_id") || Map.get(metadata, "workspace_id"),
      session_thread_id: Map.get(frame, "session_thread_id") || Map.get(context, "session_thread_id") || Map.get(metadata, "session_thread_id"),
      session_id: Map.get(frame, "session_id") || Map.get(context, "session_id") || Map.get(metadata, "session_id"),
      policies: Map.get(frame, "policies") || Map.get(context, "policies") || Map.get(metadata, "policies") || [],
      metadata: metadata,
      workspace_root: prepared.tool_workspace
    }
  end

  defp ensure_policy_engine_started do
    case Process.whereis(SymphonyElixir.Policy.Engine) do
      nil ->
        case SymphonyElixir.Policy.Engine.start_link() do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          {:error, _reason} -> :ok
        end

      _pid ->
        :ok
    end
  end

  defp prepare_workspace_root(path) do
    expanded = Path.expand(path)

    with :ok <- File.mkdir_p(expanded),
         {:ok, canonical} <- PathSafety.canonicalize(expanded) do
      {:ok, canonical}
    else
      {:error, reason} -> {:error, error("workspace_prepare_failed", reason)}
    end
  end

  defp prepare_tool_workspace(request, workspace_root, opts) do
    cond do
      repository = repository_request(request) ->
        materialize_repository(repository, workspace_root, opts)

      existing = string_value(request, "existing_workspace") ->
        existing_tool_workspace(existing, workspace_root)

      true ->
        existing_tool_workspace(@default_repository_alias, workspace_root)
    end
  end

  defp materialize_repository(repository, workspace_root, opts) do
    resource = %{
      "alias" => string_value(repository, "alias") || @default_repository_alias,
      "url" => string_value(repository, "url") || string_value(repository, "locator") || string_value(repository, "repository_url"),
      "ref" => string_value(repository, "ref")
    }

    request = %{"resources" => [resource], "commands" => []}

    with {:ok, result} <- PublicRepository.run(request, Keyword.put(opts, :workspace_root, workspace_root)),
         [materialized | _] <- Map.get(result, "resources", []),
         {:ok, tool_workspace} <- PublicRepository.resource_path(workspace_root, materialized["alias"]) do
      {:ok, tool_workspace, materialized}
    else
      {:error, %{} = reason} -> {:error, reason}
      other -> {:error, error("repository_materialization_failed", other)}
    end
  end

  defp existing_tool_workspace(path, workspace_root) do
    expanded = Path.expand(path, workspace_root)

    with {:ok, canonical} <- PathSafety.canonicalize(expanded),
         :ok <- ensure_under_root(workspace_root, canonical),
         true <- File.dir?(canonical) do
      {:ok, canonical, nil}
    else
      {:error, reason} -> {:error, error("existing_workspace_denied", reason)}
      false -> {:error, error("existing_workspace_missing", expanded)}
    end
  end

  defp repository_request(request) do
    Map.get(request, "repository") || Map.get(request, :repository)
  end

  defp env_allowlist(request) do
    case Map.get(request, "env_allowlist") || Map.get(request, :env_allowlist) do
      values when is_list(values) -> Enum.filter(values, &is_binary/1)
      _ -> nil
    end
  end

  defp ensure_under_root(root, path) do
    root = Path.expand(root)
    path = Path.expand(path)

    if path == root or String.starts_with?(path, root <> "/") do
      :ok
    else
      {:error, {:path_outside_workspace, path, root}}
    end
  end

  defp progress_frame(event, payload) do
    %{
      "type" => "progress",
      "schema_version" => @schema_version,
      "event" => event,
      "payload" => payload
    }
  end

  defp tool_call_result_frame(correlation_id, tool_call_id, success?, output, duration_ms) do
    %{
      "type" => "tool_call_result",
      "schema_version" => @schema_version,
      "correlation_id" => correlation_id,
      "tool_call_id" => tool_call_id,
      "success" => success?,
      "output" => output,
      "duration_ms" => duration_ms
    }
    |> reject_nil_values()
  end

  defp error_frame(correlation_id, code, message) do
    %{
      "type" => "error",
      "schema_version" => @schema_version,
      "correlation_id" => correlation_id,
      "code" => code,
      "message" => message
    }
    |> reject_nil_values()
  end

  defp error_output(code, reason), do: %{"ok" => false, "error" => code, "reason" => inspect(reason)}

  defp error(code, detail), do: %{"code" => code, "detail" => inspect(detail)}

  defp string_value(map, key) when is_map(map) do
    value = Map.get(map, key) || Map.get(map, atom_key(key))

    if is_binary(value) do
      trimmed = String.trim(value)
      if trimmed == "", do: nil, else: trimmed
    end
  end

  defp string_value(_map, _key), do: nil

  defp atom_key("alias"), do: :alias
  defp atom_key("command_id"), do: :command_id
  defp atom_key("existing_workspace"), do: :existing_workspace
  defp atom_key("locator"), do: :locator
  defp atom_key("name"), do: :name
  defp atom_key("ref"), do: :ref
  defp atom_key("repository_url"), do: :repository_url
  defp atom_key("tool_call_id"), do: :tool_call_id
  defp atom_key("url"), do: :url
  defp atom_key("workspace_root"), do: :workspace_root
  defp atom_key(_key), do: nil

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), stringify_keys(value)} end)
  end

  defp stringify_keys(values) when is_list(values), do: Enum.map(values, &stringify_keys/1)
  defp stringify_keys(value), do: value

  defp reject_nil_values(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)

  defp monotonic_ms, do: System.monotonic_time(:millisecond)

  defp write_stdout(frame) do
    IO.puts(Jason.encode!(frame))
  end
end
