defmodule SymphonyElixir.WorkerBridge.Client do
  @moduledoc """
  HTTP client for the launcher-owned worker bridge API.

  The normal orchestrator application does not supervise
  `SymphonyElixir.WorkerBridge.Server`; that server lives in the always-on
  launcher process. Coding runners therefore cross the launcher HTTP boundary
  instead of calling the server GenServer directly.
  """

  alias SymphonyElixir.Supabase

  @default_base_url "http://127.0.0.1:4100"

  @spec start_session(map()) :: {:ok, map()} | {:error, term()}
  def start_session(params) when is_map(params) do
    request(:post, "/worker-bridge/sessions", json: params, success: [200, 201])
  end

  @spec heartbeat_session(String.t()) :: {:ok, map()} | {:error, term()}
  def heartbeat_session(id) when is_binary(id) do
    request(:post, "/worker-bridge/sessions/#{URI.encode_www_form(id)}/heartbeat", success: [200])
  end

  @spec stop_session(String.t()) :: {:ok, map()} | {:error, term()}
  def stop_session(id) when is_binary(id) do
    request(:delete, "/worker-bridge/sessions/#{URI.encode_www_form(id)}", success: [200])
  end

  defp request(method, path, opts) do
    success_statuses = Keyword.fetch!(opts, :success)

    Req.new(url: base_url() <> path, headers: headers())
    |> Req.merge(req_options())
    |> maybe_put_json(Keyword.get(opts, :json))
    |> Req.request(method: method)
    |> normalize_response(method, path, success_statuses)
  rescue
    error -> {:error, {:worker_bridge_request_failed, Exception.message(error)}}
  end

  defp normalize_response({:ok, %Req.Response{status: status, body: body}}, method, path, success_statuses) do
    if status in success_statuses do
      case body do
        %{"data" => session} when is_map(session) -> {:ok, session}
        %{data: session} when is_map(session) -> {:ok, session}
        session when is_map(session) -> {:ok, session}
        other -> {:error, {:invalid_worker_bridge_response, other}}
      end
    else
      normalize_error_response(status, body, method, path)
    end
  end

  defp normalize_response({:error, reason}, _method, _path, _success_statuses) do
    {:error, reason}
  end

  defp normalize_error_response(404, _body, _method, _path) do
    {:error, :not_found}
  end

  defp normalize_error_response(status, body, method, path) do
    {:error, {:worker_bridge_http_error, method, path, status, body}}
  end

  defp base_url do
    (System.get_env("LAUNCHER_BASE_URL") ||
       System.get_env("LAUNCHER_URL") ||
       launcher_url_from_port() ||
       @default_base_url)
    |> String.trim_trailing("/")
  end

  defp launcher_url_from_port do
    case System.get_env("LAUNCHER_PORT") do
      port when is_binary(port) and port != "" -> "http://127.0.0.1:#{port}"
      _port -> nil
    end
  end

  defp req_options do
    Application.get_env(:symphony_elixir, :worker_bridge_client_req_options, [])
  end

  defp headers do
    [
      {"authorization", "Bearer #{Supabase.service_role_key!()}"},
      {"content-type", "application/json"}
    ]
  end

  defp maybe_put_json(req, nil), do: req
  defp maybe_put_json(req, body), do: Req.merge(req, json: body)
end
