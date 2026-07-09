defmodule SymphonyElixir.Runner.LlmToolRunner.ToolExecutor do
  @moduledoc false

  alias SymphonyElixir.LocalRelay.Registry, as: LocalRelayRegistry
  alias SymphonyElixir.Runner.LlmToolRunner.SessionConfig
  alias SymphonyElixir.{ToolExecutionContext, ToolRegistry}

  @spec execute(String.t(), map(), map(), String.t() | nil, String.t() | nil) :: map()
  def execute(tool, arguments, session, tool_call_id, correlation_id)
      when is_binary(correlation_id) and is_binary(tool_call_id) do
    if helper_executed_tool?(tool, session) do
      delegate_tool_to_helper(tool, arguments, tool_call_id, correlation_id, session)
    else
      execute_runtime_tool(tool, arguments, session)
    end
  end

  def execute(tool, arguments, session, _tool_call_id, _correlation_id) do
    execute_runtime_tool(tool, arguments, session)
  end

  defp helper_executed_tool?(tool, session) do
    session
    |> Map.get(:tool_specs, [])
    |> Enum.any?(fn definition ->
      is_map(definition) and tool_spec_name(definition) == tool and
        (Map.get(definition, "execution_kind") || Map.get(definition, :execution_kind)) ==
          "helper"
    end)
  end

  defp delegate_tool_to_helper(tool, arguments, tool_call_id, correlation_id, session) do
    timeout_ms = SessionConfig.config_integer(session, "tool_execution_timeout_ms", 120_000)

    frame = %{
      "type" => "tool_execution_request",
      "correlation_id" => correlation_id,
      "tool_call_id" => tool_call_id,
      "name" => tool,
      "arguments" => arguments,
      "execution_kind" => "helper",
      "timeout_ms" => timeout_ms,
      "context" => tool_execution_context(session)
    }

    case LocalRelayRegistry.send_tool_execution_request(correlation_id, frame) do
      :ok -> await_helper_tool_result(tool, correlation_id, tool_call_id, timeout_ms)
      {:error, reason} -> helper_tool_error(tool, reason)
    end
  end

  defp await_helper_tool_result(tool, correlation_id, tool_call_id, timeout_ms) do
    receive do
      {:local_relay_tool_call_result, ^correlation_id, %{"tool_call_id" => ^tool_call_id} = frame} ->
        normalize_helper_tool_result(frame)
    after
      timeout_ms -> helper_tool_error(tool, :tool_execution_timeout)
    end
  end

  defp normalize_helper_tool_result(frame) do
    success? = Map.get(frame, "success") != false
    output = Map.get(frame, "output")

    %{
      "success" => success?,
      "output" => encode_tool_output(output)
    }
    |> maybe_put_payload_field("error", unless(success?, do: "helper_tool_failed"))
  end

  defp helper_tool_error(tool, reason) do
    %{
      "success" => false,
      "error" => error_code(reason),
      "output" =>
        Jason.encode!(%{
          "error" => "helper_tool_failed",
          "tool" => tool,
          "reason" => inspect(reason)
        })
    }
  end

  defp execute_runtime_tool(tool, arguments, session) do
    context =
      session
      |> tool_execution_context()
      |> Map.put("session", session)

    case ToolRegistry.execute(tool, arguments, context, Map.get(session, :allowed_tools, [])) do
      {:ok, %{output: output} = result} ->
        %{
          "success" => true,
          "output" => output
        }
        |> maybe_put_payload_field("usage", Map.get(result, :usage))
        |> maybe_put_payload_field("metadata", Map.get(result, :metadata))

      {:error, %{"success" => false} = result} ->
        result

      {:error, reason} ->
        error = error_code(reason)

        %{
          "success" => false,
          "error" => error,
          "output" => Jason.encode!(%{"error" => error, "reason" => inspect(reason)})
        }
    end
  end

  defp tool_execution_context(session), do: ToolExecutionContext.from_session(session)

  defp encode_tool_output(output) when is_binary(output), do: output

  defp encode_tool_output(output) when is_map(output) or is_list(output),
    do: Jason.encode!(output)

  defp encode_tool_output(nil), do: ""
  defp encode_tool_output(output), do: to_string(output)

  defp error_code(:not_allowed), do: "not_allowed"
  defp error_code(:unknown_tool), do: "unknown_tool"
  defp error_code(reason) when is_binary(reason), do: reason
  defp error_code(_reason), do: "tool_error"

  defp maybe_put_payload_field(map, _key, nil), do: map
  defp maybe_put_payload_field(map, key, value), do: Map.put(map, key, value)

  defp tool_spec_name(definition) do
    Map.get(definition, "name") || Map.get(definition, :name) ||
      Map.get(definition, "slug") || Map.get(definition, :slug)
  end
end
