defmodule SymphonyElixir.Codex.LegacyDynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.{AgentCommunicationTools, WorkItemSnooze}
  alias SymphonyElixir.Linear.Client
  alias SymphonyElixir.PlanningProfile
  alias SymphonyElixir.Planner.DatabaseTools

  @linear_graphql_tool "linear_graphql"
  @snooze_work_item_tool "snooze_work_item"
  @agent_communication_tool_names AgentCommunicationTools.tool_names()
  @planner_tool_names DatabaseTools.tool_names()
  @planning_profile_tool_names PlanningProfile.tool_names()
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    allowed_tools = Keyword.get(opts, :allowed_tools)

    if is_list(allowed_tools) and tool not in allowed_tools and known_tool?(tool) do
      policy_rejection_response(tool, allowed_tools)
    else
      execute_supported_tool(tool, arguments, opts, allowed_tools)
    end
  end

  defp execute_supported_tool(tool, arguments, opts, allowed_tools) do
    case tool do
      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      @snooze_work_item_tool ->
        execute_snooze_work_item(arguments, opts)

      planner_tool when planner_tool in @planner_tool_names ->
        execute_planner_database_tool(planner_tool, arguments, opts)

      planning_profile_tool when planning_profile_tool in @planning_profile_tool_names ->
        execute_planning_profile_tool(planning_profile_tool, arguments, opts)

      agent_communication_tool when agent_communication_tool in @agent_communication_tool_names ->
        execute_agent_communication_tool(agent_communication_tool, arguments, opts)

      other ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(other)}.",
            "supportedTools" => supported_tool_names(allowed_tools)
          }
        })
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs, do: coding_tool_specs()

  @spec coding_tool_specs() :: [map()]
  def coding_tool_specs do
    [
      %{
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      },
      WorkItemSnooze.tool_spec()
    ]
  end

  @spec universal_tool_specs() :: [map()]
  def universal_tool_specs, do: [WorkItemSnooze.tool_spec()]

  defp execute_planner_database_tool(tool, arguments, opts) do
    case DatabaseTools.execute(tool, arguments, opts) do
      {:ok, response} -> dynamic_tool_response(true, encode_payload(response))
      {:error, reason} -> failure_response(planner_database_tool_error_payload(tool, reason))
    end
  end

  @spec planner_tool_specs() :: [map()]
  def planner_tool_specs,
    do: DatabaseTools.tool_specs() ++ PlanningProfile.tool_specs() ++ universal_tool_specs()

  @spec agent_communication_tool_specs() :: [map()]
  def agent_communication_tool_specs, do: AgentCommunicationTools.tool_specs()

  defp execute_agent_communication_tool(tool, arguments, opts) do
    case AgentCommunicationTools.execute(tool, arguments, opts) do
      {:ok, response} -> dynamic_tool_response(true, encode_payload(response))
      {:error, reason} -> failure_response(agent_communication_tool_error_payload(tool, reason))
    end
  end

  defp execute_planning_profile_tool(tool, arguments, opts) do
    case PlanningProfile.execute(tool, arguments, opts) do
      {:ok, response} -> dynamic_tool_response(true, encode_payload(response))
      {:error, reason} -> failure_response(planning_profile_tool_error_payload(tool, reason))
    end
  end

  defp execute_snooze_work_item(arguments, opts) do
    context = %{
      actor: Keyword.get(opts, :actor),
      agent_id: Keyword.get(opts, :agent_id),
      workspace_id: Keyword.get(opts, :workspace_id),
      config: Keyword.get(opts, :config),
      req_options: Keyword.get(opts, :req_options)
    }

    case WorkItemSnooze.snooze(arguments, context) do
      {:ok, response} -> dynamic_tool_response(true, encode_payload(response))
      {:error, reason} -> failure_response(snooze_work_item_error_payload(reason))
    end
  end

  defp execute_linear_graphql(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, query, variables} <- normalize_linear_graphql_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, []) do
      graphql_response(response)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    case normalize_query(arguments) do
      {:ok, query} ->
        case normalize_variables(arguments) do
          {:ok, variables} ->
            {:ok, query, variables}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_response(response) do
    success =
      case response do
        %{"errors" => errors} when is_list(errors) and errors != [] -> false
        %{errors: errors} when is_list(errors) and errors != [] -> false
        _ -> true
      end

    dynamic_tool_response(success, encode_payload(response))
  end

  defp failure_response(payload) do
    dynamic_tool_response(false, encode_payload(payload))
  end

  defp policy_rejection_response(tool, allowed_tools) do
    failure_response(%{
      "error" => %{
        "message" => "Dynamic tool #{inspect(tool)} is not allowed by this agent's tool policy.",
        "supportedTools" => allowed_tools
      }
    })
  end

  defp known_tool?(tool) do
    tool in [
      @linear_graphql_tool
      | @planner_tool_names ++
          @planning_profile_tool_names ++
          @agent_communication_tool_names ++ [@snooze_work_item_tool]
    ]
  end

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

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp supported_tool_names(allowed_tools) when is_list(allowed_tools), do: allowed_tools

  defp supported_tool_names(_allowed_tools) do
    Enum.map(tool_specs(), & &1["name"])
  end

  defp planner_database_tool_error_payload(tool, {:validation_failed, validation_feedback}) do
    %{
      "error" => %{
        "message" => "#{tool} failed validation.",
        "validation_feedback" => List.wrap(validation_feedback)
      }
    }
  end

  defp planner_database_tool_error_payload(tool, reason) do
    %{
      "error" => %{
        "message" => "#{tool} failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp agent_communication_tool_error_payload(tool, reason) do
    %{
      "error" => %{
        "message" => "#{tool} failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp snooze_work_item_error_payload(reason) do
    %{
      "error" => %{
        "message" => "snooze_work_item failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp planning_profile_tool_error_payload(tool, reason) do
    %{
      "error" => %{
        "message" => "Planning profile tool execution failed.",
        "tool" => tool,
        "reason" => inspect(reason)
      }
    }
  end
end
