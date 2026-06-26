defmodule SymphonyElixirWeb.AgentLiveIoController do
  @moduledoc """
  HTTP live agent I/O endpoint surface.
  """

  use Phoenix.Controller, formats: [:json]

  alias SymphonyElixir.AgentLiveIo
  alias SymphonyElixir.Gateway.SharedSessionKey
  alias SymphonyElixirWeb.Gateway.Middleware

  @stream_heartbeat_ms 30_000

  @spec input(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def input(conn, %{"id" => agent_id}) do
    params = conn.body_params

    with {:ok, scope} <- scope(agent_id, params),
         {:ok, message} <- required_string(params, "message"),
         {:ok, run_id} <- AgentLiveIo.post_message(scope, message, metadata: metadata(params), trace_id: trace_id(conn)) do
      conn
      |> put_status(202)
      |> json(%{
        accepted: true,
        agentId: scope.agent_id,
        workspaceId: scope.workspace_id,
        sessionKey: scope.session_key,
        turnId: run_id
      })
    else
      {:error, reason} -> error(conn, reason)
    end
  end

  def input(conn, _params), do: error(conn, :agent_not_found)

  @spec interrupt(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def interrupt(conn, %{"id" => agent_id}) do
    params = conn.body_params

    with {:ok, scope} <- scope(agent_id, params),
         {:ok, event} <- AgentLiveIo.interrupt(scope, string_field(params, "turn_id")) do
      conn
      |> put_status(202)
      |> json(%{
        interrupted: true,
        agentId: scope.agent_id,
        workspaceId: scope.workspace_id,
        sessionKey: scope.session_key,
        turnId: Map.get(event, "turnId")
      })
    else
      {:error, reason} -> error(conn, reason)
    end
  end

  def interrupt(conn, _params), do: error(conn, :agent_not_found)

  @spec stream(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def stream(conn, %{"id" => agent_id}) do
    conn = fetch_query_params(conn)

    params =
      conn.query_params
      |> Map.put("agent_id", agent_id)
      |> Map.put_new("user_id", Map.get(conn.query_params, "user_id"))

    with {:ok, scope} <- scope(agent_id, params),
         :ok <- AgentLiveIo.subscribe(scope) do
      conn =
        conn
        |> put_resp_content_type("text/event-stream")
        |> put_resp_header("cache-control", "no-cache")
        |> send_chunked(200)

      {:ok, conn} = chunk(conn, ": connected\n\n")
      stream_loop(conn, scope)
    else
      {:error, reason} -> error(conn, reason)
    end
  end

  def stream(conn, _params), do: error(conn, :agent_not_found)

  defp stream_loop(conn, %{session_key: session_key} = scope) do
    receive do
      {:agent_live_io_event, ^session_key, event} ->
        case chunk(conn, "data: #{Jason.encode!(event)}\n\n") do
          {:ok, conn} -> stream_loop(conn, scope)
          {:error, _reason} -> AgentLiveIo.unsubscribe(session_key)
        end

      {:agent_io_event, ^session_key, event} ->
        with public_event when is_map(public_event) <- AgentLiveIo.stream_event(scope, event) do
          case chunk(conn, "data: #{Jason.encode!(public_event)}\n\n") do
            {:ok, conn} -> stream_loop(conn, scope)
            {:error, _reason} -> :ok
          end
        else
          _ -> stream_loop(conn, scope)
        end

      {:agent_io_event, _other_session_key, _event} ->
        stream_loop(conn, scope)

      {:agent_live_io_event, _other_session_key, _event} ->
        stream_loop(conn, scope)

      {:DOWN, _ref, :process, _pid, _reason} ->
        stream_loop(conn, scope)

      _message ->
        stream_loop(conn, scope)
    after
      @stream_heartbeat_ms ->
        case chunk(conn, ": heartbeat\n\n") do
          {:ok, conn} -> stream_loop(conn, scope)
          {:error, _reason} -> AgentLiveIo.unsubscribe(session_key)
        end
    end
  end

  defp scope(agent_id, params) do
    with {:ok, workspace_id} <- required_string(params, "workspace_id"),
         {:ok, user_id} <- required_string(params, "user_id") do
      {:ok,
       %{
         agent_id: agent_id,
         workspace_id: workspace_id,
         user_id: user_id,
         session_key: string_field(params, "session_key") || SharedSessionKey.for_agent(workspace_id, agent_id)
       }}
    end
  end

  defp required_string(params, key) do
    case string_field(params, key) do
      value when is_binary(value) -> {:ok, value}
      nil -> {:error, {:missing_argument, key}}
    end
  end

  defp string_field(params, key) do
    case Map.get(params, key) || Map.get(params, camel_key(key)) do
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: nil, else: value

      _ ->
        nil
    end
  end

  defp metadata(%{"metadata" => metadata}) when is_map(metadata), do: metadata
  defp metadata(_params), do: %{}

  defp camel_key("workspace_id"), do: "workspaceId"
  defp camel_key("session_key"), do: "sessionKey"
  defp camel_key("turn_id"), do: "turnId"
  defp camel_key("user_id"), do: "userId"
  defp camel_key(key), do: key

  defp trace_id(conn), do: List.first(get_req_header(conn, "x-trace-id"))

  defp error(conn, {:missing_argument, field}) do
    conn
    |> put_status(400)
    |> json(%{error: %{code: "invalid_request", message: "#{field} is required"}})
  end

  defp error(conn, reason) do
    normalized = Middleware.normalize_error(reason)

    conn
    |> put_status(status_for(normalized.code))
    |> json(%{error: normalized})
  end

  defp status_for("agent_not_found"), do: 404
  defp status_for("session_not_found"), do: 404
  defp status_for("rate_limited"), do: 409
  defp status_for(_code), do: 502
end
