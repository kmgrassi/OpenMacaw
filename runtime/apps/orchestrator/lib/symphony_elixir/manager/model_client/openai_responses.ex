defmodule SymphonyElixir.Manager.ModelClient.OpenAIResponses do
  @moduledoc """
  Manager model client for OpenAI's Responses API.
  """

  @behaviour SymphonyElixir.Manager.ModelClient

  alias SymphonyElixir.Planner.ToolNameMapping
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.ToolAdapter.OpenAI, as: ToolCallAdapter

  @impl true
  def create_response(session, request, attempt) do
    req =
      Req.new(
        url: session.base_url,
        headers: [
          {"authorization", "Bearer #{session.api_key}"},
          {"content-type", "application/json"}
        ]
      )
      |> Req.merge(session.req_options)

    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, attempt)
    Observability.log_model_call_started(context)

    case Req.post(req, json: provider_request(request)) do
      {:ok, %Req.Response{status: status, body: body} = response} when status in 200..299 ->
        if Observability.provider_content_refusal?(body) do
          classification =
            Observability.provider_content_refusal_failure(
              body,
              context,
              duration_since(started_at)
            )
            |> Map.put(:status_code, status)
            |> Map.put(:provider_status, status)
            |> Map.put(:provider_request_id, Observability.provider_request_id(response))
            |> Observability.log_provider_failure()

          {:error, {:retryable, classification}}
        else
          Observability.log_model_call_completed(context, duration_since(started_at),
            status_code: status,
            provider_request_id: Observability.provider_request_id(response)
          )

          {:ok, normalize_response(body, request)}
        end

      {:ok, %Req.Response{status: status, body: body} = response} ->
        classification =
          Observability.provider_status_failure(
            status,
            body,
            response,
            context,
            duration_since(started_at)
          )
          |> Observability.log_provider_failure()

        error_kind = if classification.retryable, do: :retryable, else: :fatal
        {:error, {error_kind, classification}}

      {:error, reason} ->
        classification =
          Observability.provider_request_failure(
            reason,
            context,
            duration_since(started_at)
          )
          |> Observability.log_provider_failure()

        {:error, {:retryable, classification}}
    end
  end

  @impl true
  def initial_request(session, due_tasks_payload, work_item) do
    %{
      "model" => session.model,
      "instructions" => session.prompt,
      "input" => [
        %{
          "role" => "user",
          "content" => [
            %{
              "type" => "input_text",
              "text" => due_tasks_payload
            }
          ]
        }
      ],
      "metadata" => %{
        "runner" => "manager",
        "workspace_id" => session.workspace_id,
        "work_item_id" => work_item.id,
        "work_item_identifier" => work_item.identifier
      },
      "provider_tool_name_map" => Map.get(session, :provider_tool_name_map, %{}),
      "tools" => Enum.map(session.tool_specs, &responses_tool_spec(&1, Map.get(session, :provider_tool_name_map, %{})))
    }
    |> maybe_put_previous_response_id(Map.get(session, :previous_response_id))
  end

  @impl true
  def follow_up_request(session, response, tool_outputs) do
    %{
      "model" => session.model,
      "input" => Enum.map(tool_outputs, &normalize_function_call_output/1),
      "previous_response_id" => response_id(response),
      "provider_tool_name_map" => Map.get(session, :provider_tool_name_map, %{})
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
    provider_tool_name_map = Map.get(response, "provider_tool_name_map", %{})

    response
    |> ToolCallAdapter.parse_tool_calls()
    |> Enum.map(&canonical_to_responses_call(&1, provider_tool_name_map))
  end

  def tool_calls(_response), do: []

  @impl true
  def response_id(response) when is_map(response), do: Map.get(response, "id")
  def response_id(_response), do: nil

  defp responses_tool_spec(spec, provider_tool_name_map) do
    name = tool_name(spec)

    %{
      "type" => "function",
      "name" => ToolNameMapping.provider_name(name, provider_tool_name_map),
      "description" => tool_description(spec),
      "parameters" => tool_parameters(spec)
    }
  end

  defp tool_name(spec), do: Map.get(spec, "name") || Map.get(spec, :name) || Map.get(spec, "slug") || Map.get(spec, :slug)
  defp tool_description(spec), do: Map.get(spec, "description") || Map.get(spec, :description) || ""

  defp tool_parameters(spec) do
    case Map.get(spec, "inputSchema") || Map.get(spec, :inputSchema) || Map.get(spec, "parameters_schema") ||
           Map.get(spec, :parameters_schema) || Map.get(spec, "parameters") || Map.get(spec, :parameters) do
      schema when is_map(schema) -> schema
      _ -> %{"type" => "object", "properties" => %{}}
    end
  end

  defp canonical_to_responses_call(call, provider_tool_name_map) do
    name = ToolNameMapping.runtime_name(call.name, provider_tool_name_map)

    %{
      "type" => "function_call",
      "call_id" => call.id,
      "name" => name,
      "arguments" => function_call_arguments(call)
    }
  end

  defp function_call_arguments(%{malformed_arguments?: true, raw_arguments: raw_arguments})
       when is_binary(raw_arguments),
       do: raw_arguments

  defp function_call_arguments(call), do: Jason.encode!(call.arguments || %{})

  defp maybe_put_previous_response_id(request, previous_response_id)
       when is_binary(previous_response_id) do
    Map.put(request, "previous_response_id", previous_response_id)
  end

  defp maybe_put_previous_response_id(request, _previous_response_id), do: request

  defp normalize_function_call_output(%{"output" => output} = item) when is_binary(output), do: item

  defp normalize_function_call_output(%{"output" => output} = item) do
    Map.put(item, "output", Jason.encode!(output))
  end

  defp normalize_function_call_output(item), do: item

  defp normalize_response(body, request) when is_map(body) do
    body
    |> Map.put("provider_tool_name_map", Map.get(request, "provider_tool_name_map", %{}))
  end

  defp normalize_response(body, request) do
    %{
      "id" => nil,
      "output" => [],
      "metadata" => Map.get(request, "metadata", %{}),
      "provider_tool_name_map" => Map.get(request, "provider_tool_name_map", %{}),
      "raw_body" => body
    }
  end

  defp provider_request(request), do: Map.drop(request, ["provider_tool_name_map"])

  defp content_text(%{"type" => type, "text" => text})
       when type in ["output_text", "text"] and is_binary(text),
       do: [text]

  defp content_text(_content), do: []

  defp duration_since(started_at) do
    System.monotonic_time(:millisecond) - started_at
  end

  defp provider_context(session, attempt) do
    %{
      provider: "openai",
      model: session.model,
      runner_kind: "manager",
      credential_scope: Map.get(session, :credential_scope),
      credential_id: Map.get(session, :credential_id),
      attempt: attempt,
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      trace_id: Map.get(session, :trace_id),
      run_id: Map.get(session, :run_id),
      turn_id: Map.get(session, :turn_id)
    }
  end
end
