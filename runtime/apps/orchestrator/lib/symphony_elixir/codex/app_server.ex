defmodule SymphonyElixir.Codex.AppServer do
  @moduledoc """
  Minimal client for the Codex app-server JSON-RPC 2.0 stream over stdio.
  """

  require Logger
  alias SymphonyElixir.{Codex.DynamicTool, Codex.PortProtocol, Codex.TurnEventDispatcher, Codex.WorkspaceSecurity, Config, RuntimeLog, SSH, ToolRegistry}
  alias SymphonyElixir.Runner.Observability

  @initialize_id 1
  @thread_start_id 2
  @turn_start_id 3
  @port_line_bytes 1_048_576

  @type session :: %{
          port: port(),
          metadata: map(),
          approval_policy: String.t() | map(),
          auto_approve_requests: boolean(),
          dynamic_tool_names: [String.t()],
          model: String.t() | nil,
          model_provider: String.t() | nil,
          thread_sandbox: String.t(),
          turn_sandbox_policy: map(),
          thread_id: String.t(),
          trace_id: String.t() | nil,
          workspace: Path.t(),
          worker_host: String.t() | nil
        }

  @spec run(Path.t(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run(workspace, prompt, issue, opts \\ []) do
    with {:ok, session} <- start_session(workspace, opts) do
      try do
        run_turn(session, prompt, issue, opts)
      after
        stop_session(session)
      end
    end
  end

  @spec start_session(Path.t(), keyword()) :: {:ok, session()} | {:error, term()}
  def start_session(workspace, opts \\ []) do
    worker_host = Keyword.get(opts, :worker_host)
    runner_config = normalize_runner_config(Keyword.get(opts, :runner_config, %{}))

    with {:ok, expanded_workspace} <- WorkspaceSecurity.validate_cwd(workspace, worker_host),
         {:ok, port} <- start_port(expanded_workspace, worker_host, runner_config) do
      metadata = port_metadata(port, worker_host)
      trace_id = Keyword.get(opts, :trace_id) || config_value(runner_config, :trace_id) || Process.get(:symphony_trace_id)

      with {:ok, session_policies} <- session_policies(expanded_workspace, worker_host, runner_config),
           {:ok, thread_id} <- do_start_session(port, expanded_workspace, session_policies) do
        {:ok,
         %{
           port: port,
           metadata: metadata,
           approval_policy: session_policies.approval_policy,
           agent_id: config_value(runner_config, :agent_id),
           workspace_id: config_value(runner_config, :workspace_id),
           auto_approve_requests: session_policies.approval_policy == "never",
           dynamic_tool_names: session_policies.dynamic_tool_names,
           model: session_policies.model,
           model_provider: session_policies.model_provider,
           thread_sandbox: session_policies.thread_sandbox,
           turn_sandbox_policy: session_policies.turn_sandbox_policy,
           thread_id: thread_id,
           trace_id: trace_id,
           workspace: expanded_workspace,
           worker_host: worker_host
         }}
      else
        {:error, reason} ->
          stop_port(port)
          {:error, reason}
      end
    end
  end

  @spec run_turn(session(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run_turn(
        session = %{
          port: port,
          metadata: metadata,
          approval_policy: approval_policy,
          auto_approve_requests: auto_approve_requests,
          dynamic_tool_names: dynamic_tool_names,
          turn_sandbox_policy: turn_sandbox_policy,
          thread_id: thread_id,
          trace_id: trace_id,
          workspace: workspace
        },
        prompt,
        issue,
        opts \\ []
      ) do
    on_message = Keyword.get(opts, :on_message, &default_on_message/1)
    model = Map.get(session, :model)
    model_provider = Map.get(session, :model_provider)

    tool_executor =
      Keyword.get(opts, :tool_executor, fn tool, arguments ->
        tool_opts = [
          allowed_tools: dynamic_tool_names,
          workspace: workspace,
          agent_id: Map.get(session, :agent_id),
          default_repository: config_value(Keyword.get(opts, :runner_config, %{}), :default_repository),
          default_runner_kind: config_value(Keyword.get(opts, :runner_config, %{}), :default_runner_kind),
          workspace_id: Map.get(session, :workspace_id)
        ]

        if use_tool_registry?() do
          ToolRegistry.execute_dynamic_response(tool, arguments, tool_opts)
        else
          DynamicTool.execute(tool, arguments, tool_opts)
        end
      end)

    case start_turn(port, thread_id, prompt, issue, workspace, approval_policy, turn_sandbox_policy, model, model_provider) do
      {:ok, turn_id} ->
        started_at = System.monotonic_time(:millisecond)
        session_id = "#{thread_id}-#{turn_id}"
        log_fields = codex_log_fields(issue, metadata, trace_id, session_id, thread_id, turn_id)
        Logger.info("Codex session started for #{issue_context(issue)} session_id=#{session_id}")
        RuntimeLog.log(:info, :turn_started, log_fields)
        provider_context = codex_provider_context(session, issue, metadata, trace_id, session_id, thread_id, turn_id)
        Observability.log_model_call_started(provider_context)

        emit_message(
          on_message,
          :session_started,
          %{
            session_id: session_id,
            thread_id: thread_id,
            turn_id: turn_id
          },
          metadata
        )

        Process.put(:symphony_runtime_log_context, log_fields)

        turn_result =
          try do
            await_turn_completion(port, on_message, tool_executor, auto_approve_requests)
          after
            Process.delete(:symphony_runtime_log_context)
          end

        case turn_result do
          {:ok, result} ->
            Logger.info("Codex session completed for #{issue_context(issue)} session_id=#{session_id}")
            Observability.log_model_call_completed(provider_context, elapsed_ms(started_at))
            RuntimeLog.log(:info, :turn_completed, log_fields)

            {:ok,
             %{
               result: result,
               session_id: session_id,
               thread_id: thread_id,
               turn_id: turn_id
             }}

          {:error, reason} ->
            Logger.warning("Codex session ended with error for #{issue_context(issue)} session_id=#{session_id}: #{inspect(reason)}")

            reason
            |> Observability.provider_error_failure(provider_context, elapsed_ms(started_at))
            |> Observability.log_provider_failure()

            RuntimeLog.log(:error, :turn_failed, Map.put(log_fields, :reason, inspect(reason)))

            emit_message(
              on_message,
              :turn_ended_with_error,
              %{
                session_id: session_id,
                reason: reason
              },
              metadata
            )

            {:error, reason}
        end

      {:error, reason} ->
        Logger.error("Codex session failed for #{issue_context(issue)}: #{inspect(reason)}")
        RuntimeLog.log(:error, :turn_failed, codex_log_fields(issue, %{}, trace_id, nil, thread_id, nil) |> Map.put(:reason, inspect(reason)))
        emit_message(on_message, :startup_failed, %{reason: reason}, metadata)
        {:error, reason}
    end
  end

  @spec send_message(session(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def send_message(session, prompt, issue, opts \\ []) do
    run_turn(session, prompt, issue, opts)
  end

  @spec interrupt_turn(session(), String.t()) :: :ok | {:error, term()}
  def interrupt_turn(%{port: port, thread_id: thread_id}, turn_id)
      when is_port(port) and is_binary(thread_id) and is_binary(turn_id) and turn_id != "" do
    case PortProtocol.send_message(port, %{
           "method" => "turn/interrupt",
           "params" => %{
             "threadId" => thread_id,
             "turnId" => turn_id
           }
         }) do
      true -> :ok
      false -> {:error, :port_closed}
    end
  end

  def interrupt_turn(_session, _turn_id), do: {:error, :invalid_turn}

  @spec stop_session(session()) :: :ok
  def stop_session(%{port: port}) when is_port(port) do
    stop_port(port)
  end

  defp start_port(workspace, nil, runner_config) do
    executable = System.find_executable("bash")

    if is_nil(executable) do
      {:error, :bash_not_found}
    else
      command = codex_command(runner_config)

      port =
        Port.open(
          {:spawn_executable, String.to_charlist(executable)},
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [~c"-lc", String.to_charlist(command)],
            cd: String.to_charlist(workspace),
            line: @port_line_bytes
          ]
        )

      {:ok, port}
    end
  end

  defp start_port(workspace, worker_host, runner_config) when is_binary(worker_host) do
    remote_command = remote_launch_command(workspace, runner_config)
    SSH.start_port(worker_host, remote_command, line: @port_line_bytes)
  end

  defp remote_launch_command(workspace, runner_config) when is_binary(workspace) do
    [
      "cd #{shell_escape(workspace)}",
      "exec #{codex_command(runner_config)}"
    ]
    |> Enum.join(" && ")
  end

  defp port_metadata(port, worker_host) when is_port(port) do
    base_metadata =
      case :erlang.port_info(port, :os_pid) do
        {:os_pid, os_pid} ->
          %{codex_app_server_pid: to_string(os_pid)}

        _ ->
          %{}
      end

    case worker_host do
      host when is_binary(host) -> Map.put(base_metadata, :worker_host, host)
      _ -> base_metadata
    end
  end

  defp send_initialize(port) do
    payload = %{
      "method" => "initialize",
      "id" => @initialize_id,
      "params" => %{
        "capabilities" => %{
          "experimentalApi" => true
        },
        "clientInfo" => %{
          "name" => "symphony-orchestrator",
          "title" => "Symphony Orchestrator",
          "version" => "0.1.0"
        }
      }
    }

    PortProtocol.send_message(port, payload)

    with {:ok, _} <- await_response(port, @initialize_id) do
      PortProtocol.send_message(port, %{"method" => "initialized", "params" => %{}})
      :ok
    end
  end

  defp session_policies(workspace, nil, runner_config) do
    with {:ok, policies} <- Config.codex_runtime_settings(workspace) do
      {:ok, merge_runner_policies(policies, runner_config)}
    end
  end

  defp session_policies(workspace, worker_host, runner_config) when is_binary(worker_host) do
    with {:ok, policies} <- Config.codex_runtime_settings(workspace, remote: true) do
      {:ok, merge_runner_policies(policies, runner_config)}
    end
  end

  defp do_start_session(port, workspace, session_policies) do
    case send_initialize(port) do
      :ok -> start_thread(port, workspace, session_policies)
      {:error, reason} -> {:error, reason}
    end
  end

  defp start_thread(
         port,
         workspace,
         %{
           approval_policy: approval_policy,
           dynamic_tool_specs: dynamic_tool_specs,
           thread_sandbox: thread_sandbox
         } = session_policies
       ) do
    PortProtocol.send_message(port, %{
      "method" => "thread/start",
      "id" => @thread_start_id,
      "params" =>
        %{
          "approvalPolicy" => approval_policy,
          "sandbox" => thread_sandbox,
          "cwd" => workspace,
          "dynamicTools" => dynamic_tool_specs
        }
        |> maybe_put_param("model", Map.get(session_policies, :model))
        |> maybe_put_param("modelProvider", Map.get(session_policies, :model_provider))
    })

    case await_response(port, @thread_start_id) do
      {:ok, %{"thread" => thread_payload}} ->
        case thread_payload do
          %{"id" => thread_id} -> {:ok, thread_id}
          _ -> {:error, {:invalid_thread_payload, thread_payload}}
        end

      other ->
        other
    end
  end

  defp start_turn(port, thread_id, prompt, issue, workspace, approval_policy, turn_sandbox_policy, model, model_provider) do
    PortProtocol.send_message(port, %{
      "method" => "turn/start",
      "id" => @turn_start_id,
      "params" =>
        %{
          "threadId" => thread_id,
          "input" => [
            %{
              "type" => "text",
              "text" => prompt
            }
          ],
          "cwd" => workspace,
          "title" => "#{issue.identifier}: #{issue.title}",
          "approvalPolicy" => approval_policy,
          "sandboxPolicy" => turn_sandbox_policy
        }
        |> maybe_put_param("model", model)
        |> maybe_put_param("modelProvider", model_provider)
    })

    case await_response(port, @turn_start_id) do
      {:ok, %{"turn" => %{"id" => turn_id}}} -> {:ok, turn_id}
      other -> other
    end
  end

  defp maybe_put_param(map, _key, value) when value in [nil, ""], do: map
  defp maybe_put_param(map, key, value), do: Map.put(map, key, value)

  defp await_turn_completion(port, on_message, tool_executor, auto_approve_requests) do
    ctx = %{
      port: port,
      on_message: on_message,
      tool_executor: tool_executor,
      auto_approve_requests: auto_approve_requests,
      metadata_from_message: &metadata_from_message/2
    }

    PortProtocol.await_turn(port, Config.settings!().codex.turn_timeout_ms, fn line ->
      TurnEventDispatcher.handle_line(line, ctx)
    end)
  end

  defp await_response(port, request_id) do
    PortProtocol.await_response(port, request_id, Config.settings!().codex.read_timeout_ms)
  end

  defp issue_context(%{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end

  defp codex_log_fields(issue, metadata, trace_id, session_id, thread_id, turn_id) do
    metadata
    |> Map.take([:codex_app_server_pid, :worker_host])
    |> Map.merge(%{
      trace_id: RuntimeLog.ensure_trace_id(trace_id),
      run_id: session_id || thread_id,
      turn_id: turn_id,
      session_key: session_id,
      issue_id: Map.get(issue, :id) || Map.get(issue, "id"),
      issue_identifier: Map.get(issue, :identifier) || Map.get(issue, "identifier")
    })
  end

  defp codex_provider_context(session, issue, _metadata, trace_id, session_id, thread_id, turn_id) do
    %{
      provider: Map.get(session, :model_provider) || "openai_codex",
      model: Map.get(session, :model),
      runner_kind: "codex",
      trace_id: RuntimeLog.ensure_trace_id(trace_id),
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      session_key: session_id,
      run_id: Map.get(issue, :id) || Map.get(issue, "id"),
      turn_id: turn_id || thread_id,
      attempt: 1
    }
  end

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp normalize_runner_config(config) when is_map(config), do: config

  defp normalize_runner_config(_config), do: %{}

  defp codex_command(runner_config) do
    case config_value(runner_config, :command) do
      command when is_binary(command) and command != "" -> command
      _ -> Config.settings!().codex.command
    end
  end

  defp merge_runner_policies(policies, runner_config) do
    policies
    |> maybe_put_policy(:model, config_value(runner_config, :model))
    |> maybe_put_policy(:model_provider, config_value(runner_config, :model_provider) || config_value(runner_config, :provider))
  end

  defp maybe_put_policy(policies, _key, value) when value in [nil, ""], do: policies
  defp maybe_put_policy(policies, key, value), do: Map.put(policies, key, value)

  defp config_value(config, key) when is_atom(key) do
    Map.get(config, key) || Map.get(config, Atom.to_string(key))
  end

  defp stop_port(port) when is_port(port) do
    case :erlang.port_info(port) do
      :undefined ->
        :ok

      _ ->
        try do
          Port.close(port)
          :ok
        rescue
          ArgumentError ->
            :ok
        end
    end
  end

  defp emit_message(on_message, event, details, metadata) when is_function(on_message, 1) do
    message = metadata |> Map.merge(details) |> Map.put(:event, event) |> Map.put(:timestamp, DateTime.utc_now())
    on_message.(message)
  end

  defp use_tool_registry?, do: System.get_env("USE_TOOL_REGISTRY", "1") != "0"

  defp metadata_from_message(port, payload) do
    port
    |> port_metadata(nil)
    |> Map.merge(Process.get(:symphony_runtime_log_context, %{}))
    |> maybe_set_usage(payload)
  end

  defp maybe_set_usage(metadata, payload) when is_map(payload) do
    usage = Map.get(payload, "usage") || Map.get(payload, :usage)

    if is_map(usage) do
      Map.put(metadata, :usage, usage)
    else
      metadata
    end
  end

  defp maybe_set_usage(metadata, _payload), do: metadata

  defp shell_escape(value) when is_binary(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end

  defp default_on_message(_message), do: :ok
end
