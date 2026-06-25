defmodule SymphonyElixirWeb.CodexSessionController do
  @moduledoc """
  Protected API controls for warm Codex app-server sessions.
  """

  use Phoenix.Controller, formats: [:json]

  alias SymphonyElixir.Codex.SessionRegistry

  def create(conn, params) do
    workspace = Map.get(params, "workspace")
    runner_config = Map.get(params, "runner_config") || %{}

    cond do
      not is_binary(workspace) or String.trim(workspace) == "" ->
        error(conn, 400, "invalid_workspace", "workspace is required")

      not is_map(runner_config) ->
        error(conn, 400, "invalid_runner_config", "runner_config must be an object")

      true ->
        case SessionRegistry.create_session(workspace, runner_config) do
          {:ok, session} -> json(conn, %{ok: true, session: session})
          {:error, reason} -> error(conn, 400, "session_start_failed", inspect(reason))
        end
    end
  end

  def input(conn, %{"session_id" => session_id} = params) do
    prompt = Map.get(params, "prompt") || Map.get(params, "message")
    issue = Map.get(params, "issue") || %{}

    case SessionRegistry.send_message(session_id, prompt, issue) do
      {:ok, session} -> json(conn, %{ok: true, session: session})
      {:error, :session_not_found} -> error(conn, 404, "session_not_found", "Codex session was not found")
      {:error, :turn_already_running} -> error(conn, 409, "turn_already_running", "Codex session already has a running turn")
      {:error, reason} -> error(conn, 400, "input_failed", inspect(reason))
    end
  end

  def interrupt(conn, %{"session_id" => session_id}) do
    case SessionRegistry.interrupt(session_id) do
      {:ok, session} -> json(conn, %{ok: true, session: session})
      {:error, :session_not_found} -> error(conn, 404, "session_not_found", "Codex session was not found")
      {:error, :no_active_turn} -> error(conn, 409, "no_active_turn", "Codex session has no active turn to interrupt")
      {:error, reason} -> error(conn, 400, "interrupt_failed", inspect(reason))
    end
  end

  def delete(conn, %{"session_id" => session_id}) do
    case SessionRegistry.stop_session(session_id) do
      :ok -> json(conn, %{ok: true})
      {:error, :session_not_found} -> error(conn, 404, "session_not_found", "Codex session was not found")
      {:error, reason} -> error(conn, 400, "stop_failed", inspect(reason))
    end
  end

  defp error(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{ok: false, error: %{code: code, message: message}})
  end
end
