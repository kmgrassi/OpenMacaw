defmodule SymphonyElixir.Manager.ModelClient.LocalRelay do
  @moduledoc """
  Manager model client that sends model turns through the local relay.

  The relay helper is responsible for model I/O. The runtime manager still
  executes manager tools and sends tool outputs back over the same relay
  correlation.
  """

  @behaviour SymphonyElixir.Manager.ModelClient

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Readiness, Session}
  alias SymphonyElixir.LocalRelay.Handlers.RuntimeManaged
  alias SymphonyElixir.Planner.ToolNameMapping
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.{ToolRegistry, ToolSpec}

  @default_target_runner_kind "openai_compatible"
  @default_timeout_ms 300_000
  @impl true
  def create_response(session, %{"metadata" => %{"local_relay_continuation" => true}} = request, attempt) do
    correlation_id = Map.fetch!(request, "correlation_id")
    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, attempt, correlation_id)
    Observability.log_model_request_context_prepared(context, request)
    Observability.log_model_call_started(context)

    result = request |> continuation_frame() |> run_session(session, correlation_id, :send_frame)

    log_result(result, context, started_at)
  end

  def create_response(session, request, attempt) do
    correlation_id = Map.fetch!(request, "correlation_id")
    target_runner_kind = target_runner_kind(session)
    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, attempt, correlation_id)
    Observability.log_model_request_context_prepared(context, request)
    Observability.log_model_call_started(context)

    result =
      with {:ok, helper} <- Readiness.lookup(session.workspace_id, target_runner_kind),
           :ok <- ensure_model_available(session, helper),
           :ok <- ensure_capabilities(session, helper) do
        run_session(request, session, correlation_id, :dispatch)
      else
        {:error, :local_runtime_offline} -> {:error, {:retryable, :local_runtime_offline}}
        {:error, :local_runner_busy} -> {:error, {:retryable, :local_runner_busy}}
        {:error, :local_runner_protocol_error} -> {:error, {:fatal, :local_runner_protocol_error}}
        {:error, :model_not_found} -> {:error, {:fatal, :model_not_found}}
        {:error, :capability_missing} -> {:error, {:fatal, :capability_missing}}
      end

    log_result(result, context, started_at)
  end

  @impl true
  def initial_request(session, due_tasks_payload, work_item) do
    correlation_id = Ecto.UUID.generate()
    allowed_tools = Map.get(session, :allowed_tools, ToolRegistry.bundle(:manager))

    # tool_specs are already marked (git.run -> execution_kind helper) for
    # local-relay managers in LlmToolRunner.start_session, so the helper sees
    # which tools to delegate and LlmToolRunner.execute_tool agrees.
    tool_definitions = Map.get(session, :tool_specs, ToolRegistry.specs(allowed_tools))
    provider_tool_name_map = ToolNameMapping.runtime_to_provider(allowed_tools)

    %{
      "type" => "dispatch",
      "protocol" => ProtocolExtensions.protocol_version(),
      "correlation_id" => correlation_id,
      "workspace_id" => session.workspace_id,
      "agent_id" => session.agent_id,
      "run_id" => work_item.id || correlation_id,
      "runner_kind" => "local_relay",
      "target_runner_kind" => target_runner_kind(session),
      "provider" => session.provider || "local",
      "model" => session.model,
      "prompt" => due_tasks_payload,
      "messages" => initial_messages(session, due_tasks_payload),
      "work_item" => work_item_context(work_item),
      "capability_requirements" => capability_requirements(session),
      "tool_definitions" => tool_definitions,
      "provider_tool_specs" =>
        tool_definitions
        |> ToolSpec.to_provider_format(:openai_compatible)
        |> Enum.map(&ToolNameMapping.put_provider_tool_name(&1, provider_tool_name_map)),
      "provider_tool_name_map" => provider_tool_name_map,
      "tool_frame_types" => ProtocolExtensions.tool_frame_types(),
      "tool_calling_mode" => "runtime_managed",
      "metadata" => %{"runner" => "manager"}
    }
    |> reject_nil_values()
  end

  @impl true
  def follow_up_request(session, response, tool_outputs) do
    %{
      "type" => "dispatch",
      "protocol" => ProtocolExtensions.protocol_version(),
      "correlation_id" => response_id(response),
      "runner_kind" => "local_relay",
      "target_runner_kind" => target_runner_kind(session),
      "tool_outputs" => tool_outputs,
      "messages" => Enum.map(tool_outputs, &tool_output_message/1),
      "metadata" => %{"local_relay_continuation" => true}
    }
  end

  @impl true
  def output_texts(response) when is_map(response) do
    response
    |> Map.get("output", [])
    |> Enum.flat_map(fn
      %{"type" => "message", "content" => content} when is_list(content) ->
        Enum.flat_map(content, &content_text/1)

      _other ->
        []
    end)
  end

  def output_texts(_response), do: []

  @impl true
  def tool_calls(response) when is_map(response) do
    response
    |> Map.get("output", [])
    |> Enum.filter(&(Map.get(&1, "type") == "function_call"))
  end

  def tool_calls(_response), do: []

  @impl true
  def response_id(response) when is_map(response), do: Map.get(response, "id")
  def response_id(_response), do: nil

  defp run_session(frame, session, correlation_id, dispatch_mode) do
    Session.run_turn(
      %{
        workspace_id: session.workspace_id,
        target_runner_kind: target_runner_kind(session),
        frame: frame,
        correlation_id: correlation_id,
        timeout_ms: timeout_ms(session)
      },
      RuntimeManaged,
      dispatch: dispatch_mode
    )
  end

  defp continuation_frame(request) do
    request
    |> Map.put("type", "dispatch")
    |> Map.put("runner_kind", "local_relay")
    |> Map.drop(["correlation_id"])
  end

  defp initial_messages(session, due_tasks_payload) do
    [
      %{"role" => "system", "content" => session.prompt},
      %{"role" => "user", "content" => due_tasks_payload}
    ]
  end

  defp tool_output_message(%{"call_id" => call_id, "output" => output}) do
    %{"role" => "tool", "tool_call_id" => call_id, "content" => tool_output_content(output)}
  end

  defp tool_output_message(output), do: %{"role" => "tool", "content" => Jason.encode!(output)}

  defp tool_output_content(output) when is_binary(output), do: output
  defp tool_output_content(output), do: Jason.encode!(output)

  defp ensure_model_available(%{model: model}, _helper) when model in [nil, ""], do: :ok

  defp ensure_model_available(%{model: model} = session, helper) do
    case registered_runner(helper, target_runner_kind(session)) do
      %{model: registered_model} when registered_model in [nil, "", model] -> :ok
      %{"model" => registered_model} when registered_model in [nil, "", model] -> :ok
      _runner -> {:error, :model_not_found}
    end
  end

  defp ensure_capabilities(session, helper) do
    capabilities =
      helper
      |> registered_runner(target_runner_kind(session))
      |> map_value(:capabilities)
      |> normalize_map()

    requirements = capability_requirements(session)

    missing? =
      Enum.any?(requirements, fn {key, required} ->
        not capability_satisfies?(map_value(capabilities, key), required)
      end)

    if missing?, do: {:error, :capability_missing}, else: :ok
  end

  defp capability_requirements(session) do
    session
    |> Map.get(:capability_requirements, %{})
    |> normalize_map()
    |> Map.put_new("runtime_managed_tools", true)
  end

  defp registered_runner(%{runners: runners}, target_runner_kind) when is_list(runners) do
    Enum.find(runners, %{}, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runner(%{"runners" => runners}, target_runner_kind) when is_list(runners) do
    Enum.find(runners, %{}, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runner(_helper, _target_runner_kind), do: %{}

  defp capability_satisfies?(_capability, false), do: true
  defp capability_satisfies?(capability, true), do: capability == true
  defp capability_satisfies?(capability, required), do: capability == required

  defp target_runner_kind(session), do: Map.get(session, :target_runner_kind) || @default_target_runner_kind

  defp timeout_ms(session) do
    case Map.get(session, :timeout_ms) do
      value when is_integer(value) and value > 0 -> value
      _ -> @default_timeout_ms
    end
  end

  defp content_text(%{"type" => type, "text" => text})
       when type in ["output_text", "text"] and is_binary(text),
       do: [text]

  defp content_text(_content), do: []

  defp work_item_context(work_item) do
    %{
      "id" => Map.get(work_item, :id),
      "identifier" => Map.get(work_item, :identifier),
      "title" => Map.get(work_item, :title),
      "description" => Map.get(work_item, :description),
      "metadata" => Map.get(work_item, :metadata) || %{}
    }
    |> reject_nil_values()
  end

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        value

      :error ->
        string_key = to_string(key)

        Enum.find_value(map, fn {candidate_key, value} ->
          if to_string(candidate_key) == string_key, do: value
        end)
    end
  end

  defp map_value(_map, _key), do: nil

  defp normalize_map(value) when is_map(value), do: value
  defp normalize_map(_value), do: %{}

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp provider_context(session, attempt, correlation_id) do
    %{
      provider: Map.get(session, :provider) || "local",
      model: Map.get(session, :model),
      runner_kind: "local_relay",
      credential_scope: Map.get(session, :credential_scope),
      credential_id: Map.get(session, :credential_id),
      attempt: attempt,
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      trace_id: Map.get(session, :trace_id),
      run_id: correlation_id
    }
  end

  defp log_result({:ok, response} = result, context, started_at) do
    Observability.log_model_call_completed(context, elapsed_ms(started_at),
      provider_request_id: response_id(response),
      response: response
    )

    result
  end

  defp log_result({:error, {_kind, reason}} = result, context, started_at) do
    reason
    |> Observability.provider_error_failure(context, elapsed_ms(started_at))
    |> Observability.log_provider_failure()

    result
  end

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at
end
