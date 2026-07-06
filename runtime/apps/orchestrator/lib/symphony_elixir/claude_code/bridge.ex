defmodule SymphonyElixir.ClaudeCode.Bridge do
  @moduledoc """
  JSON-lines client for the Claude Agent SDK bridge process.

  The bridge protocol is intentionally small and provider-owned. The runner
  sends session and turn requests; the bridge streams events and returns a
  request response when the operation has reached a terminal state.
  """

  alias SymphonyElixir.SSH

  @line_bytes 1_048_576
  @default_timeout_ms 300_000

  @type session :: %{
          port: port(),
          cwd: String.t(),
          metadata: map(),
          options: map(),
          session_id: String.t() | nil,
          worker_host: String.t() | nil
        }

  @spec start_session(String.t(), map()) :: {:ok, session()} | {:error, term()}
  def start_session(cwd, options) when is_binary(cwd) and is_map(options) do
    with {:ok, port} <- start_port(cwd, options),
         {:ok, result} <- request(port, "session/start", session_start_params(cwd, options), options) do
      {:ok,
       %{
         port: port,
         cwd: cwd,
         metadata: port_metadata(port, options),
         options: options,
         session_id: Map.get(result, "sessionId"),
         worker_host: string_option(options, "worker_host")
       }}
    else
      {:error, _reason} = error ->
        if port = Process.get(:claude_code_starting_port), do: stop(port)
        Process.delete(:claude_code_starting_port)
        error

      other ->
        other
    end
  end

  @spec run_turn(session(), String.t(), map(), (map() -> term())) :: {:ok, map()} | {:error, term()}
  def run_turn(%{port: port, options: options} = session, prompt, work_item, on_event)
      when is_binary(prompt) and is_function(on_event, 1) do
    params =
      %{
        "prompt" => prompt,
        "sessionId" => Map.get(session, :session_id),
        "workItem" => work_item_payload(work_item)
      }
      |> reject_blank_values()

    request(port, "turn/start", params, options, on_event)
  end

  @spec interrupt(session() | port(), keyword()) :: :ok | {:error, term()}
  def interrupt(%{port: port}, opts) when is_port(port), do: interrupt(port, opts)

  def interrupt(port, _opts) when is_port(port) do
    id = next_id()
    payload = %{"id" => id, "method" => "turn/interrupt", "params" => %{}}
    send_json(port, payload)
  end

  @spec stop(session() | port()) :: :ok
  def stop(%{port: port, options: options}) when is_port(port) do
    _ = request(port, "session/stop", %{}, options)
    stop(port)
  end

  def stop(port) when is_port(port) do
    if Port.info(port), do: Port.close(port)
    :ok
  rescue
    ArgumentError -> :ok
  catch
    :exit, _reason -> :ok
  end

  defp start_port(cwd, options) do
    case string_option(options, "worker_host") do
      nil -> start_local_port(cwd, options)
      worker_host -> start_remote_port(cwd, worker_host, options)
    end
  end

  defp start_local_port(cwd, options) do
    executable = System.find_executable("bash")

    if executable do
      command = bridge_command(options)

      port =
        Port.open(
          {:spawn_executable, String.to_charlist(executable)},
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [~c"-lc", String.to_charlist(command)],
            cd: String.to_charlist(cwd),
            line: @line_bytes
          ]
        )

      Process.put(:claude_code_starting_port, port)
      {:ok, port}
    else
      {:error, :bash_not_found}
    end
  end

  defp start_remote_port(cwd, worker_host, options) do
    command = "cd #{shell_escape(cwd)} && exec #{bridge_command(options)}"

    with {:ok, port} <- SSH.start_port(worker_host, command, line: @line_bytes) do
      Process.put(:claude_code_starting_port, port)
      {:ok, port}
    end
  end

  defp request(port, method, params, options, on_event \\ fn _event -> :ok end) do
    id = next_id()
    payload = %{"id" => id, "method" => method, "params" => params}

    with :ok <- send_json(port, payload) do
      await_response(port, id, request_timeout(options), on_event)
    end
  end

  defp send_json(port, payload) do
    case Jason.encode(payload) do
      {:ok, encoded} ->
        Port.command(port, encoded <> "\n")
        :ok

      {:error, reason} ->
        {:error, {:json_encode_failed, reason}}
    end
  catch
    :exit, reason -> {:error, {:bridge_closed, reason}}
  end

  defp await_response(port, id, timeout_ms, on_event) do
    receive do
      {^port, {:data, {:eol, line}}} ->
        handle_line(port, id, to_string(line), timeout_ms, on_event, "")

      {^port, {:data, {:noeol, line}}} ->
        await_response(port, id, timeout_ms, on_event, to_string(line))

      {^port, {:data, line}} ->
        handle_line(port, id, to_string(line), timeout_ms, on_event, "")

      {^port, {:exit_status, status}} ->
        {:error, {:bridge_exit, status}}
    after
      timeout_ms ->
        {:error, {:bridge_timeout, id}}
    end
  end

  defp await_response(port, id, timeout_ms, on_event, buffer) do
    receive do
      {^port, {:data, {:eol, line}}} ->
        handle_line(port, id, buffer <> to_string(line), timeout_ms, on_event, "")

      {^port, {:data, {:noeol, line}}} ->
        await_response(port, id, timeout_ms, on_event, buffer <> to_string(line))

      {^port, {:data, line}} ->
        handle_line(port, id, buffer <> to_string(line), timeout_ms, on_event, "")

      {^port, {:exit_status, status}} ->
        {:error, {:bridge_exit, status}}
    after
      timeout_ms ->
        {:error, {:bridge_timeout, id}}
    end
  end

  defp handle_line(port, id, line, timeout_ms, on_event, buffer) do
    line = String.trim(line)

    cond do
      line == "" ->
        await_response(port, id, timeout_ms, on_event, buffer)

      true ->
        case Jason.decode(line) do
          {:ok, %{"id" => ^id, "result" => result}} ->
            Process.delete(:claude_code_starting_port)
            {:ok, result}

          {:ok, %{"id" => ^id, "error" => error}} ->
            Process.delete(:claude_code_starting_port)
            {:error, normalize_error(error)}

          {:ok, %{"id" => request_id, "method" => "permission/can_use_tool"} = event} ->
            respond_to_permission_request(port, request_id, event, on_event)
            await_response(port, id, timeout_ms, on_event, buffer)

          {:ok, %{"method" => _method} = event} ->
            on_event.(event)
            await_response(port, id, timeout_ms, on_event, buffer)

          {:ok, decoded} ->
            on_event.(%{"method" => "bridge/unknown", "params" => %{"payload" => decoded}})
            await_response(port, id, timeout_ms, on_event, buffer)

          {:error, _reason} ->
            on_event.(%{"method" => "bridge/stderr", "params" => %{"line" => line}})
            await_response(port, id, timeout_ms, on_event, buffer)
        end
    end
  end

  defp bridge_command(options) do
    string_option(options, "bridge_command") ||
      "node #{shell_escape(default_bridge_path())}"
  end

  defp default_bridge_path do
    :code.priv_dir(:symphony_elixir)
    |> Path.join("claude_agent_bridge/bridge.js")
  end

  defp session_start_params(cwd, options) do
    %{
      "cwd" => cwd,
      "model" => string_option(options, "model"),
      "permissionMode" => string_option(options, "permission_mode") || "acceptEdits",
      "tools" => list_option(options, "tools"),
      "allowedTools" => list_option(options, "allowed_tools"),
      "disallowedTools" => list_option(options, "disallowed_tools"),
      "maxTurns" => integer_option(options, "max_turns")
    }
    |> reject_blank_values()
  end

  defp work_item_payload(%{id: id, identifier: identifier, title: title, metadata: metadata}) do
    %{
      "id" => id,
      "identifier" => identifier,
      "title" => title,
      "metadata" => metadata || %{}
    }
    |> reject_blank_values()
  end

  defp work_item_payload(work_item) when is_map(work_item), do: work_item
  defp work_item_payload(_work_item), do: %{}

  defp port_metadata(port, options) do
    base =
      case :erlang.port_info(port, :os_pid) do
        {:os_pid, os_pid} -> %{claude_code_bridge_pid: to_string(os_pid)}
        _ -> %{}
      end

    case string_option(options, "worker_host") do
      nil -> base
      worker_host -> Map.put(base, :worker_host, worker_host)
    end
  end

  defp normalize_error(%{"retryable" => true, "reason" => reason}), do: {:retryable, reason}
  defp normalize_error(%{"retryable" => false, "reason" => reason}), do: {:fatal, reason}
  defp normalize_error(%{"message" => message}), do: {:fatal, message}
  defp normalize_error(error), do: {:fatal, error}

  defp respond_to_permission_request(port, request_id, event, on_event) do
    decision =
      case on_event.(event) do
        {:ok, response} when is_map(response) -> response
        {:ok, response} when is_list(response) -> Map.new(response)
        response when is_map(response) -> response
        response when is_list(response) -> Map.new(response)
        _response -> %{"behavior" => "deny", "message" => "No Claude Code permission handler configured"}
      end
      |> normalize_permission_decision()

    send_json(port, %{"id" => request_id, "result" => decision})
  end

  defp normalize_permission_decision(decision) do
    decision = stringify_keys(decision)

    case Map.get(decision, "behavior") do
      "deny" ->
        %{
          "behavior" => "deny",
          "message" => Map.get(decision, "message") || "Denied by host"
        }
        |> reject_blank_values()

      _ ->
        %{
          "behavior" => "allow",
          "updatedInput" => Map.get(decision, "updatedInput") || Map.get(decision, "updated_input"),
          "updatedPermissions" => Map.get(decision, "updatedPermissions") || Map.get(decision, "updated_permissions")
        }
        |> reject_blank_values()
    end
  end

  defp next_id, do: System.unique_integer([:positive]) |> Integer.to_string()

  defp request_timeout(options) do
    integer_option(options, "timeout_ms") ||
      integer_option(options, "turn_timeout_ms") ||
      @default_timeout_ms
  end

  defp reject_blank_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> value in [nil, "", []] end)
    |> Map.new()
  end

  defp string_option(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: nil, else: value

      _ ->
        nil
    end
  end

  defp list_option(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      values when is_list(values) -> values
      _ -> nil
    end
  end

  defp integer_option(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_integer(value) and value > 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer > 0 -> integer
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp stringify_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), value}
      {key, value} -> {key, value}
    end)
  end

  defp shell_escape(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end
end
