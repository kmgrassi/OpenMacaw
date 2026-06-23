defmodule SymphonyElixir.Planner.ModelClient.OpenAIResponses do
  @moduledoc """
  Planner runner backed by OpenAI's Responses API.

  This runner is intentionally separate from the Codex app-server path. It does
  not start a workspace process and exposes only the resolved planner dynamic
  tools, so planning agents can create/read plans and tasks without receiving
  shell, patch, git, PR, package manager, Code Interpreter, or Computer Use
  capabilities.
  """

  @behaviour SymphonyElixir.Planner.ModelClient

  alias SymphonyElixir.{
    Codex.ToolPolicy,
    Config,
    MapUtils,
    PlanningProfile,
    Planner.PlannerToolExecutor,
    Planner.ToolNameMapping,
    RuntimeLog,
    Schema.ExecutionProfile,
    ToolAdapter,
    ToolRegistry,
    WorkItem
  }

  alias SymphonyElixir.Runner.Observability

  @responses_url "https://api.openai.com/v1/responses"
  @default_model "gpt-5.1"
  @default_max_tool_iterations 8

  @impl true
  def start_session(config, _workspace) when is_map(config) do
    with {:ok, api_key} <- api_key(config) do
      settings = Config.settings!()
      settings_agent = settings.stored_agent || %{}

      agent =
        config_value(config, "agent") || config_value(config, "stored_agent") || settings_agent

      workspace_id = config_value(config, "workspace_id") || config_value(agent, "workspace_id")

      model =
        config_value(config, "model") || agent_model(agent) || settings.codex.model ||
          @default_model

      tool_policy = agent_tool_policy(agent) || settings.stored_agent.tool_policy || %{}

      planning_profile =
        config_value(config, "planning_profile") || PlanningProfile.resolve(agent)

      runtime_policy =
        ToolPolicy.resolve("planning", tool_policy, %{
          thread_sandbox: "read-only",
          turn_sandbox_policy: %{"type" => "readOnly", "networkAccess" => false}
        })

      with {:ok, state} <-
             Agent.start_link(fn ->
               %{previous_response_id: config_value(config, "previous_response_id"), author_task_ids: %{}}
             end) do
        tool_specs = ToolRegistry.effective_definitions(config, runtime_policy.dynamic_tool_names)
        tool_names = ToolRegistry.definition_names(tool_specs)
        provider_tool_name_map = ToolNameMapping.runtime_to_provider(tool_names)

        {:ok,
         %{
           api_key: api_key,
           base_url: config_value(config, "base_url") || @responses_url,
           model: model,
           instructions:
             config_value(config, "instructions") ||
               default_instructions(settings, agent, planning_profile, tool_names),
           state: state,
           tool_specs: tool_specs,
           tool_names: tool_names,
           provider_tool_name_map: provider_tool_name_map,
           workspace_id: workspace_id,
           agent_id: config_value(config, "agent_id") || config_value(agent, "id"),
           max_tool_iterations: config_integer(config, "max_tool_iterations", @default_max_tool_iterations),
           req_options: req_options(config),
           trace_id: config_value(config, "trace_id") || Process.get(:symphony_trace_id),
           on_message: config_value(config, "on_message")
         }}
      end
    end
  end

  @impl true
  def run_turn(session, prompt, %WorkItem{} = work_item)
      when is_map(session) and is_binary(prompt) do
    reset_tool_results(session)

    request =
      session
      |> base_request(prompt, work_item)
      |> maybe_put_previous_response_id(previous_response_id(session))

    run_responses_loop(session, request, 0)
  end

  @impl true
  def stop_session(%{state: state}) when is_pid(state) do
    Agent.stop(state, :normal)
  catch
    :exit, _reason -> :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    case api_key(config) do
      {:ok, _api_key} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  @impl true
  def requires_workspace?, do: false

  defp run_responses_loop(session, request, iteration) do
    attempt = iteration + 1

    with {:ok, response} <- create_response(session, request, attempt) do
      remember_response_id(session, response)

      case response_tool_calls(response) do
        [] ->
          response = maybe_add_fallback_message(session, response, request)
          emit_response_messages(session, response)
          emit_turn_completed(session, response)
          {:ok, response_result(response)}

        calls when iteration < session.max_tool_iterations ->
          emit_response_messages(session, response)
          outputs = execute_tool_calls(session, calls)

          follow_up = %{
            "model" => session.model,
            "input" => outputs,
            "previous_response_id" => response_id(response),
            "tools" => responses_tool_specs(session)
          }

          run_responses_loop(session, follow_up, iteration + 1)

        _calls ->
          emit_response_messages(session, response)
          {:error, {:fatal, :planner_tool_iteration_limit_exceeded}}
      end
    end
  end

  defp create_response(session, request, attempt) do
    started_at = System.monotonic_time(:millisecond)

    context = planner_provider_context(session, request, attempt)
    Observability.log_model_call_started(context)

    req =
      Req.new(
        url: session.base_url,
        headers: [
          {"authorization", "Bearer #{session.api_key}"},
          {"content-type", "application/json"}
        ]
      )
      |> Req.merge(session.req_options)

    case Req.post(req, json: request) do
      {:ok, %Req.Response{status: status, body: body} = response} when status in 200..299 ->
        Observability.log_model_call_completed(
          context,
          elapsed_ms(started_at),
          status_code: status,
          provider_request_id: Observability.provider_request_id(response) || provider_request_id(body)
        )

        {:ok, body}

      {:ok, %Req.Response{status: status, body: body} = response} ->
        classification =
          Observability.provider_status_failure(
            status,
            body,
            response,
            context,
            elapsed_ms(started_at)
          )
          |> Observability.log_provider_failure()

        error_kind = if classification.retryable, do: :retryable, else: :fatal
        {:error, {error_kind, classification}}

      {:error, reason} ->
        classification =
          Observability.provider_request_failure(
            reason,
            context,
            elapsed_ms(started_at)
          )
          |> Observability.log_provider_failure()

        {:error, {:retryable, classification}}
    end
  end

  defp base_request(session, prompt, work_item) do
    %{
      "model" => session.model,
      "instructions" => session.instructions,
      "input" => [
        %{
          "role" => "user",
          "content" => [
            %{
              "type" => "input_text",
              "text" => prompt
            }
          ]
        }
      ],
      "metadata" => %{
        "runner" => "planner",
        "work_item_id" => work_item.id,
        "work_item_identifier" => work_item.identifier
      },
      "tools" => responses_tool_specs(session)
    }
  end

  defp responses_tool_specs(session),
    do: Enum.map(session.tool_specs, &ToolNameMapping.responses_tool_spec(&1, session.provider_tool_name_map))

  defp maybe_put_previous_response_id(request, previous_response_id)
       when is_binary(previous_response_id) do
    Map.put(request, "previous_response_id", previous_response_id)
  end

  defp maybe_put_previous_response_id(request, _previous_response_id), do: request

  defp response_tool_calls(response) when is_map(response) do
    response
    |> ToolAdapter.parse_tool_calls(:openai)
    |> Enum.map(&canonical_to_responses_call/1)
  end

  defp response_tool_calls(_response), do: []

  defp canonical_to_responses_call(call) do
    %{
      "type" => "function_call",
      "call_id" => call.id,
      "name" => call.name,
      "arguments" => function_call_arguments(call)
    }
  end

  defp function_call_arguments(%{malformed_arguments?: true, raw_arguments: raw_arguments})
       when is_binary(raw_arguments),
       do: raw_arguments

  defp function_call_arguments(call), do: Jason.encode!(call.arguments || %{})

  defp execute_tool_calls(session, calls) do
    Enum.map(calls, fn call ->
      started_at = System.monotonic_time(:millisecond)
      tool = ToolNameMapping.runtime_name(Map.get(call, "name"), session.provider_tool_name_map)
      tool_call_id = Map.get(call, "call_id")

      arguments =
        call
        |> Map.get("arguments")
        |> PlannerToolExecutor.decode_arguments()
        |> PlannerToolExecutor.maybe_put_workspace_id(tool, session)

      RuntimeLog.log(:info, :tool_call_started, planner_tool_log_fields(session, call, tool))

      emit_message(session, :tool_call_started, %{
        payload: %{
          "params" =>
            %{"tool" => tool, "callId" => tool_call_id}
            |> maybe_put_payload_field("arguments", arguments)
        },
        details: %{"arguments" => arguments}
      })

      result =
        PlannerToolExecutor.execute(session, tool, arguments)
        |> Observability.classify_tool_result(
          %{tool_name: tool, tool_call_id: tool_call_id, attempt: 1},
          elapsed_ms(started_at)
        )
        |> Observability.log_tool_result()

      event = if Map.get(result, "success"), do: :tool_call_completed, else: :tool_call_failed

      RuntimeLog.log(
        tool_log_level(event),
        event,
        planner_tool_log_fields(session, call, tool, result)
      )

      remember_tool_result(session, tool, result)

      emit_message(session, event, %{
        payload: %{
          "params" =>
            %{"tool" => tool, "callId" => tool_call_id}
            |> maybe_put_payload_field("errorCode", Map.get(result, "error_code"))
            |> maybe_put_payload_field("retryable", Map.get(result, "retryable"))
        },
        details: result
      })

      %{
        "type" => "function_call_output",
        "call_id" => tool_call_id,
        "output" => Map.get(result, "output", Jason.encode!(result))
      }
    end)
  end

  defp emit_response_messages(session, response) do
    response
    |> output_texts()
    |> Enum.each(fn text ->
      emit_message(session, :notification, %{
        payload: %{
          "method" => "codex/event/agent_message_delta",
          "params" => %{"textDelta" => text}
        }
      })
    end)
  end

  defp output_texts(response) when is_map(response) do
    response
    |> Map.get("output", [])
    |> Enum.flat_map(fn
      %{"type" => "message", "content" => content} when is_list(content) ->
        Enum.flat_map(content, &content_text/1)

      _other ->
        []
    end)
  end

  defp output_texts(_response), do: []

  defp content_text(%{"type" => type, "text" => ""}) when type in ["output_text", "text"], do: []

  defp content_text(%{"type" => type, "text" => text})
       when type in ["output_text", "text"] and is_binary(text),
       do: [text]

  defp content_text(_content), do: []

  defp maybe_add_fallback_message(session, response, request) do
    if output_texts(response) == [] do
      case fallback_confirmation(session, request) do
        nil -> response
        message -> append_output_message(response, message)
      end
    else
      response
    end
  end

  defp append_output_message(response, message) when is_map(response) do
    output = Map.get(response, "output", [])

    Map.put(
      response,
      "output",
      output ++
        [
          %{
            "type" => "message",
            "role" => "assistant",
            "content" => [%{"type" => "output_text", "text" => message}]
          }
        ]
    )
  end

  defp fallback_confirmation(session, request) do
    request
    |> Map.get("previous_response_id")
    |> fallback_confirmation_from_remembered_tools(session)
  end

  defp fallback_confirmation_from_remembered_tools(previous_response_id, %{state: state})
       when is_binary(previous_response_id) and is_pid(state) do
    state
    |> Agent.get(&Map.get(&1, :last_tool_results, []))
    |> fallback_confirmation_from_tool_results()
  catch
    :exit, _reason -> nil
  end

  defp fallback_confirmation_from_remembered_tools(_previous_response_id, _session), do: nil

  defp fallback_confirmation_from_tool_results(results) when is_list(results) do
    cond do
      result = Enum.find(results, &created_plan_result?/1) ->
        result |> Map.get(:output) |> plan_confirmation()

      result = Enum.find(results, &created_task_result?/1) ->
        result |> Map.get(:output) |> task_confirmation()

      Enum.any?(results, &Map.get(&1, :success)) ->
        "Done."

      true ->
        nil
    end
  end

  defp fallback_confirmation_from_tool_results(_results), do: nil

  defp created_plan_result?(%{tool: "plan.create", success: true, output: output})
       when is_map(output),
       do: is_binary(Map.get(output, "id"))

  defp created_plan_result?(_result), do: false

  defp created_task_result?(%{tool: "task.create", success: true, output: output})
       when is_map(output),
       do: is_binary(Map.get(output, "id"))

  defp created_task_result?(_result), do: false

  defp plan_confirmation(plan) do
    name = Map.get(plan, "name") || "the plan"
    id = Map.get(plan, "id")

    if is_binary(id) and id != "" do
      "Created plan #{inspect(name)}. [Open plan](/plans/#{id})."
    else
      "Created plan #{inspect(name)}."
    end
  end

  defp task_confirmation(task) do
    name = Map.get(task, "name") || "the task"
    "Created task #{inspect(name)}."
  end

  defp emit_turn_completed(session, response) do
    emit_message(session, :turn_completed, %{
      payload: %{
        "id" => response_id(response),
        "usage" => Map.get(response, "usage", %{})
      },
      usage: Map.get(response, "usage")
    })
  end

  defp response_result(response) do
    %{
      "status" => Map.get(response, "status", "completed"),
      "response_id" => response_id(response),
      "output_text" => Enum.join(output_texts(response), "")
    }
  end

  defp response_id(response) when is_map(response), do: Map.get(response, "id")
  defp response_id(_response), do: nil

  defp provider_request_id(response) when is_map(response), do: Map.get(response, "id")
  defp provider_request_id(_response), do: nil

  defp elapsed_ms(started_at) do
    System.monotonic_time(:millisecond) - started_at
  end

  defp maybe_put_payload_field(map, _key, nil), do: map
  defp maybe_put_payload_field(map, key, value), do: Map.put(map, key, value)

  defp planner_provider_context(session, request, attempt) do
    %{
      trace_id: RuntimeLog.ensure_trace_id(Map.get(session, :trace_id)),
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      run_id: Map.get(request, "previous_response_id"),
      provider: "openai",
      model: Map.get(request, "model"),
      runner_kind: "planner",
      attempt: attempt
    }
  end

  defp planner_tool_log_fields(session, call, tool, result \\ nil) do
    %{
      trace_id: RuntimeLog.ensure_trace_id(Map.get(session, :trace_id)),
      provider: "openai",
      model: Map.get(session, :model),
      runner: "planner",
      tool_call_id: Map.get(call, "call_id"),
      tool_name: tool,
      success: tool_result_success(result),
      error_code: tool_result_field(result, "error_code"),
      retryable: tool_result_field(result, "retryable"),
      duration_ms: tool_result_field(result, "duration_ms"),
      attempt: tool_result_field(result, "attempt")
    }
  end

  defp tool_result_success(nil), do: nil
  defp tool_result_success(%{"success" => success}) when is_boolean(success), do: success
  defp tool_result_success(_result), do: false

  defp tool_result_field(%{} = result, key), do: Map.get(result, key)
  defp tool_result_field(_result, _key), do: nil

  defp tool_log_level(:tool_call_completed), do: :info
  defp tool_log_level(_event), do: :warning

  defp previous_response_id(%{state: state}) when is_pid(state) do
    Agent.get(state, &Map.get(&1, :previous_response_id))
  catch
    :exit, _reason -> nil
  end

  defp previous_response_id(_session), do: nil

  defp remember_response_id(session, response) do
    case response_id(response) do
      id when is_binary(id) ->
        update_session_state(session, :previous_response_id, id)

      _ ->
        :ok
    end
  end

  defp reset_tool_results(session), do: update_session_state(session, :last_tool_results, [])

  defp remember_tool_result(session, tool, %{"success" => success, "output" => output})
       when is_binary(tool) and is_boolean(success) and is_binary(output) do
    decoded_output =
      case Jason.decode(output) do
        {:ok, decoded} -> decoded
        {:error, _reason} -> output
      end

    append_session_tool_result(session, %{tool: tool, success: success, output: decoded_output})
  end

  defp remember_tool_result(_session, _tool, _result), do: :ok

  defp append_session_tool_result(%{state: state}, result) when is_pid(state) do
    Agent.update(state, fn current ->
      Map.update(current, :last_tool_results, [result], &(&1 ++ [result]))
    end)
  catch
    :exit, _reason -> :ok
  end

  defp append_session_tool_result(_session, _result), do: :ok

  defp update_session_state(%{state: state}, key, value) when is_pid(state) do
    Agent.update(state, &Map.put(&1, key, value))
  catch
    :exit, _reason -> :ok
  end

  defp update_session_state(_session, _key, _value), do: :ok

  defp emit_message(%{on_message: on_message}, event, details) when is_function(on_message, 1) do
    on_message.(details |> Map.put(:event, event) |> Map.put(:timestamp, DateTime.utc_now()))
  end

  defp emit_message(_session, _event, _details), do: :ok

  @spec default_instructions(map() | struct(), map() | struct(), term(), [String.t()] | nil) ::
          String.t()
  def default_instructions(settings, agent, planning_profile, _tool_names \\ nil) do
    context = agent_context(agent)
    profile_instructions = PlanningProfile.render_instructions(planning_profile)

    """
    #{profile_instructions}

    Inspect the request, create or update structured plan/task records with the provided planner tools, and stop after planning.
    After a successful tool call, always return a concise user-facing confirmation that names what changed and includes relevant plan or task IDs/links from the tool result.
    You cannot write code, mutate a workspace, create commits, create pull requests, run shell commands, install packages, use Code Interpreter, or use Computer Use.
    Current time: #{DateTime.utc_now() |> DateTime.to_iso8601()}. Workspace timezone: Etc/UTC. When a user asks to schedule, pause, or defer an existing work item to a specific time, call task.schedule with next_poll_at set to the resolved absolute ISO timestamp.

    Work item table guidance:
    - A work item with state "todo" is planned but not manager-runnable.
    - Prefer delegate for new work that should be handed to the orchestrator. Use delegate.when "now" for immediate manager pickup, an absolute ISO timestamp for scheduled pickup, or omit when for plan-only todo work.
    - task.create remains the full power surface. To make a task.create item available to the manager agent, set state to "running" or "awaiting_review" and set next_poll_at to an absolute ISO timestamp.
    - Do not set poll_cadence_seconds for one-shot manager tests. Only set it when the user explicitly asks for recurring follow-up.
    - Example: create a manager-runnable item for now with delegate using instructions, optional title, intent "implement", and when "now".
    - Example: make an existing item manager-runnable by calling task.update with state "running", then task.schedule with the resolved next_poll_at.

    Work item routing guidance:
    - For multi-task plans, give each task.create call a stable author_task_id such as "A" or "implement-api". When a later task depends on earlier tasks created in the same planner session, pass depends_on_author_ids instead of guessing database ids.
    - Use intent instead of concrete routing fields when possible: implement for coding changes, review for code or PR review, test for validation work, browse for browser/desktop UI work, and remediate for fixing known failures.
    - task.create routing.intent is the primary dispatch hint. Use one of: #{Enum.join(SymphonyElixir.Orchestrator.IntentVocabulary.names(), ", ")}.
    - task.create accepts optional top-level repository and runner_kind fields. Use repository when the user names a repository or the request spans multiple repositories. Use runner_kind only when the user, agent context, or repository routing explicitly names a backend.
    - delegate and task.create return validation_feedback when the runtime applied a smart default and dispatch.eligible/reason to summarize whether the created row is ready for orchestrator polling. Treat this as advisory feedback; the orchestrator re-checks policy at poll time.
    - If a tool failure includes validation_feedback with recoverable true and ask_user false, retry once with the suggested_default. If ask_user is true, ask exactly one concise question before retrying.
    - Set repository to the stable repository identifier visible in the user request or agent context. Do not invent aliases.
    - Use only canonical runtime runner_kind values: #{Enum.join(ExecutionProfile.supported_runner_kinds(), ", ")}.
    - Prefer routing.intent over runner_kind. Use runner_kind "codex" for normal cloud coding work, "local_model_coding" when the user asks for a local model/local workspace coding runner, "manager" for follow-up orchestration or polling work, "planner" for additional planning work, "computer_use" for browser/desktop UI work, "openclaw" for OpenClaw work, and "local_relay" only when the requested backend is specifically the relay adapter.
    - If the correct repository or runner is unclear, create the plan and ask a concise clarifying question before creating routed work items.

    Stored agent type: #{settings.stored_agent.type || "planning"}
    #{if context, do: "\nAgent context:\n#{context}", else: ""}
    """
  end

  defp agent_model(agent) do
    case get_field(agent, "model_settings") do
      model_settings when is_map(model_settings) ->
        MapUtils.atom_or_string_get(model_settings, "model")

      _ ->
        nil
    end
  end

  defp agent_tool_policy(agent) do
    case get_field(agent, "tool_policy") do
      tool_policy when is_map(tool_policy) -> tool_policy
      _ -> nil
    end
  end

  defp agent_context(agent) do
    case get_field(agent, "context") do
      context when is_binary(context) and context != "" -> context
      _ -> nil
    end
  end

  defp api_key(config) do
    case config_value(config, "api_key") || credentials_api_key(config) ||
           System.get_env("OPENAI_API_KEY") do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :missing_openai_api_key}
    end
  end

  defp credentials_api_key(config) do
    case config_value(config, "credentials") do
      %{} = credentials -> get_field(credentials, "OPENAI_API_KEY")
      _ -> nil
    end
  end

  defp config_value(config, key) when is_map(config) do
    get_field(config, key)
  end

  defp get_field(map, key) when is_map(map), do: MapUtils.atom_or_string_get(map, key)

  defp get_field(_map, _key), do: nil

  defp config_integer(config, key, default) do
    case config_value(config, key) do
      value when is_integer(value) and value > 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer > 0 -> integer
          _ -> default
        end

      _ ->
        default
    end
  end

  defp req_options(config) do
    configured = config_value(config, "req_options") || []
    env_options = Application.get_env(:symphony_elixir, :planner_responses_req_options, [])

    Keyword.merge(List.wrap(configured), env_options)
  end
end
