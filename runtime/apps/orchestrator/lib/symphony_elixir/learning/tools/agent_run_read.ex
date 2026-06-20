defmodule SymphonyElixir.Learning.Tools.AgentRunRead do
  @moduledoc false

  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.{PostgRESTClient, Supabase}

  @impl true
  def name, do: "agent_run.read"

  @impl true
  def description do
    "Read messages and tool-call events for another run in the current workspace. Restricted to learning agents."
  end

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "properties" => %{
        "run_id" => %{"type" => "string", "description" => "The run_id to inspect."},
        "message_limit" => %{"type" => "integer", "minimum" => 1, "maximum" => 100},
        "tool_event_limit" => %{"type" => "integer", "minimum" => 1, "maximum" => 200},
        "include_tool_events" => %{"type" => "boolean"}
      },
      "required" => ["run_id"],
      "additionalProperties" => false
    }
  end

  @impl true
  def bundle, do: :learning

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, context) when is_map(arguments) and is_map(context) do
    with {:ok, workspace_id} <- context_string(context, "workspace_id"),
         {:ok, observer_agent_id} <- context_string(context, "agent_id"),
         :ok <- authorize_learning_agent(workspace_id, observer_agent_id),
         {:ok, run_id} <- argument_string(arguments, "run_id"),
         {:ok, run} <- fetch_run(workspace_id, run_id),
         {:ok, messages} <- fetch_messages(workspace_id, run_id, int_arg(arguments, "message_limit", 10, 100)),
         {:ok, tool_events} <- maybe_fetch_tool_events(workspace_id, run_id, arguments) do
      {:ok,
       %{
         "run" => run,
         "messages" => messages,
         "toolEvents" => tool_events,
         "messageCount" => length(messages),
         "toolEventCount" => length(tool_events)
       }}
    end
  end

  def execute(_arguments, _context), do: {:error, :invalid_arguments}

  defp authorize_learning_agent(workspace_id, agent_id) do
    query = %{
      "id" => "eq.#{agent_id}",
      "workspace_id" => "eq.#{workspace_id}",
      "select" => "id,type",
      "limit" => "1"
    }

    case PostgRESTClient.get(client(), "agent", query, log_metadata: %{caller: "agent_run.read.agent"}) do
      {:ok, [%{"type" => "learning"}]} -> :ok
      {:ok, [_agent]} -> {:error, :learning_agent_required}
      {:ok, []} -> {:error, :agent_not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  defp fetch_run(workspace_id, run_id) do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "run_id" => "eq.#{run_id}",
      "select" => "run_id,agent_id,workspace_id,status,started_at,completed_at,created_at,updated_at,error,terminal_reason",
      "limit" => "1"
    }

    case PostgRESTClient.get(client(), "broker_run", query, log_metadata: %{caller: "agent_run.read.run"}) do
      {:ok, [run]} -> {:ok, run}
      {:ok, []} -> {:error, :run_not_found}
      {:error, reason} -> {:error, reason}
    end
  end

  defp fetch_messages(workspace_id, run_id, limit) do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "run_id" => "eq.#{run_id}",
      "select" => "id,role,content,created_at,metadata,run_id,session_id,user_id,agent_id,workspace_id,message_type",
      "order" => "created_at.asc",
      "limit" => Integer.to_string(limit)
    }

    case PostgRESTClient.get(client(), "message", query, log_metadata: %{caller: "agent_run.read.messages"}) do
      {:ok, rows} when is_list(rows) -> {:ok, rows}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_fetch_tool_events(_workspace_id, _run_id, %{"include_tool_events" => false}), do: {:ok, []}

  defp maybe_fetch_tool_events(workspace_id, run_id, arguments) do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "run_id" => "eq.#{run_id}",
      "select" => "id,run_id,sequence,event_type,message_kind,tool_slug,status,approval_state,arguments,result,output_summary,error_code,error_message,created_at",
      "order" => "sequence.asc,created_at.asc",
      "limit" => Integer.to_string(int_arg(arguments, "tool_event_limit", 50, 200))
    }

    case PostgRESTClient.get(client(), "agent_tool_call_event", query, log_metadata: %{caller: "agent_run.read.tool_events"}) do
      {:ok, rows} when is_list(rows) -> {:ok, rows}
      {:error, reason} -> {:error, reason}
    end
  end

  defp context_string(context, key) do
    case Map.get(context, key) || Map.get(context, String.to_atom(key)) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :runtime_context_required}
    end
  end

  defp argument_string(arguments, key) do
    case Map.get(arguments, key) || Map.get(arguments, String.to_atom(key)) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, :invalid_arguments}
    end
  end

  defp int_arg(arguments, key, fallback, max) do
    case Map.get(arguments, key) || Map.get(arguments, String.to_atom(key)) do
      value when is_integer(value) and value > 0 -> min(value, max)
      _ -> fallback
    end
  end

  defp client do
    :symphony_elixir
    |> Application.get_env(:learning_agent_run_read_db, [])
    |> Supabase.merge_connection!()
    |> PostgRESTClient.new(req_options())
  end

  defp req_options, do: Application.get_env(:symphony_elixir, :learning_agent_run_read_req_options, [])
end
