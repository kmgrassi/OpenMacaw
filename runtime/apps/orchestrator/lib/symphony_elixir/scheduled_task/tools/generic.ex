defmodule SymphonyElixir.ScheduledTask.Tools.Generic do
  @moduledoc false

  defmacro __using__(tool_name: tool_name) do
    quote do
      @behaviour SymphonyElixir.Tool

      alias SymphonyElixir.ScheduledTask.Tools

      @tool_name unquote(tool_name)

      @impl true
      def name, do: @tool_name

      @impl true
      def description, do: Tools.tool_spec(@tool_name)["description"]

      @impl true
      def parameters_schema, do: Tools.tool_spec(@tool_name)["inputSchema"]

      @impl true
      def bundle, do: [:scheduled_task, :planner, :manager]
      defoverridable bundle: 0

      @impl true
      def execution_kind, do: :runtime

      @impl true
      def execute(arguments, context) when is_map(arguments) and is_map(context) do
        opts =
          context
          |> Enum.filter(fn {key, _value} -> is_atom(key) end)
          |> Keyword.new()
          |> put_context_default(:workspace_id, context_value(context, :workspace_id))
          |> put_context_default(:agent_id, context_value(context, :agent_id))
          |> put_context_option(:repository, context_value(context, :repository))

        Tools.execute(@tool_name, arguments, opts)
      end

      defp context_value(context, key) do
        session = Map.get(context, :session) || Map.get(context, "session") || %{}

        Map.get(context, key) || Map.get(context, to_string(key)) || Map.get(session, key) ||
          Map.get(session, to_string(key))
      end

      defp put_context_default(opts, key, value) when is_binary(value) and value != "" do
        Keyword.put_new(opts, key, value)
      end

      defp put_context_default(opts, _key, _value), do: opts

      defp put_context_option(opts, key, value) when not is_nil(value), do: Keyword.put_new(opts, key, value)
      defp put_context_option(opts, _key, _value), do: opts
    end
  end
end
