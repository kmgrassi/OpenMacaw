defmodule SymphonyElixir.Codex.AppServer.Approvals do
  @moduledoc """
  Dispatches Codex app-server approval, tool-call, and user-input requests.

  Each `handle/4` clause inspects an incoming JSON-RPC method, performs any
  side effects required (auto-approve, run a tool, answer a question), and
  returns one of:

    * `:approved` — request was handled and the receive loop should continue
    * `:approval_required` — auto-approve is disabled and the turn must stop
    * `:input_required` — operator input is unavailable and the turn must stop
    * `:unhandled` — caller should fall through to its default handling

  All side effects (port writes and `on_message` callbacks) flow through the
  `ctx` map so this module stays free of GenServer state.
  """

  require Logger
  alias SymphonyElixir.{Codex.PortProtocol, RuntimeLog}

  @non_interactive_tool_input_answer "This is a non-interactive session. Operator input is unavailable."

  @type ctx :: %{
          port: port(),
          on_message: (map() -> any()),
          tool_executor: (String.t() | nil, map() -> map()),
          auto_approve_requests: boolean(),
          metadata: map()
        }

  @type result :: :approved | :input_required | :approval_required | :unhandled

  @spec handle(String.t(), map(), String.t(), ctx()) :: result()
  def handle(method, payload, payload_string, ctx)

  def handle(
        "item/commandExecution/requestApproval",
        %{"id" => id} = payload,
        payload_string,
        ctx
      ) do
    approve_or_require(id, "acceptForSession", payload, payload_string, ctx)
  end

  def handle(
        "item/tool/call",
        %{"id" => id, "params" => params} = payload,
        payload_string,
        ctx
      ) do
    %{port: port, on_message: on_message, tool_executor: tool_executor, metadata: metadata} = ctx
    tool_name = tool_call_name(params)
    arguments = tool_call_arguments(params)
    RuntimeLog.log(:info, :tool_call_started, tool_log_fields(metadata, id, tool_name))
    emit_message(on_message, :tool_call_started, %{payload: payload, raw: payload_string}, metadata)

    result =
      tool_name
      |> tool_executor.(arguments)
      |> normalize_dynamic_tool_result()

    PortProtocol.send_message(port, %{
      "id" => id,
      "result" => result
    })

    event =
      case result do
        %{"success" => true} -> :tool_call_completed
        _ when is_nil(tool_name) -> :unsupported_tool_call
        _ -> :tool_call_failed
      end

    RuntimeLog.log(tool_log_level(event), event, tool_log_fields(metadata, id, tool_name, result))

    emit_message(on_message, event, %{payload: payload, raw: payload_string, result: result}, metadata)

    :approved
  end

  def handle("execCommandApproval", %{"id" => id} = payload, payload_string, ctx) do
    approve_or_require(id, "approved_for_session", payload, payload_string, ctx)
  end

  def handle("applyPatchApproval", %{"id" => id} = payload, payload_string, ctx) do
    approve_or_require(id, "approved_for_session", payload, payload_string, ctx)
  end

  def handle(
        "item/fileChange/requestApproval",
        %{"id" => id} = payload,
        payload_string,
        ctx
      ) do
    approve_or_require(id, "acceptForSession", payload, payload_string, ctx)
  end

  def handle(
        "item/tool/requestUserInput",
        %{"id" => id, "params" => params} = payload,
        payload_string,
        ctx
      ) do
    maybe_auto_answer_tool_request_user_input(id, params, payload, payload_string, ctx)
  end

  def handle(_method, _payload, _payload_string, _ctx), do: :unhandled

  defp approve_or_require(id, decision, payload, payload_string, %{auto_approve_requests: true} = ctx) do
    %{port: port, on_message: on_message, metadata: metadata} = ctx
    PortProtocol.send_message(port, %{"id" => id, "result" => %{"decision" => decision}})

    emit_message(
      on_message,
      :approval_auto_approved,
      %{payload: payload, raw: payload_string, decision: decision},
      metadata
    )

    :approved
  end

  defp approve_or_require(_id, _decision, _payload, _payload_string, %{auto_approve_requests: false}) do
    :approval_required
  end

  defp maybe_auto_answer_tool_request_user_input(
         id,
         params,
         payload,
         payload_string,
         %{auto_approve_requests: true} = ctx
       ) do
    %{port: port, on_message: on_message, metadata: metadata} = ctx

    case tool_request_user_input_approval_answers(params) do
      {:ok, answers, decision} ->
        PortProtocol.send_message(port, %{"id" => id, "result" => %{"answers" => answers}})

        emit_message(
          on_message,
          :approval_auto_approved,
          %{payload: payload, raw: payload_string, decision: decision},
          metadata
        )

        :approved

      :error ->
        reply_with_non_interactive_tool_input_answer(id, params, payload, payload_string, ctx)
    end
  end

  defp maybe_auto_answer_tool_request_user_input(
         id,
         params,
         payload,
         payload_string,
         %{auto_approve_requests: false} = ctx
       ) do
    reply_with_non_interactive_tool_input_answer(id, params, payload, payload_string, ctx)
  end

  defp reply_with_non_interactive_tool_input_answer(id, params, payload, payload_string, ctx) do
    %{port: port, on_message: on_message, metadata: metadata} = ctx

    case tool_request_user_input_unavailable_answers(params) do
      {:ok, answers} ->
        PortProtocol.send_message(port, %{"id" => id, "result" => %{"answers" => answers}})

        emit_message(
          on_message,
          :tool_input_auto_answered,
          %{payload: payload, raw: payload_string, answer: @non_interactive_tool_input_answer},
          metadata
        )

        :approved

      :error ->
        :input_required
    end
  end

  defp tool_request_user_input_approval_answers(%{"questions" => questions}) when is_list(questions) do
    answers =
      Enum.reduce_while(questions, %{}, fn question, acc ->
        case tool_request_user_input_approval_answer(question) do
          {:ok, question_id, answer_label} ->
            {:cont, Map.put(acc, question_id, %{"answers" => [answer_label]})}

          :error ->
            {:halt, :error}
        end
      end)

    case answers do
      :error -> :error
      answer_map when map_size(answer_map) > 0 -> {:ok, answer_map, "Approve this Session"}
      _ -> :error
    end
  end

  defp tool_request_user_input_approval_answers(_params), do: :error

  defp tool_request_user_input_unavailable_answers(%{"questions" => questions}) when is_list(questions) do
    answers =
      Enum.reduce_while(questions, %{}, fn question, acc ->
        case tool_request_user_input_question_id(question) do
          {:ok, question_id} ->
            {:cont, Map.put(acc, question_id, %{"answers" => [@non_interactive_tool_input_answer]})}

          :error ->
            {:halt, :error}
        end
      end)

    case answers do
      :error -> :error
      answer_map when map_size(answer_map) > 0 -> {:ok, answer_map}
      _ -> :error
    end
  end

  defp tool_request_user_input_unavailable_answers(_params), do: :error

  defp tool_request_user_input_question_id(%{"id" => question_id}) when is_binary(question_id),
    do: {:ok, question_id}

  defp tool_request_user_input_question_id(_question), do: :error

  defp tool_request_user_input_approval_answer(%{"id" => question_id, "options" => options})
       when is_binary(question_id) and is_list(options) do
    case tool_request_user_input_approval_option_label(options) do
      nil -> :error
      answer_label -> {:ok, question_id, answer_label}
    end
  end

  defp tool_request_user_input_approval_answer(_question), do: :error

  defp tool_request_user_input_approval_option_label(options) do
    options
    |> Enum.map(&tool_request_user_input_option_label/1)
    |> Enum.reject(&is_nil/1)
    |> case do
      labels ->
        Enum.find(labels, &(&1 == "Approve this Session")) ||
          Enum.find(labels, &(&1 == "Approve Once")) ||
          Enum.find(labels, &approval_option_label?/1)
    end
  end

  defp tool_request_user_input_option_label(%{"label" => label}) when is_binary(label), do: label
  defp tool_request_user_input_option_label(_option), do: nil

  defp approval_option_label?(label) when is_binary(label) do
    normalized_label =
      label
      |> String.trim()
      |> String.downcase()

    String.starts_with?(normalized_label, "approve") or String.starts_with?(normalized_label, "allow")
  end

  defp normalize_dynamic_tool_result(%{"success" => success} = result) when is_boolean(success) do
    output =
      case Map.get(result, "output") do
        existing_output when is_binary(existing_output) -> existing_output
        _ -> dynamic_tool_output(result)
      end

    content_items =
      case Map.get(result, "contentItems") do
        existing_items when is_list(existing_items) -> existing_items
        _ -> dynamic_tool_content_items(output)
      end

    result
    |> Map.put("output", output)
    |> Map.put("contentItems", content_items)
  end

  defp normalize_dynamic_tool_result(result) do
    %{
      "success" => false,
      "output" => inspect(result),
      "contentItems" => dynamic_tool_content_items(inspect(result))
    }
  end

  defp dynamic_tool_output(%{"contentItems" => [%{"text" => text} | _]}) when is_binary(text), do: text
  defp dynamic_tool_output(result), do: Jason.encode!(result, pretty: true)

  defp dynamic_tool_content_items(output) when is_binary(output) do
    [
      %{
        "type" => "inputText",
        "text" => output
      }
    ]
  end

  defp tool_call_name(params) when is_map(params) do
    case Map.get(params, "tool") || Map.get(params, :tool) || Map.get(params, "name") || Map.get(params, :name) do
      name when is_binary(name) ->
        case String.trim(name) do
          "" -> nil
          trimmed -> trimmed
        end

      _ ->
        nil
    end
  end

  defp tool_call_name(_params), do: nil

  defp tool_call_arguments(params) when is_map(params) do
    Map.get(params, "arguments") || Map.get(params, :arguments) || %{}
  end

  defp tool_call_arguments(_params), do: %{}

  defp tool_log_fields(metadata, tool_call_id, tool_name, result \\ nil) do
    metadata
    |> Map.take([:trace_id, :run_id, :turn_id, :session_key, :worker_host, :codex_app_server_pid])
    |> Map.merge(%{
      tool_call_id: tool_call_id,
      tool_name: tool_name,
      success: tool_result_success(result)
    })
  end

  defp tool_result_success(nil), do: nil
  defp tool_result_success(%{"success" => success}) when is_boolean(success), do: success
  defp tool_result_success(_result), do: false

  defp tool_log_level(:tool_call_completed), do: :info
  defp tool_log_level(_event), do: :warning

  defp emit_message(on_message, event, details, metadata) when is_function(on_message, 1) do
    message =
      metadata
      |> Map.merge(details)
      |> Map.put(:event, event)
      |> Map.put(:timestamp, DateTime.utc_now())

    on_message.(message)
  end
end
