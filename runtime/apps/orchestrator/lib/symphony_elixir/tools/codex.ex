defmodule SymphonyElixir.Tools.Codex.Helpers do
  @moduledoc false

  def spec_for(specs, name) do
    Enum.find(specs, &(&1["name"] == name)) || raise ArgumentError, "missing tool spec for #{name}"
  end

  def description(specs, name), do: spec_for(specs, name)["description"]
  def schema(specs, name), do: spec_for(specs, name)["inputSchema"]

  def context_opts(context) when is_map(context) do
    context
    |> Enum.map(fn
      {key, value} when is_binary(key) -> {String.to_atom(key), value}
      {key, value} when is_atom(key) -> {key, value}
    end)
  end
end

defmodule SymphonyElixir.Tools.Codex.LinearGraphQL do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Linear.Client

  @name "linear_graphql"
  @description "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth."
  @schema %{
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

  def name, do: @name
  def description, do: @description
  def parameters_schema, do: @schema
  def bundle, do: :codex_coding
  def execution_kind, do: :external

  def execute(arguments, context) do
    linear_client = Map.get(context, :linear_client) || Map.get(context, "linear_client") || (&Client.graphql/3)

    with {:ok, query, variables} <- normalize_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, []) do
      {:ok, response}
    end
  end

  defp normalize_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_arguments(arguments) when is_map(arguments) do
    with {:ok, query} <- normalize_query(arguments),
         {:ok, variables} <- normalize_variables(arguments) do
      {:ok, query, variables}
    end
  end

  defp normalize_arguments(_arguments), do: {:error, :invalid_arguments}

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
end

defmodule SymphonyElixir.Tools.Codex.SnoozeWorkItem do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.WorkItemSnooze

  def name, do: "snooze_work_item"
  def description, do: WorkItemSnooze.tool_spec()["description"]
  def parameters_schema, do: WorkItemSnooze.tool_spec()["inputSchema"]
  def bundle, do: [:coding, :universal]
  def execution_kind, do: :runtime
  def execute(arguments, context), do: WorkItemSnooze.snooze(arguments, context)
end

defmodule SymphonyElixir.Tools.Codex.WrappedTool do
  @moduledoc false

  defmacro __using__(opts) do
    quote bind_quoted: [opts: opts] do
      @behaviour SymphonyElixir.Tool

      alias SymphonyElixir.Tools.Codex.Helpers

      @name Keyword.fetch!(opts, :name)
      @source Keyword.fetch!(opts, :source)
      @bundle Keyword.fetch!(opts, :bundle)
      @execution_kind Keyword.get(opts, :execution_kind, :runtime)

      def name, do: @name
      def description, do: Helpers.description(@source.tool_specs(), @name)
      def parameters_schema, do: Helpers.schema(@source.tool_specs(), @name)
      def bundle, do: @bundle
      def execution_kind, do: @execution_kind

      def execute(arguments, context),
        do: @source.execute(@name, arguments, Helpers.context_opts(context))
    end
  end
end

defmodule SymphonyElixir.Tools.Codex.PlanCreate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "plan.create",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.PlanUpdate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "plan.update",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.PlanDelete do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "plan.delete",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.TaskCreate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "task.create",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.TaskUpdate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "task.update",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.TaskSchedule do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "task.schedule",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.PlanRead do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "plan.read",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.TaskRead do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "task.read",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.TaskStatus do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "task.status",
    source: SymphonyElixir.Planner.DatabaseTools,
    bundle: :planner
end

defmodule SymphonyElixir.Tools.Codex.PlanningProfileCreateUpdate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "planning_profile.create_update",
    source: SymphonyElixir.PlanningProfile,
    bundle: :planning_profile
end

defmodule SymphonyElixir.Tools.Codex.PlanningProfileDelete do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "planning_profile.delete",
    source: SymphonyElixir.PlanningProfile,
    bundle: :planning_profile
end

defmodule SymphonyElixir.Tools.Codex.AgentMessage do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "agent.message",
    source: SymphonyElixir.AgentCommunicationTools,
    bundle: :agent_control
end

defmodule SymphonyElixir.Tools.Codex.AgentRemediate do
  use SymphonyElixir.Tools.Codex.WrappedTool,
    name: "agent.remediate",
    source: SymphonyElixir.AgentCommunicationTools,
    bundle: :agent_control
end
