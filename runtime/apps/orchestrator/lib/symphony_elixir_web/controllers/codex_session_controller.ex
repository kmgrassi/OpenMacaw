defmodule SymphonyElixirWeb.CodexSessionController do
  @moduledoc """
  Protected API controls for warm Codex app-server sessions.
  """

  use Phoenix.Controller, formats: [:json]

  alias SymphonyElixir.Codex.SessionRegistry

  @allowed_runner_config_keys ~w(
    agent_id
    default_repository
    default_runner_kind
    model
    model_provider
    provider
    trace_id
    workspace_id
  )

  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def create(conn, params) do
    with {:ok, workspace} <- validate_workspace(Map.get(params, "workspace")),
         {:ok, runner_config} <- sanitize_runner_config(Map.get(params, "runner_config") || %{}) do
      case SessionRegistry.create_session(workspace, runner_config) do
        {:ok, session} -> json(conn, %{ok: true, session: session})
        {:error, reason} -> error(conn, 400, "session_start_failed", inspect(reason))
      end
    else
      {:error, {:invalid_workspace, message}} ->
        error(conn, 400, "invalid_workspace", message)

      {:error, {:invalid_runner_config, message}} ->
        error(conn, 400, "invalid_runner_config", message)
    end
  end

  @spec input(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def input(conn, %{"session_id" => session_id} = params) do
    prompt = Map.get(params, "prompt") || Map.get(params, "message")
    issue = Map.get(params, "issue") || %{}

    case SessionRegistry.send_message(session_id, prompt, issue) do
      {:ok, session} ->
        json(conn, %{ok: true, session: session})

      {:error, :session_not_found} ->
        error(conn, 404, "session_not_found", "Codex session was not found")

      {:error, :turn_already_running} ->
        error(conn, 409, "turn_already_running", "Codex session already has a running turn")

      {:error, reason} ->
        error(conn, 400, "input_failed", inspect(reason))
    end
  end

  @spec interrupt(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def interrupt(conn, %{"session_id" => session_id}) do
    case SessionRegistry.interrupt(session_id) do
      {:ok, session} ->
        json(conn, %{ok: true, session: session})

      {:error, :session_not_found} ->
        error(conn, 404, "session_not_found", "Codex session was not found")

      {:error, :no_active_turn} ->
        error(conn, 409, "no_active_turn", "Codex session has no active turn to interrupt")

      {:error, reason} ->
        error(conn, 400, "interrupt_failed", inspect(reason))
    end
  end

  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def delete(conn, %{"session_id" => session_id}) do
    case SessionRegistry.stop_session(session_id) do
      :ok ->
        json(conn, %{ok: true})

      {:error, :session_not_found} ->
        error(conn, 404, "session_not_found", "Codex session was not found")

      {:error, reason} ->
        error(conn, 400, "stop_failed", inspect(reason))
    end
  end

  defp error(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{ok: false, error: %{code: code, message: message}})
  end

  defp validate_workspace(workspace) when is_binary(workspace) do
    case String.trim(workspace) do
      "" -> {:error, {:invalid_workspace, "workspace is required"}}
      trimmed -> {:ok, trimmed}
    end
  end

  defp validate_workspace(_workspace), do: {:error, {:invalid_workspace, "workspace is required"}}

  defp sanitize_runner_config(runner_config) when is_map(runner_config) do
    unsupported_keys =
      runner_config
      |> Map.keys()
      |> Enum.map(&to_string/1)
      |> Enum.reject(&(&1 in @allowed_runner_config_keys))
      |> Enum.sort()

    case unsupported_keys do
      [] ->
        {:ok,
         runner_config
         |> Map.take(@allowed_runner_config_keys)
         |> Map.reject(fn {_key, value} -> value in [nil, ""] end)}

      keys ->
        {:error,
         {:invalid_runner_config,
          "runner_config contains unsupported keys: #{Enum.join(keys, ", ")}"}}
    end
  end

  defp sanitize_runner_config(_runner_config),
    do: {:error, {:invalid_runner_config, "runner_config must be an object"}}
end
