defmodule SymphonyElixir.ToolExecutionContext do
  @moduledoc """
  Canonical execution context supplied to every runtime-dispatched tool call.

  Tool arguments are model-authored. This context is runtime-authored and travels
  out-of-band so tools can enforce workspace, agent, user, session, and request
  boundaries without trusting model-provided identifiers.
  """

  @type t :: map()

  @known_context_fields %{
    agent_id: "agent_id",
    workspace_id: "workspace_id",
    user_id: "user_id",
    session_id: "session_id",
    request_id: "request_id",
    trace_id: "trace_id",
    work_item_id: "work_item_id",
    run_id: "run_id",
    workspace_root: "workspace_root"
  }

  @declared_argument_fields %{
    "agentId" => "agent_id",
    "agent_id" => "agent_id",
    "workspaceId" => "workspace_id",
    "workspace_id" => "workspace_id",
    "userId" => "user_id",
    "user_id" => "user_id",
    "sessionId" => "session_id",
    "session_id" => "session_id",
    "requestId" => "request_id",
    "request_id" => "request_id",
    "traceId" => "trace_id",
    "trace_id" => "trace_id"
  }

  @spec normalize(map() | nil) :: t()
  def normalize(context) when is_map(context) do
    context
    |> Enum.reduce(%{}, fn {key, value}, acc ->
      case normalize_key(key) do
        "metadata" ->
          put_metadata(acc, value)

        normalized_key when is_binary(normalized_key) ->
          put_present(acc, normalized_key, value)

        nil ->
          acc
      end
    end)
  end

  def normalize(_context), do: %{}

  @spec from_session(map(), map() | nil) :: t()
  def from_session(session, extra \\ %{}) when is_map(session) do
    session_context =
      %{
        agent_id: session_value(session, :agent_id),
        workspace_id: session_value(session, :workspace_id),
        user_id: session_value(session, :user_id),
        session_id: session_value(session, :session_id) || get_in(session, [:dispatch_frame, "session_id"]),
        request_id: session_value(session, :request_id),
        trace_id: session_value(session, :trace_id),
        run_id: session_value(session, :run_id)
      }

    Map.merge(normalize(session_context), normalize(extra || %{}))
  end

  @spec inject_arguments(map(), map() | nil, t()) :: map()
  def inject_arguments(arguments, tool, context) when is_map(arguments) and is_map(context) do
    declared_properties = tool |> parameter_properties() |> MapSet.new()

    Enum.reduce(@declared_argument_fields, arguments, fn {argument_key, context_key}, acc ->
      put_declared_context(acc, declared_properties, argument_key, Map.get(context, context_key))
    end)
  end

  def inject_arguments(arguments, _tool, _context), do: arguments

  defp normalize_key(key) when is_atom(key), do: Map.get(@known_context_fields, key) || Atom.to_string(key)

  defp normalize_key(key) when is_binary(key) do
    cond do
      key in Map.values(@known_context_fields) -> key
      key == "agentId" -> "agent_id"
      key == "workspaceId" -> "workspace_id"
      key == "userId" -> "user_id"
      key == "sessionId" -> "session_id"
      key == "requestId" -> "request_id"
      key == "traceId" -> "trace_id"
      key == "workItemId" -> "work_item_id"
      key == "runId" -> "run_id"
      key == "workspaceRoot" -> "workspace_root"
      key == "metadata" -> "metadata"
      true -> key
    end
  end

  defp normalize_key(_key), do: nil

  defp put_present(acc, _key, value) when is_nil(value), do: acc
  defp put_present(acc, _key, value) when value == "", do: acc
  defp put_present(acc, key, value), do: Map.put(acc, key, value)

  defp put_metadata(acc, value) when is_map(value) and map_size(value) > 0, do: Map.put(acc, "metadata", value)
  defp put_metadata(acc, _value), do: acc

  defp session_value(session, key) do
    metadata = Map.get(session, :metadata) || Map.get(session, "metadata") || %{}
    profile = Map.get(session, :execution_profile) || Map.get(session, "execution_profile") || %{}

    Map.get(session, key) || Map.get(session, Atom.to_string(key)) ||
      Map.get(metadata, key) || Map.get(metadata, Atom.to_string(key)) ||
      Map.get(profile, key) || Map.get(profile, Atom.to_string(key))
  end

  defp put_declared_context(arguments, declared_properties, key, value) do
    cond do
      is_nil(value) -> arguments
      !MapSet.member?(declared_properties, key) -> arguments
      Map.has_key?(arguments, key) -> arguments
      true -> Map.put(arguments, key, value)
    end
  end

  defp parameter_properties(tool) when is_map(tool) do
    parameters = map_value(tool, :parameters_schema) || map_value(tool, :parameters) || %{}

    case map_value(parameters, :properties) do
      properties when is_map(properties) -> Map.keys(properties)
      _ -> []
    end
  end

  defp parameter_properties(_tool), do: []

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
end
