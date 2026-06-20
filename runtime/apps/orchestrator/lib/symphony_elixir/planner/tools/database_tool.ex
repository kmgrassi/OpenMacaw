defmodule SymphonyElixir.Planner.Tools.DatabaseTool do
  @moduledoc false

  defmacro __using__(tool_name: tool_name) do
    quote do
      @behaviour SymphonyElixir.Tool

      alias SymphonyElixir.Planner.DatabaseTools
      alias SymphonyElixir.Planner.Tools.Context

      @tool_name unquote(tool_name)

      @impl true
      def name, do: @tool_name

      @impl true
      def description, do: DatabaseTools.tool_spec(@tool_name)["description"]

      @impl true
      def parameters_schema, do: DatabaseTools.tool_spec(@tool_name)["inputSchema"]

      @impl true
      def bundle, do: :planner

      @impl true
      def execution_kind, do: :runtime

      @impl true
      def execute(arguments, context) when is_map(arguments) and is_map(context) do
        DatabaseTools.execute(@tool_name, arguments, Context.to_opts(context))
      end

      defoverridable bundle: 0
    end
  end
end
