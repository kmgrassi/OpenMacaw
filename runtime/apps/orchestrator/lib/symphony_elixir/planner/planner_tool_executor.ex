defmodule SymphonyElixir.Planner.PlannerToolExecutor do
  @moduledoc """
  Executes planner tools through the registry, with DynamicTool fallback.
  """

  alias SymphonyElixir.{Codex.DynamicTool, ToolExecutionContext, ToolRegistry}

  @database_tools [
    "plan.create",
    "plan.update",
    "plan.delete",
    "task.create",
    "task.update",
    "task.schedule",
    "agent_tool_grant.create",
    "agent_tool_grant.update",
    "scheduled_task.create",
    "scheduled_task.read",
    "scheduled_task.update",
    "scheduled_task.list",
    "scheduled_task.delete",
    "plan.read",
    "task.read",
    "task.status",
    "snooze_work_item"
  ]

  @spec decode_arguments(binary() | map() | term()) :: map() | binary()
  def decode_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> arguments
    end
  end

  def decode_arguments(arguments) when is_map(arguments), do: arguments
  def decode_arguments(_arguments), do: %{}

  @spec maybe_put_workspace_id(map() | term(), String.t() | term(), map()) :: map() | term()
  def maybe_put_workspace_id(arguments, tool, %{workspace_id: workspace_id})
      when is_map(arguments) and is_binary(workspace_id) do
    if database_tool?(tool), do: Map.put(arguments, "workspace_id", workspace_id), else: arguments
  end

  def maybe_put_workspace_id(arguments, _tool, _session), do: arguments

  @spec execute(map(), String.t() | term(), map() | term()) :: map()
  def execute(session, tool, arguments) do
    if use_tool_registry?() do
      execute_registry_tool(session, tool, arguments)
    else
      execute_dynamic_tool(session, tool, arguments)
    end
  end

  @spec database_tool?(String.t() | term()) :: boolean()
  def database_tool?(tool) when is_binary(tool), do: tool in @database_tools
  def database_tool?(_tool), do: false

  defp execute_registry_tool(session, tool, arguments) do
    context =
      %{
        agent_id: Map.get(session, :agent_id),
        default_repository: Map.get(session, :default_repository),
        default_runner_kind: Map.get(session, :default_runner_kind),
        planner_state: Map.get(session, :state),
        repository: Map.get(session, :repository),
        workspace: Map.get(session, :workspace),
        workspace_id: Map.get(session, :workspace_id),
        workspace_root: Map.get(session, :workspace_root)
      }
      |> compact_context()
      |> ToolExecutionContext.normalize()

    case registry_execute(tool, arguments, context, Map.get(session, :tool_names, [])) do
      {:ok, %{output: output}} ->
        dynamic_tool_response(true, encode_payload(output))

      {:error, :unknown_tool} ->
        execute_dynamic_tool(session, tool, arguments)

      {:error, :not_allowed} ->
        failure_response(%{
          "error" => %{
            "message" => "Dynamic tool #{inspect(tool)} is not allowed by this agent's tool policy.",
            "supportedTools" => Map.get(session, :tool_names, [])
          }
        })

      {:error, {:validation_failed, validation_feedback}} ->
        failure_response(%{
          "error" => %{
            "message" => "#{tool} failed validation.",
            "validation_feedback" => List.wrap(validation_feedback)
          }
        })

      {:error, reason} ->
        failure_response(%{
          "error" => %{
            "message" => "#{tool} failed.",
            "reason" => inspect(reason)
          }
        })
    end
  end

  defp registry_execute(_tool, arguments, _context, _allowed) when not is_map(arguments),
    do: {:error, :invalid_arguments}

  defp registry_execute(tool, arguments, context, allowed),
    do: ToolRegistry.execute(tool, arguments, context, allowed)

  defp execute_dynamic_tool(session, tool, arguments) do
    DynamicTool.execute(tool, arguments,
      allowed_tools: Map.get(session, :tool_names, []),
      agent_id: Map.get(session, :agent_id),
      default_repository: Map.get(session, :default_repository),
      default_runner_kind: Map.get(session, :default_runner_kind),
      planner_state: Map.get(session, :state),
      repository: Map.get(session, :repository),
      workspace: Map.get(session, :workspace),
      workspace_id: Map.get(session, :workspace_id),
      workspace_root: Map.get(session, :workspace_root)
    )
  end

  defp use_tool_registry?, do: System.get_env("USE_TOOL_REGISTRY", "1") != "0"

  defp compact_context(context) do
    Map.reject(context, fn {_key, value} -> value in [nil, ""] end)
  end

  defp failure_response(payload), do: dynamic_tool_response(false, encode_payload(payload))

  defp dynamic_tool_response(success, output) when is_boolean(success) and is_binary(output) do
    %{
      "success" => success,
      "output" => output,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => output
        }
      ]
    }
  end

  defp encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  defp encode_payload(payload), do: inspect(payload)
end
