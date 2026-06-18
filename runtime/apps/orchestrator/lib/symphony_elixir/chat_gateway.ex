defmodule SymphonyElixir.ChatGateway do
  @moduledoc """
  Shared chat entrypoint for websocket and non-websocket callers.
  """

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixir.Launcher.ConfigRegistry
  alias SymphonyElixir.{MapUtils, MessageLog, RuntimeLog, ToolCallPersistence}
  alias SymphonyElixirWeb.Gateway.Middleware

  @default_timeout_ms 300_000

  @type post_result :: {:ok, String.t()} | {:error, term()}

  @spec scope_for(map()) :: map() | nil
  def scope_for(session) when is_map(session) do
    agent_id = string_field(session, :agent_id)
    workspace_id = string_field(session, :workspace_id)
    user_id = string_field(session, :user_id)
    session_key = string_field(session, :session_key)

    if is_binary(agent_id) and is_binary(workspace_id) and is_binary(session_key) do
      %{
        agent_id: agent_id,
        workspace_id: workspace_id,
        user_id: user_id,
        session_key: session_key
      }
    end
  end

  def scope_for(_session), do: nil

  @spec post_message(map() | nil, String.t(), keyword()) :: post_result()
  def post_message(scope, body, opts \\ []) when is_binary(body) and is_list(opts) do
    run_id = Keyword.get_lazy(opts, :run_id, &Ecto.UUID.generate/0)
    owner_pid = Keyword.get(opts, :owner_pid, self())
    metadata = Keyword.get(opts, :metadata, %{})
    await? = Keyword.get(opts, :await?, false)

    with {:ok, scope} <- require_scope(scope),
         {:ok, agent} <- fetch_agent(scope, opts),
         session_thread_id = session_thread_id(scope, agent, opts),
         :ok <- ensure_runtime_session(scope, agent),
         {:ok, %{run: run}} <- SessionStore.start_run(scope, run_id, owner_pid),
         :ok <- SessionStore.append_user_message(scope, body),
         :ok <- record_user_message(scope, session_thread_id, body, run_id, metadata, opts),
         runner_scope = runner_scope(scope, session_thread_id),
         {:ok, task_pid} <- start_and_attach_runner(agent, runner_scope, body, run_id, owner_pid, opts) do
      send(task_pid, {:gateway_start, run_id})

      if await? do
        await_runner(scope, session_thread_id, run.id, task_pid, new_buffer(opts), Keyword.get(opts, :timeout_ms, @default_timeout_ms))
      else
        {:ok, run.id}
      end
    else
      {:error, reason} ->
        {:error, reason}
    end
  end

  defp require_scope(%{agent_id: agent_id, workspace_id: workspace_id, session_key: session_key} = scope)
       when is_binary(agent_id) and is_binary(workspace_id) and is_binary(session_key) do
    {:ok, scope}
  end

  defp require_scope(_scope), do: {:error, :runtime_scope_required}

  defp fetch_agent(scope, opts) do
    case Keyword.get(opts, :agent) do
      nil -> Middleware.fetch_agent(scope.agent_id)
      agent -> {:ok, agent}
    end
  end

  defp runner_scope(scope, session_thread_id) when is_binary(session_thread_id) do
    Map.put(scope, :session_thread_id, session_thread_id)
  end

  defp runner_scope(scope, _session_thread_id), do: scope

  defp session_thread_id(scope, agent, opts) do
    case Keyword.get(opts, :session_thread_id) do
      session_thread_id when is_binary(session_thread_id) ->
        session_thread_id

      _ ->
        ensure_session_thread(scope, agent, opts)
    end
  end

  defp ensure_session_thread(scope, agent, opts) do
    ensure_runtime_session(scope, agent)

    case message_log().upsert_session_thread(scope,
           label: agent.name || scope.session_key,
           model: model_name(agent)
         ) do
      {:ok, session_thread_id} ->
        session_thread_id

      :disabled ->
        nil

      {:error, reason} ->
        log_message_persistence_failed(scope, reason, nil, Keyword.get(opts, :run_id), opts, "message_log.upsert_session_thread")
        nil
    end
  end

  defp ensure_runtime_session(scope, agent) do
    case SessionStore.ensure_session(scope,
           label: agent.name || scope.session_key,
           display_name: agent.name,
           model: model_name(agent)
         ) do
      {:ok, _session} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp record_user_message(_scope, nil, _body, _run_id, _metadata, _opts), do: :ok

  defp record_user_message(scope, session_thread_id, body, run_id, metadata, opts)
       when is_binary(session_thread_id) and is_map(metadata) do
    message_opts = maybe_put_metadata([run_id: run_id], metadata)

    case message_log().record_user_message(scope, session_thread_id, body, message_opts) do
      :ok ->
        :ok

      :disabled ->
        :ok

      {:error, reason} ->
        log_message_persistence_failed(scope, reason, session_thread_id, run_id, opts, "message_log.record_user_message")
        :ok
    end
  end

  defp record_assistant_message(_scope, nil, _content, _run_id, _metadata, _opts), do: :ok

  defp record_assistant_message(scope, session_thread_id, content, run_id, metadata, opts)
       when is_binary(session_thread_id) and is_map(metadata) do
    case message_log().record_assistant_message(scope, session_thread_id, content, run_id, metadata, tool_calls: Keyword.get(opts, :tool_calls, [])) do
      :ok ->
        :ok

      :disabled ->
        :ok

      {:error, reason} ->
        log_message_persistence_failed(scope, reason, session_thread_id, run_id, opts, "message_log.record_assistant_message")
        :ok
    end
  end

  defp maybe_put_metadata(opts, metadata) when map_size(metadata) == 0, do: opts
  defp maybe_put_metadata(opts, metadata), do: Keyword.put(opts, :metadata, metadata)

  defp log_message_persistence_failed(scope, reason, session_thread_id, run_id, opts, operation) do
    RuntimeLog.log(
      :warning,
      :gateway_message_persistence_failed,
      RuntimeLog.scope_fields(scope)
      |> Map.merge(%{
        trace_id: Keyword.get(opts, :trace_id),
        connection_id: Keyword.get(opts, :connection_id),
        session_thread_id: session_thread_id,
        run_id: run_id,
        operation: operation,
        error_code: "message_persistence_failed",
        non_fatal: true,
        reason: inspect(reason),
        retryable: retryable_persistence_failure?(reason)
      })
      |> MapUtils.drop_nil_values()
    )
  end

  defp retryable_persistence_failure?({:http_error, 429, _body}), do: true
  defp retryable_persistence_failure?({:http_error, status, _body}) when status >= 500, do: true
  defp retryable_persistence_failure?({:request_failed, _reason}), do: true
  defp retryable_persistence_failure?(_reason), do: false

  defp message_log do
    Application.get_env(:symphony_elixir, :message_log_adapter, MessageLog)
  end

  defp start_and_attach_runner(agent, scope, body, run_id, owner_pid, opts) do
    case start_runner(
           agent,
           scope,
           body,
           run_id,
           owner_pid,
           Keyword.get(opts, :workflow_path),
           Keyword.get(opts, :trace_id)
         ) do
      {:ok, task_pid} ->
        case SessionStore.attach_run(run_id, task_pid) do
          {:ok, _attached_run} ->
            {:ok, task_pid}

          {:error, reason} ->
            SessionStore.fail_run(run_id)
            {:error, reason}
        end

      {:error, reason} ->
        SessionStore.fail_run(run_id)
        {:error, reason}
    end
  end

  defp start_runner(agent, scope, prompt, run_id, owner_pid, workflow_path, trace_id) do
    runner =
      Application.get_env(
        :symphony_elixir,
        :gateway_chat_runner,
        SymphonyElixir.Gateway.ChatRunner
      )

    Task.Supervisor.start_child(SymphonyElixir.TaskSupervisor, fn ->
      if is_binary(workflow_path) do
        ConfigRegistry.put(self(), workflow_path)
      end

      if is_binary(trace_id) do
        Process.put(:symphony_trace_id, trace_id)
      end

      try do
        receive do
          {:gateway_start, ^run_id} ->
            runner.run(agent, scope, prompt, run_id, owner_pid)
        end
      after
        Process.delete(:symphony_trace_id)

        if is_binary(workflow_path) do
          ConfigRegistry.delete(self())
        end
      end
    end)
  end

  defp await_runner(scope, session_thread_id, run_id, task_pid, buffer, timeout_ms) do
    receive do
      {:gateway_runner_event, _session_key, ^run_id, message} ->
        maybe_append_delta(run_id, message)
        await_runner(scope, session_thread_id, run_id, task_pid, apply_event(buffer, message), timeout_ms)

      {:gateway_runner_complete, _session_key, ^run_id, :ok} ->
        complete_run(scope, session_thread_id, run_id, buffer, [])

      {:gateway_runner_complete, _session_key, ^run_id, {:ok, result}} ->
        complete_run(scope, session_thread_id, run_id, buffer,
          assistant_fallback: Map.get(result, "output_text"),
          model: Map.get(result, "model"),
          provider: Map.get(result, "provider"),
          usage: Map.get(result, "usage") || %{},
          response_id: Map.get(result, "response_id")
        )

      {:gateway_runner_failed, _session_key, ^run_id, reason} ->
        fail_run(scope, session_thread_id, run_id, reason, buffer)

      {:gateway_runner_down, _session_key, ^run_id, reason} ->
        fail_run(scope, session_thread_id, run_id, reason, buffer)
    after
      timeout_ms ->
        stop_runner_task(task_pid)
        fail_run(scope, session_thread_id, run_id, :gateway_runner_timeout, buffer)
    end
  end

  defp stop_runner_task(task_pid) when is_pid(task_pid) do
    if Process.alive?(task_pid) do
      Process.exit(task_pid, :kill)
    end

    :ok
  end

  defp complete_run(scope, session_thread_id, run_id, buffer, opts) do
    case SessionStore.complete_run(run_id, opts) do
      {:ok, nil} ->
        {:ok, run_id}

      {:ok, session} ->
        metadata =
          assistant_metadata(buffer, opts)
          |> Map.merge(Keyword.get(buffer.opts, :assistant_metadata, %{}))
          |> MapUtils.drop_nil_values()

        :ok =
          record_assistant_message(
            scope,
            session_thread_id,
            latest_assistant_content(session),
            run_id,
            metadata,
            Keyword.put(buffer.opts, :tool_calls, ToolCallPersistence.completed(buffer.tool_call_acc))
          )

        # Learning sidecar: best-effort enqueue of a reflection job. Runs
        # AFTER record_assistant_message so the platform reflector sees
        # the persisted transcript. Best-effort by contract — never
        # propagates an error.
        :ok =
          SymphonyElixir.Learning.ReflectionDispatcher.maybe_enqueue(
            scope,
            run_id,
            source_work_item_id: assistant_source_work_item_id(buffer.opts, opts)
          )

        {:ok, run_id}
    end
  end

  defp assistant_source_work_item_id(buffer_opts, opts) do
    Keyword.get(opts, :source_work_item_id) ||
      Keyword.get(buffer_opts, :source_work_item_id) ||
      get_in(Keyword.get(buffer_opts, :assistant_metadata, %{}), ["source_work_item_id"])
  end

  defp fail_run(scope, session_thread_id, run_id, reason, buffer) do
    {:ok, _session} = SessionStore.fail_run(run_id)
    message = Middleware.error_message(reason)

    metadata =
      %{
        "kind" => "error",
        "error" => %{
          "kind" => error_kind(reason),
          "message" => inspect(reason),
          "retryable" => retryable_error?(reason)
        },
        "tool_calls" => Enum.reverse(buffer.tool_calls),
        "work_item_ids" => Keyword.get(buffer.opts, :work_item_ids),
        "runner_kind" => "manager"
      }
      |> Map.merge(Keyword.get(buffer.opts, :assistant_metadata, %{}))
      |> MapUtils.drop_nil_values()

    _ =
      record_assistant_message(
        scope,
        session_thread_id,
        message,
        run_id,
        metadata,
        Keyword.put(buffer.opts, :tool_calls, ToolCallPersistence.completed(buffer.tool_call_acc))
      )

    {:error, reason}
  end

  defp new_buffer(opts) do
    %{
      opts: opts,
      tool_calls: [],
      tool_call_acc: ToolCallPersistence.empty(),
      usage: nil,
      response_id: nil
    }
  end

  defp apply_event(buffer, %{event: event} = message)
       when event in [:tool_call_started, :tool_call_completed, :tool_call_failed] do
    acc = ToolCallPersistence.apply_event(buffer.tool_call_acc, message)

    %{
      buffer
      | tool_call_acc: acc,
        tool_calls: Enum.map(ToolCallPersistence.completed(acc), &ToolCallPersistence.summary/1)
    }
  end

  defp apply_event(buffer, %{event: :turn_completed, payload: payload}) when is_map(payload) do
    %{buffer | usage: Map.get(payload, "usage"), response_id: Map.get(payload, "id")}
  end

  defp apply_event(buffer, _event), do: buffer

  defp maybe_append_delta(run_id, %{event: :notification, payload: payload}) when is_map(payload) do
    case get_in(payload, ["params", "textDelta"]) do
      delta when is_binary(delta) -> SessionStore.append_delta(run_id, delta)
      _ -> :ok
    end
  end

  defp maybe_append_delta(_run_id, _message), do: :ok

  defp assistant_metadata(buffer, opts) do
    %{
      "kind" => "assistant_turn",
      "work_item_ids" => Keyword.get(buffer.opts, :work_item_ids),
      "tool_calls" => Enum.reverse(buffer.tool_calls),
      "usage" => buffer.usage || Keyword.get(opts, :usage),
      "response_id" => buffer.response_id || Keyword.get(opts, :response_id),
      "provider" => Keyword.get(opts, :provider),
      "model" => Keyword.get(opts, :model),
      "runner_kind" => "manager"
    }
  end

  defp latest_assistant_content(session) do
    session.messages
    |> Enum.find(&(Map.get(&1, "role") == "assistant"))
    |> case do
      %{"content" => content} -> content
      _ -> ""
    end
  end

  defp error_kind({:retryable, _reason}), do: "retryable"
  defp error_kind({:fatal, _reason}), do: "fatal"
  defp error_kind({:exception, _module, _message}), do: "exception"
  defp error_kind(_reason), do: "unknown"

  defp retryable_error?({:retryable, _reason}), do: true
  defp retryable_error?(_reason), do: false

  defp model_name(agent) do
    model_settings = Map.get(agent, :model_settings) || Map.get(agent, "model_settings") || %{}
    Map.get(model_settings, "model") || Map.get(model_settings, :model)
  end

  defp string_field(map, key) do
    case Map.get(map, key) || Map.get(map, Atom.to_string(key)) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end
end
