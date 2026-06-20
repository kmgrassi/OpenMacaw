defmodule SymphonyElixir.Runner.Observability do
  @moduledoc """
  Failure classification and structured runtime logs for runner boundaries.
  """

  alias SymphonyElixir.{ProviderFailurePersistence, RuntimeLog}

  @provider_request_headers [
    "x-request-id",
    "openai-request-id",
    "request-id",
    "x-openai-request-id"
  ]

  @provider_status_codes %{
    400 => "provider_invalid_request",
    401 => "provider_auth_failed",
    403 => "provider_auth_failed",
    408 => "provider_timeout",
    422 => "provider_invalid_request",
    429 => "provider_rate_limited"
  }

  @retryable_provider_codes MapSet.new([
                              "provider_rate_limited",
                              "provider_timeout",
                              "provider_overloaded",
                              "provider_content_refused",
                              "provider_stream_interrupted",
                              "provider_content_refused",
                              "provider_unknown"
                            ])

  @doc """
  Emits the common model-provider call start event.
  """
  @spec log_model_call_started(map()) :: :ok
  def log_model_call_started(context) when is_map(context) do
    :info
    |> RuntimeLog.log(:model_call_started, model_call_fields(context))
  end

  @doc """
  Emits a redacted summary of the exact model request context prepared for a
  turn. Raw message/tool contents are intentionally omitted by default; set
  `:log_raw_model_request_context` or `OPENMACAW_LOG_MODEL_CONTEXT_RAW=true`
  only during targeted debugging.
  """
  @spec log_model_request_context_prepared(map(), map()) :: :ok
  def log_model_request_context_prepared(context, request) when is_map(context) and is_map(request) do
    RuntimeLog.log(
      :info,
      :model_request_context_prepared,
      context
      |> model_call_fields()
      |> Map.merge(request_context_fields(request))
    )
  end

  @doc """
  Emits the common model-provider first streamed event/token event.
  """
  @spec log_model_call_first_event(map(), non_neg_integer()) :: :ok
  def log_model_call_first_event(context, latency_ms) when is_map(context) and is_integer(latency_ms) do
    RuntimeLog.log(
      :info,
      :model_call_first_event,
      context
      |> model_call_fields()
      |> Map.put(:first_event_latency_ms, latency_ms)
      |> Map.put(:duration_ms, latency_ms)
    )
  end

  @doc """
  Emits the common model-provider call completion event.
  """
  @spec log_model_call_completed(map(), non_neg_integer(), keyword()) :: :ok
  def log_model_call_completed(context, duration_ms, opts \\ []) when is_map(context) do
    fields =
      context
      |> model_call_fields()
      |> Map.put(:duration_ms, duration_ms)
      |> maybe_put(:status_code, Keyword.get(opts, :status_code))
      |> maybe_put(:provider_status, Keyword.get(opts, :status_code))
      |> maybe_put(:provider_request_id, Keyword.get(opts, :provider_request_id))
      |> maybe_put(:first_event_latency_ms, Keyword.get(opts, :first_event_latency_ms))

    RuntimeLog.log(:info, :model_call_completed, fields)
  end

  @doc """
  Classifies a provider-local failure that is not an HTTP response.
  """
  @spec provider_error_failure(term(), map(), non_neg_integer()) :: map()
  def provider_error_failure(reason, context, duration_ms) when is_map(context) do
    error_code = provider_request_error_code(reason)

    %{
      event: "model_call_failed",
      provider: Map.get(context, :provider, "openai"),
      model: Map.get(context, :model),
      runner_kind: Map.get(context, :runner_kind),
      credential_scope: Map.get(context, :credential_scope),
      credential_id_suffix: credential_id_suffix(Map.get(context, :credential_id)),
      status_code: nil,
      provider_status: nil,
      error_code: error_code,
      retryable: retryable_provider_error?(error_code),
      duration_ms: duration_ms,
      attempt: Map.get(context, :attempt, 1),
      retry_count: retry_count(context),
      trace_id: Map.get(context, :trace_id),
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      work_item_id: Map.get(context, :work_item_id),
      run_id: Map.get(context, :run_id),
      turn_id: Map.get(context, :turn_id),
      reason: inspect(reason)
    }
    |> reject_nil_values()
  end

  @doc """
  Classifies a non-2xx provider HTTP response.
  """
  @spec provider_status_failure(non_neg_integer(), term(), term(), map(), non_neg_integer()) :: map()
  def provider_status_failure(status, body, response, context, duration_ms)
      when is_integer(status) and is_map(context) do
    error_code = provider_status_error_code(status, body)

    %{
      event: "model_call_failed",
      provider: Map.get(context, :provider, "openai"),
      model: Map.get(context, :model),
      runner_kind: Map.get(context, :runner_kind),
      credential_scope: Map.get(context, :credential_scope),
      credential_id_suffix: credential_id_suffix(Map.get(context, :credential_id)),
      status: status,
      status_code: status,
      provider_status: status,
      error_code: error_code,
      retryable: retryable_provider_error?(error_code),
      duration_ms: duration_ms,
      attempt: Map.get(context, :attempt, 1),
      retry_count: retry_count(context),
      trace_id: Map.get(context, :trace_id),
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      work_item_id: Map.get(context, :work_item_id),
      run_id: Map.get(context, :run_id),
      turn_id: Map.get(context, :turn_id),
      provider_request_id: provider_request_id(response),
      reason: provider_error_summary(body)
    }
    |> reject_nil_values()
  end

  @doc """
  Classifies a successful provider response whose payload indicates a content refusal.
  """
  @spec provider_content_refusal_failure(term(), map(), non_neg_integer()) :: map()
  def provider_content_refusal_failure(body, context, duration_ms) when is_map(context) do
    %{
      event: "model_call_failed",
      provider: Map.get(context, :provider, "openai"),
      model: Map.get(context, :model),
      runner_kind: Map.get(context, :runner_kind),
      credential_scope: Map.get(context, :credential_scope),
      credential_id_suffix: credential_id_suffix(Map.get(context, :credential_id)),
      error_code: "provider_content_refused",
      retryable: true,
      duration_ms: duration_ms,
      attempt: Map.get(context, :attempt, 1),
      retry_count: retry_count(context),
      trace_id: Map.get(context, :trace_id),
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      run_id: Map.get(context, :run_id),
      turn_id: Map.get(context, :turn_id),
      reason: provider_error_summary(body)
    }
    |> reject_nil_values()
  end

  @doc """
  Classifies a provider request failure before a usable HTTP response exists.
  """
  @spec provider_request_failure(term(), map(), non_neg_integer()) :: map()
  def provider_request_failure(reason, context, duration_ms) when is_map(context) do
    error_code = provider_request_error_code(reason)

    %{
      event: "model_call_failed",
      provider: Map.get(context, :provider, "openai"),
      model: Map.get(context, :model),
      runner_kind: Map.get(context, :runner_kind),
      credential_scope: Map.get(context, :credential_scope),
      credential_id_suffix: credential_id_suffix(Map.get(context, :credential_id)),
      error_code: error_code,
      retryable: retryable_provider_error?(error_code),
      duration_ms: duration_ms,
      attempt: Map.get(context, :attempt, 1),
      retry_count: retry_count(context),
      trace_id: Map.get(context, :trace_id),
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      work_item_id: Map.get(context, :work_item_id),
      run_id: Map.get(context, :run_id),
      turn_id: Map.get(context, :turn_id),
      reason: inspect(reason)
    }
    |> reject_nil_values()
  end

  @spec log_provider_failure(map()) :: map()
  def log_provider_failure(classification) when is_map(classification) do
    RuntimeLog.log(:error, :model_call_failed, classification)
    ProviderFailurePersistence.write(classification)
    classification
  end

  @doc """
  Adds stable classification fields to a runner tool result map.
  """
  @spec classify_tool_result(map(), map(), non_neg_integer()) :: map()
  def classify_tool_result(result, context, duration_ms) when is_map(result) and is_map(context) do
    success? = Map.get(result, "success") == true

    classification =
      %{
        event: if(success?, do: "tool_call_completed", else: "tool_call_failed"),
        tool_name: Map.get(context, :tool_name),
        tool_call_id: Map.get(context, :tool_call_id),
        error_code: if(success?, do: nil, else: tool_error_code(result)),
        retryable: if(success?, do: false, else: tool_retryable?(result)),
        duration_ms: duration_ms,
        attempt: Map.get(context, :attempt, 1)
      }
      |> reject_nil_values()

    result
    |> Map.put("tool_name", Map.get(context, :tool_name))
    |> Map.put("tool_call_id", Map.get(context, :tool_call_id))
    |> Map.put("duration_ms", duration_ms)
    |> Map.put("attempt", Map.get(context, :attempt, 1))
    |> maybe_put_tool_failure_fields(classification)
  end

  @spec log_tool_result(map()) :: map()
  def log_tool_result(result) when is_map(result) do
    event =
      if Map.get(result, "success") == true do
        "tool_call_completed"
      else
        "tool_call_failed"
      end

    payload =
      %{
        event: event,
        tool_name: Map.get(result, "tool_name"),
        tool_call_id: Map.get(result, "tool_call_id"),
        error_code: Map.get(result, "error_code"),
        retryable: Map.get(result, "retryable"),
        duration_ms: Map.get(result, "duration_ms"),
        attempt: Map.get(result, "attempt")
      }
      |> reject_nil_values()

    log_failure(payload)
    result
  end

  defp provider_status_error_code(status, body) do
    cond do
      provider_content_refusal?(body) or content_policy_status_failure?(status, body) ->
        "provider_content_refused"

      status in [500, 502, 503, 504] ->
        "provider_overloaded"

      status == 499 ->
        "provider_stream_interrupted"

      Map.has_key?(@provider_status_codes, status) ->
        Map.fetch!(@provider_status_codes, status)

      provider_body_error_code(body) in ["rate_limit_exceeded", "rate_limited"] ->
        "provider_rate_limited"

      provider_body_error_code(body) in ["invalid_request_error", "invalid_request"] ->
        "provider_invalid_request"

      true ->
        "provider_unknown"
    end
  end

  defp provider_request_error_code(reason) when is_map(reason) or is_tuple(reason) do
    if codex_content_refusal_error?(reason) do
      "provider_content_refused"
    else
      provider_request_error_code(inspect(reason))
    end
  end

  defp provider_request_error_code(reason) do
    reason
    |> inspect()
    |> String.downcase()
    |> then(fn text ->
      cond do
        content_refusal_text?(text) -> "provider_content_refused"
        String.contains?(text, "provider_rate_limited") -> "provider_rate_limited"
        String.contains?(text, "provider_timeout") -> "provider_timeout"
        String.contains?(text, "provider_overloaded") -> "provider_overloaded"
        String.contains?(text, "provider_stream_interrupted") -> "provider_stream_interrupted"
        String.contains?(text, "provider_content_refused") -> "provider_content_refused"
        String.contains?(text, "provider_invalid_request") -> "provider_invalid_request"
        String.contains?(text, "provider_auth_failed") -> "provider_auth_failed"
        String.contains?(text, "provider_unknown") -> "provider_unknown"
        String.contains?(text, "timeout") -> "provider_timeout"
        String.contains?(text, "generation_timeout") -> "provider_timeout"
        String.contains?(text, "endpoint_unreachable") -> "provider_timeout"
        String.contains?(text, "model_not_found") -> "provider_invalid_request"
        String.contains?(text, "capability_missing") -> "provider_invalid_request"
        String.contains?(text, "closed") -> "provider_stream_interrupted"
        String.contains?(text, "interrupted") -> "provider_stream_interrupted"
        true -> "provider_unknown"
      end
    end)
  end

  defp retryable_provider_error?(error_code), do: MapSet.member?(@retryable_provider_codes, error_code)

  @doc """
  Detects provider payloads that refused generation for content-policy reasons.
  """
  @spec provider_content_refusal?(term()) :: boolean()
  def provider_content_refusal?(%{"stop_reason" => "refusal"}), do: true

  def provider_content_refusal?(%{"finish_reason" => "content_filter"}), do: true

  def provider_content_refusal?(%{"content" => content}) when is_list(content),
    do: Enum.any?(content, &anthropic_refusal_block?/1)

  def provider_content_refusal?(%{"output" => output}) when is_list(output),
    do: Enum.any?(output, &provider_content_refusal?/1)

  def provider_content_refusal?(%{"choices" => choices}) when is_list(choices),
    do: Enum.any?(choices, &openai_content_filter_choice?/1)

  def provider_content_refusal?(%{"error" => error}) when is_map(error),
    do: content_refusal_error?(error)

  def provider_content_refusal?(%{"error" => error}) when is_binary(error),
    do: content_refusal_text?(error)

  def provider_content_refusal?(%{"message" => message}) when is_binary(message),
    do: content_refusal_text?(message)

  def provider_content_refusal?(%{"reason" => reason}) when is_binary(reason),
    do: content_refusal_text?(reason)

  def provider_content_refusal?(%{"refusal" => refusal}) when is_binary(refusal),
    do: String.trim(refusal) != ""

  def provider_content_refusal?(%{"refusal" => refusal}) when is_list(refusal),
    do: refusal != []

  def provider_content_refusal?(_body), do: false

  @doc """
  Detects content-policy HTTP failures from non-LLM runner APIs.
  """
  @spec content_policy_status_failure?(non_neg_integer(), term()) :: boolean()
  def content_policy_status_failure?(status, body) when status in [400, 403, 422] do
    provider_content_refusal?(body) or content_refusal_text?(inspect(body))
  end

  def content_policy_status_failure?(_status, _body), do: false

  @doc """
  Detects Codex AppServer RPC errors that wrap a provider content refusal.
  """
  @spec codex_content_refusal_error?(term()) :: boolean()
  def codex_content_refusal_error?({:response_error, payload}), do: codex_content_refusal_error?(payload)
  def codex_content_refusal_error?({:turn_failed, payload}), do: codex_content_refusal_error?(payload)
  def codex_content_refusal_error?(%{"error" => error}), do: codex_content_refusal_error?(error)
  def codex_content_refusal_error?(%{"data" => data}) when is_map(data), do: codex_content_refusal_error?(data)
  def codex_content_refusal_error?(%{"code" => code}) when is_binary(code), do: content_refusal_text?(code)
  def codex_content_refusal_error?(%{"type" => type}) when is_binary(type), do: content_refusal_text?(type)
  def codex_content_refusal_error?(%{"message" => message}) when is_binary(message), do: content_refusal_text?(message)
  def codex_content_refusal_error?(payload) when is_binary(payload), do: content_refusal_text?(payload)
  def codex_content_refusal_error?(_payload), do: false

  defp anthropic_refusal_block?(%{"type" => "refusal"}), do: true
  defp anthropic_refusal_block?(%{"type" => "text", "text" => text}) when is_binary(text), do: content_refusal_text?(text)
  defp anthropic_refusal_block?(_block), do: false

  defp openai_content_filter_choice?(%{"finish_reason" => "content_filter"}), do: true
  defp openai_content_filter_choice?(%{"message" => message}) when is_map(message), do: provider_content_refusal?(message)
  defp openai_content_filter_choice?(_choice), do: false

  defp content_refusal_error?(%{"code" => code}) when is_binary(code), do: content_refusal_text?(code)
  defp content_refusal_error?(%{"type" => type}) when is_binary(type), do: content_refusal_text?(type)
  defp content_refusal_error?(%{"message" => message}) when is_binary(message), do: content_refusal_text?(message)
  defp content_refusal_error?(_error), do: false

  defp content_refusal_text?(text) when is_binary(text) do
    text = String.downcase(text)

    Enum.any?(
      [
        "content_filter",
        "content filter",
        "content_policy",
        "content policy",
        "safety policy",
        "safety_policy",
        "policy_violation",
        "refusal",
        "refused"
      ],
      &String.contains?(text, &1)
    )
  end

  defp content_refusal_text?(_text), do: false

  defp provider_body_error_code(%{"error" => %{"code" => code}}) when is_binary(code), do: code
  defp provider_body_error_code(%{"error" => %{"type" => type}}) when is_binary(type), do: type
  defp provider_body_error_code(_body), do: nil

  defp provider_error_summary(%{"error" => %{"message" => message}}) when is_binary(message), do: message
  defp provider_error_summary(%{"error" => error}) when is_binary(error), do: error
  defp provider_error_summary(body), do: inspect(body)

  @spec provider_request_id(term()) :: String.t() | nil
  def provider_request_id(%Req.Response{headers: headers}) do
    Enum.find_value(@provider_request_headers, &header_value(headers, &1))
  end

  def provider_request_id(_response), do: nil

  defp header_value(headers, name) when is_map(headers) do
    Map.get(headers, name) || Map.get(headers, String.downcase(name)) || Map.get(headers, String.to_atom(name))
  end

  defp header_value(headers, name) when is_list(headers) do
    Enum.find_value(headers, fn
      {key, value} when is_binary(key) ->
        if String.downcase(key) == name, do: normalize_header_value(value)

      _other ->
        nil
    end)
  end

  defp header_value(_headers, _name), do: nil

  defp normalize_header_value([value | _]), do: value
  defp normalize_header_value(value), do: value

  defp tool_error_code(%{"error" => error}) when error in ["invalid_arguments", "invalid_argument"],
    do: "tool_invalid_args"

  defp tool_error_code(%{"error" => "supabase_error"}), do: "tool_process_failed"
  defp tool_error_code(%{"error" => "not_implemented"}), do: "tool_unknown"

  defp tool_error_code(%{"output" => output}) when is_binary(output) do
    output
    |> decode_json_output()
    |> tool_output_error_code(output)
  end

  defp tool_error_code(_result), do: "tool_unknown"

  defp tool_output_error_code(%{"error" => "invalid_arguments"}, _output), do: "tool_invalid_args"

  # Local-relay helper failure shapes (git.run / shell.exec on the user's
  # machine). Classify these explicitly so a real helper failure is not
  # flattened to the default "tool_unknown" — which reads as "the tool does
  # not exist" and is non-retryable, masking the actual cause and blocking the
  # model from self-correcting. A genuine unsupported tool stays "tool_unknown";
  # everything else maps to a code that reflects what really happened.
  defp tool_output_error_code(%{"error" => "unsupported_local_tool"}, _output), do: "tool_unknown"
  defp tool_output_error_code(%{"error" => "no_local_tool_executor"}, _output), do: "tool_process_failed"
  defp tool_output_error_code(%{"error" => "command_blocked"}, _output), do: "tool_denied"
  defp tool_output_error_code(%{"error" => "command_timeout"}, _output), do: "tool_timeout"
  defp tool_output_error_code(%{"error" => "command_failed_to_start"}, _output), do: "tool_dependency_missing"

  defp tool_output_error_code(%{"error" => "helper_tool_failed", "reason" => reason}, _output)
       when is_binary(reason),
       do: tool_reason_error_code(reason)

  defp tool_output_error_code(%{"error" => "helper_tool_failed"}, _output), do: "tool_process_failed"

  defp tool_output_error_code(%{"error" => %{"message" => message}}, _output) when is_binary(message) do
    cond do
      String.contains?(message, "not allowed by this agent's tool policy") -> "tool_denied"
      String.contains?(message, "expects") -> "tool_invalid_args"
      true -> "tool_unknown"
    end
  end

  defp tool_output_error_code(%{"error" => %{"reason" => reason}}, _output), do: tool_reason_error_code(reason)
  defp tool_output_error_code(%{"reason" => reason}, _output), do: tool_reason_error_code(reason)

  defp tool_output_error_code(_decoded, output) do
    text = String.downcase(output)

    cond do
      String.contains?(text, "not allowed by this agent's tool policy") -> "tool_denied"
      String.contains?(text, "timeout") -> "tool_timeout"
      String.contains?(text, "invalid") -> "tool_invalid_args"
      true -> "tool_unknown"
    end
  end

  defp tool_reason_error_code(reason) do
    reason
    |> inspect()
    |> String.downcase()
    |> then(fn text ->
      cond do
        String.contains?(text, "timeout") -> "tool_timeout"
        String.contains?(text, "missing") -> "tool_invalid_args"
        String.contains?(text, "invalid") -> "tool_invalid_args"
        String.contains?(text, "not_found") -> "tool_invalid_args"
        String.contains?(text, "enoent") -> "tool_dependency_missing"
        true -> "tool_process_failed"
      end
    end)
  end

  defp tool_retryable?(%{"error_code" => "tool_timeout"}), do: true
  defp tool_retryable?(%{"error_code" => "tool_process_failed"}), do: true
  defp tool_retryable?(result), do: tool_error_code(result) in ["tool_timeout", "tool_process_failed"]

  defp decode_json_output(output) do
    case Jason.decode(output) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> nil
    end
  end

  defp maybe_put_tool_failure_fields(result, %{event: "tool_call_completed"}), do: result

  defp maybe_put_tool_failure_fields(result, classification) do
    result
    |> Map.put("error_code", Map.get(classification, :error_code))
    |> Map.put("retryable", Map.get(classification, :retryable))
  end

  defp model_call_fields(context) do
    %{
      provider: Map.get(context, :provider),
      model: Map.get(context, :model),
      runner_kind: Map.get(context, :runner_kind),
      credential_scope: Map.get(context, :credential_scope),
      credential_id_suffix: credential_id_suffix(Map.get(context, :credential_id)),
      attempt: Map.get(context, :attempt, 1),
      retry_count: retry_count(context),
      trace_id: Map.get(context, :trace_id),
      workspace_id: Map.get(context, :workspace_id),
      agent_id: Map.get(context, :agent_id),
      session_key: Map.get(context, :session_key),
      run_id: Map.get(context, :run_id),
      turn_id: Map.get(context, :turn_id)
    }
    |> reject_nil_values()
  end

  defp request_context_fields(request) do
    messages = list_field(request, "messages")
    tool_definitions = list_field(request, "tool_definitions")
    provider_tool_specs = list_field(request, "provider_tool_specs")

    fields =
      %{
        request_type: map_value(request, "type"),
        correlation_id: map_value(request, "correlation_id"),
        dispatch_workspace_id: map_value(request, "workspace_id"),
        dispatch_agent_id: map_value(request, "agent_id"),
        dispatch_run_id: map_value(request, "run_id"),
        dispatch_session_id: map_value(request, "session_id"),
        target_runner_kind: map_value(request, "target_runner_kind"),
        tool_calling_mode: map_value(request, "tool_calling_mode"),
        message_count: length(messages),
        message_roles: Enum.map(messages, &map_value(&1, "role")),
        message_context: Enum.with_index(messages, &message_summary/2),
        tool_definition_count: length(tool_definitions),
        tool_definition_names: Enum.map(tool_definitions, &(map_value(&1, "name") || map_value(&1, "slug"))),
        provider_tool_spec_count: length(provider_tool_specs),
        provider_tool_names: Enum.map(provider_tool_specs, &provider_tool_name/1),
        prompt_chars: content_length(map_value(request, "prompt")),
        prompt_sha256: content_hash(map_value(request, "prompt")),
        has_work_item_context: is_map(map_value(request, "work_item")),
        has_capability_requirements: is_map(map_value(request, "capability_requirements")),
        has_provider_tool_name_map: is_map(map_value(request, "provider_tool_name_map")),
        has_tool_outputs: list_field(request, "tool_outputs") != []
      }
      |> reject_nil_values()

    if raw_model_request_context_logging?() do
      fields
      |> Map.put(:raw_messages, messages)
      |> Map.put(:raw_tool_definitions, tool_definitions)
      |> Map.put(:raw_provider_tool_specs, provider_tool_specs)
      |> maybe_put(:raw_prompt, map_value(request, "prompt"))
    else
      fields
    end
  end

  defp message_summary(message, index) do
    content = map_value(message, "content")

    %{
      index: index,
      role: map_value(message, "role"),
      content_chars: content_length(content),
      content_sha256: content_hash(content),
      has_agent_instructions: binary_contains?(content, "Agent instructions:"),
      has_tool_calls: list_field(message, "tool_calls") != [],
      tool_call_id: map_value(message, "tool_call_id")
    }
    |> reject_nil_values()
  end

  defp provider_tool_name(%{"function" => %{"name" => name}}), do: name
  defp provider_tool_name(%{function: %{name: name}}), do: name
  defp provider_tool_name(tool), do: map_value(tool, "name")

  defp content_length(value) when is_binary(value), do: String.length(value)
  defp content_length(nil), do: nil
  defp content_length(value), do: value |> inspect(limit: 50, printable_limit: 500) |> String.length()

  defp content_hash(value) when is_binary(value) do
    :crypto.hash(:sha256, value)
    |> Base.encode16(case: :lower)
  end

  defp content_hash(nil), do: nil
  defp content_hash(value), do: value |> inspect(limit: 50, printable_limit: 500) |> content_hash()

  defp binary_contains?(value, needle) when is_binary(value), do: String.contains?(value, needle)
  defp binary_contains?(_value, _needle), do: false

  defp list_field(map, key) do
    case map_value(map, key) do
      values when is_list(values) -> values
      _ -> []
    end
  end

  defp map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  end

  defp map_value(_map, _key), do: nil

  defp raw_model_request_context_logging? do
    Application.get_env(:symphony_elixir, :log_raw_model_request_context) == true or
      System.get_env("OPENMACAW_LOG_MODEL_CONTEXT_RAW") in ["1", "true", "TRUE", "yes", "YES"]
  end

  defp retry_count(context) do
    case Map.get(context, :retry_count) do
      value when is_integer(value) and value >= 0 -> value
      _ -> max((Map.get(context, :attempt) || 1) - 1, 0)
    end
  end

  defp credential_id_suffix(value) when is_binary(value) do
    value = String.trim(value)

    cond do
      value == "" -> nil
      String.length(value) <= 8 -> value
      true -> String.slice(value, -8, 8)
    end
  end

  defp credential_id_suffix(_value), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp log_failure(%{event: "tool_call_completed"}), do: :ok

  defp log_failure(payload) when is_map(payload) do
    RuntimeLog.log(:warning, Map.get(payload, :event, :tool_call_failed), payload)
  end

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
