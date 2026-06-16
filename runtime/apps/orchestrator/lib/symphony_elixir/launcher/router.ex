defmodule SymphonyElixir.Launcher.Router do
  @moduledoc """
  HTTP API for the Launcher process.

  Exposes orchestrator lifecycle management endpoints on the Launcher port (:4100).
  The API server in the other repo calls these endpoints to start/stop orchestrators.

  ## Endpoints

      POST   /orchestrators      Start a new orchestrator instance
      GET    /orchestrators      List all orchestrator instances
      GET    /orchestrators/:id  Get status of a specific orchestrator
      DELETE /orchestrators/:id  Stop an orchestrator instance
      GET    /health             Launcher health check
  """

  use Plug.Router

  require Logger

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Diagnostic.AgentHealth
  alias SymphonyElixir.LocalRuntime.Diagnostics, as: LocalRuntimeDiagnostics
  alias SymphonyElixir.Launcher.RuntimeProxy
  alias SymphonyElixir.Launcher.Server
  alias SymphonyElixir.Manager.Supervisor, as: ManagerSupervisor
  alias SymphonyElixir.Planner.PlanDraft
  alias SymphonyElixir.RuntimeLog
  alias SymphonyElixir.WorkerBridge.Server, as: WorkerBridgeServer

  plug(Plug.Logger, log: :info)
  plug(:assign_trace_id)
  plug(:put_json_content_type)

  plug(Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  )

  plug(:require_service_role_bearer_for_control_plane)
  plug(:match)
  plug(:dispatch)

  get "/health" do
    json_resp(conn, 200, %{
      ok: true,
      service: "launcher",
      lifecycle: Server.health_summary()
    })
  end

  defp require_service_role_bearer_for_control_plane(conn, _opts) do
    case conn.request_path do
      "/health" ->
        conn

      "/local-relay/ws" ->
        conn

      _other ->
        SymphonyElixirWeb.Plugs.RequireServiceRoleBearer.call(conn, [])
    end
  end

  get "/local-relay/ws" do
    SymphonyElixirWeb.LocalRelayController.upgrade(conn, conn.params)
  end

  get "/api/v1/local-runtime/health" do
    conn = Plug.Conn.fetch_query_params(conn)
    json_resp(conn, 200, LocalRuntimeDiagnostics.health_payload(conn.query_params))
  end

  post "/orchestrators" do
    with {:ok, config} <- validate_create_params(conn.body_params) do
      case Server.start_orchestrator(put_trace_id(config, conn.assigns.trace_id)) do
        {:ok, orchestrator} ->
          json_resp(conn, 201, %{data: orchestrator})

        {:error, reason} ->
          json_resp(conn, 422, %{error: format_error(reason)})
      end
    else
      {:error, message} ->
        json_resp(conn, 400, %{error: message})
    end
  end

  get "/orchestrators" do
    orchestrators = Server.list_orchestrators()
    json_resp(conn, 200, %{data: orchestrators})
  end

  get "/agents" do
    case AgentInventory.list_agents() do
      {:ok, agents} ->
        json_resp(conn, 200, %{data: Enum.map(agents, &Agent.to_public_map/1)})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  get "/agents/:id" do
    case AgentInventory.get_agent(id) do
      {:ok, agent} ->
        json_resp(conn, 200, %{data: Agent.to_public_map(agent)})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  get "/agents/:id/runtime/api/v1/health" do
    case RuntimeProxy.health_payload(id) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :runtime_unavailable} ->
        json_resp(conn, 503, %{error: "runtime unavailable"})
    end
  end

  get "/agents/:id/diagnostics" do
    case RuntimeProxy.diagnostic_payload(id) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  get "/api/v1/diagnostic/agent/:id" do
    conn = Plug.Conn.fetch_query_params(conn)
    workspace_id = Map.get(conn.query_params, "workspace_id")

    if is_binary(workspace_id) and workspace_id != "" do
      json_resp(conn, 200, AgentHealth.agent(workspace_id, id, probe: agent_diagnostic_probe()))
    else
      json_resp(conn, 400, %{error: "workspace_id is required"})
    end
  end

  get "/api/v1/diagnostic/workspace/:workspace_id/agents" do
    case AgentHealth.workspace_agents(workspace_id, probe: agent_diagnostic_probe()) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :invalid_workspace_id} ->
        json_resp(conn, 400, %{error: "workspace_id is required"})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  get "/agents/:id/runtime/api/v1/state" do
    case RuntimeProxy.state_payload(id) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :runtime_unavailable} ->
        json_resp(conn, 503, %{error: "runtime unavailable"})
    end
  end

  get "/agents/:id/runtime/api/v1/messages" do
    query_params =
      conn
      |> Plug.Conn.fetch_query_params()
      |> Map.get(:query_params, %{})

    opts = [
      session_key: Map.get(query_params, "session_key"),
      limit: Map.get(query_params, "limit"),
      before: Map.get(query_params, "before"),
      before_id: Map.get(query_params, "before_id")
    ]

    case RuntimeProxy.messages_payload(id, opts) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :runtime_unavailable} ->
        json_resp(conn, 503, %{error: "runtime unavailable"})
    end
  end

  get "/api/runtime/manager-status" do
    conn = Plug.Conn.fetch_query_params(conn)
    workspace_id = Map.get(conn.query_params, "workspace_id")
    agent_id_param = Map.get(conn.query_params, "agent_id")

    cond do
      not (is_binary(workspace_id) and workspace_id != "") ->
        json_resp(conn, 400, %{error: "workspace_id is required"})

      # Read existing scheduler status without re-validating — the
      # scheduler was already created with a validated agent_id.
      is_binary(agent_id_param) and agent_id_param != "" and
          match?({:ok, _pid}, ManagerSupervisor.lookup(workspace_id, agent_id_param)) ->
        respond_with_manager_status(conn, workspace_id, agent_id_param)

      true ->
        # No live scheduler — resolve the configured manager and use
        # that agent_id. A query-param agent_id that disagrees with
        # the configured manager is rejected so we never start a
        # scheduler keyed to an arbitrary value.
        case resolve_manager_agent(workspace_id) do
          {:ok, configured_agent_id} ->
            cond do
              is_binary(agent_id_param) and agent_id_param != "" and
                  agent_id_param != configured_agent_id ->
                json_resp(conn, 404, %{
                  error: "agent_id is not the configured manager for this workspace"
                })

              true ->
                respond_with_manager_status(conn, workspace_id, configured_agent_id)
            end

          {:idle, payload} ->
            json_resp(conn, 200, Map.put(payload, :workspace_id, workspace_id))

          {:error, reason} ->
            json_resp(conn, 503, %{error: format_error(reason)})
        end
    end
  end

  post "/api/runtime/manager-tick" do
    conn = Plug.Conn.fetch_query_params(conn)
    workspace_id = Map.get(conn.query_params, "workspace_id")
    agent_id_param = Map.get(conn.query_params, "agent_id")
    timeout_ms = parse_positive_integer(Map.get(conn.query_params, "timeout_ms"), 305_000)

    cond do
      not (is_binary(workspace_id) and workspace_id != "") ->
        json_resp(conn, 400, %{error: "workspace_id is required"})

      # Existing schedulers have already passed manager identity validation.
      is_binary(agent_id_param) and agent_id_param != "" and
          match?({:ok, _pid}, ManagerSupervisor.lookup(workspace_id, agent_id_param)) ->
        respond_with_manager_tick(conn, workspace_id, agent_id_param, timeout_ms)

      true ->
        case resolve_manager_agent(workspace_id) do
          {:ok, configured_agent_id} ->
            cond do
              is_binary(agent_id_param) and agent_id_param != "" and
                  agent_id_param != configured_agent_id ->
                json_resp(conn, 404, %{
                  error: "agent_id is not the configured manager for this workspace"
                })

              true ->
                respond_with_manager_tick(conn, workspace_id, configured_agent_id, timeout_ms)
            end

          {:idle, payload} ->
            json_resp(conn, 200, Map.put(payload, :workspace_id, workspace_id))

          {:error, reason} ->
            json_resp(conn, 503, %{error: format_error(reason)})
        end
    end
  end

  post "/agents/:id/runtime/api/v1/refresh" do
    case RuntimeProxy.refresh_payload(id) do
      {:ok, payload} ->
        json_resp(conn, 202, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :runtime_unavailable} ->
        json_resp(conn, 503, %{error: "runtime unavailable"})
    end
  end

  post "/agents/:id/runtime/api/v1/plans/draft-from-prompt" do
    case plan_draft_adapter().draft_for_agent(id, conn.body_params) do
      {:ok, payload} ->
        json_resp(conn, 200, payload)

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :not_planning_agent} ->
        json_resp(conn, 422, %{error: "plan drafts require a planning agent"})

      {:error, {:invalid_request, message}} ->
        json_resp(conn, 400, %{error: message})

      {:error, {:invalid_plan_draft, errors}} ->
        json_resp(conn, 422, %{errors: errors})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  get "/agents/:id/runtime/ws" do
    conn = Plug.Conn.fetch_query_params(conn)

    case RuntimeProxy.websocket_state(id, conn) do
      {:ok, state} ->
        Plug.Conn.upgrade_adapter(conn, :websocket, {SymphonyElixirWeb.GatewaySocket, state, []})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "agent not found"})

      {:error, :runtime_unavailable} ->
        json_resp(conn, 503, %{error: "runtime unavailable"})
    end
  end

  get "/agents/:id/credentials" do
    case AgentInventory.list_credentials(id) do
      {:ok, credentials} ->
        data =
          Enum.map(credentials, &SymphonyElixir.AgentInventory.StoredCredential.to_public_map/1)

        json_resp(conn, 200, %{data: data})

      {:error, reason} ->
        json_resp(conn, 502, %{error: format_error(reason)})
    end
  end

  post "/agents/:id/start" do
    case Server.start_agent(id, put_trace_id(conn.body_params, conn.assigns.trace_id)) do
      {:ok, orchestrator} ->
        json_resp(conn, 201, %{data: orchestrator})

      {:error, :not_found} ->
        json_resp(
          conn,
          404,
          agent_launch_error_payload(
            "agent not found",
            "agent_not_found",
            ["agent"],
            "Agent must exist in the agent table"
          )
        )

      {:error, {:invalid_agent_config, message, details}} ->
        json_resp(conn, 422, agent_launch_error_payload(message, details))

      {:error, {:invalid_agent_config, _} = reason} ->
        json_resp(
          conn,
          422,
          agent_launch_error_payload(format_error(reason), "invalid_agent_config", [], nil)
        )

      {:error, :explicit_plan_handoff_required} ->
        json_resp(conn, 422, %{
          error: "coding launches from planner output require approved_plan_id or selected_task_ids"
        })

      {:error, reason} ->
        json_resp(conn, 422, %{error: format_error(reason)})
    end
  end

  get "/orchestrators/:id" do
    case Server.get_orchestrator(id) do
      {:ok, orchestrator} ->
        json_resp(conn, 200, %{data: orchestrator})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "orchestrator not found"})
    end
  end

  post "/worker-bridge/sessions" do
    case WorkerBridgeServer.start_session(conn.body_params) do
      {:ok, session} ->
        json_resp(conn, 201, %{data: session})

      {:error, reason} ->
        json_resp(conn, 422, %{error: format_error(reason)})
    end
  end

  get "/worker-bridge/sessions" do
    json_resp(conn, 200, %{data: WorkerBridgeServer.list_sessions()})
  end

  get "/worker-bridge/sessions/:id" do
    case WorkerBridgeServer.get_session(id) do
      {:ok, session} ->
        json_resp(conn, 200, %{data: session})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "worker bridge session not found"})
    end
  end

  post "/worker-bridge/sessions/:id/heartbeat" do
    case WorkerBridgeServer.heartbeat_session(id) do
      {:ok, session} ->
        json_resp(conn, 200, %{data: session})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "worker bridge session not found"})

      {:error, reason} ->
        json_resp(conn, 409, %{error: format_error(reason)})
    end
  end

  delete "/worker-bridge/sessions/:id" do
    case WorkerBridgeServer.stop_session(id) do
      {:ok, session} ->
        json_resp(conn, 200, %{data: session})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "worker bridge session not found"})
    end
  end

  delete "/orchestrators/:id" do
    case Server.stop_orchestrator(id) do
      {:ok, orchestrator} ->
        json_resp(conn, 200, %{data: orchestrator})

      {:error, :not_found} ->
        json_resp(conn, 404, %{error: "orchestrator not found"})
    end
  end

  match _ do
    json_resp(conn, 404, %{error: "not found"})
  end

  # --- Validation ---

  defp validate_create_params(params) when is_map(params) do
    case params do
      %{"tracker" => tracker} when is_map(tracker) ->
        case Map.get(tracker, "kind") do
          kind when is_binary(kind) and kind != "" ->
            {:ok, params}

          _ ->
            {:error, "tracker.kind is required and must be a non-empty string"}
        end

      %{"tracker" => _} ->
        {:error, "tracker must be a JSON object"}

      _ ->
        {:error, "tracker is required (must include at minimum tracker.kind)"}
    end
  end

  defp validate_create_params(_), do: {:error, "request body must be a JSON object"}

  # --- Helpers ---

  defp json_resp(conn, status, body) do
    conn
    |> put_resp_header("x-trace-id", conn.assigns[:trace_id] || RuntimeLog.generate_trace_id())
    |> send_resp(status, Jason.encode!(body))
  end

  defp respond_with_manager_status(conn, workspace_id, agent_id) do
    case ManagerSupervisor.status(workspace_id, agent_id) do
      {:ok, status} ->
        json_resp(conn, 200, manager_status_payload(status))

      {:error, :not_found} ->
        case ManagerSupervisor.ensure_scheduler(workspace_id, agent_id) do
          {:ok, _pid} ->
            case ManagerSupervisor.status(workspace_id, agent_id) do
              {:ok, status} -> json_resp(conn, 200, manager_status_payload(status))
              {:error, reason} -> json_resp(conn, 503, %{error: format_error(reason)})
            end

          {:error, reason} ->
            json_resp(conn, 503, %{error: format_error(reason)})
        end

      {:error, reason} ->
        json_resp(conn, 503, %{error: format_error(reason)})
    end
  end

  defp respond_with_manager_tick(conn, workspace_id, agent_id, timeout_ms) do
    case ManagerSupervisor.ensure_scheduler(workspace_id, agent_id) do
      {:ok, _pid} ->
        case ManagerSupervisor.tick(workspace_id, agent_id, timeout_ms) do
          {:ok, status} -> json_resp(conn, 200, manager_status_payload(status))
          {:error, reason} -> json_resp(conn, 503, %{error: format_error(reason)})
        end

      {:error, reason} ->
        json_resp(conn, 503, %{error: format_error(reason)})
    end
  end

  defp resolve_manager_agent(workspace_id) do
    case AgentInventory.list_agents() do
      {:ok, agents} when is_list(agents) ->
        agents
        |> Enum.find(&manager_agent_for_workspace?(&1, workspace_id))
        |> case do
          %Agent{id: agent_id} when is_binary(agent_id) and agent_id != "" ->
            {:ok, agent_id}

          _ ->
            {:idle, idle_status_payload(:config_missing, %{})}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp manager_agent_for_workspace?(%Agent{type: type, workspace_id: workspace_id}, workspace_id) do
    Agent.kind(type) == "manager"
  end

  defp manager_agent_for_workspace?(_agent, _workspace_id), do: false

  defp idle_status_payload(reason, details) do
    %{
      status: idle_status_string(reason),
      missing: idle_missing(reason),
      idle_reason: Atom.to_string(reason)
    }
    |> maybe_put_field(:provider, Map.get(details, :provider))
    |> maybe_put_field(:model, Map.get(details, :model))
    |> maybe_put_field(:agent_id, Map.get(details, :agent_id))
    |> maybe_put_field(:credential_id, Map.get(details, :credential_id))
    |> maybe_put_field(:credential_alias, Map.get(details, :credential_alias))
  end

  defp idle_status_string(:config_missing), do: "idle_awaiting_config"
  defp idle_status_string(:provider_unsupported), do: "idle_awaiting_config"
  defp idle_status_string(:credential_missing), do: "idle_awaiting_credential"
  defp idle_status_string(:credential_unresolved), do: "idle_awaiting_credential"
  defp idle_status_string(:manager_session_error), do: "error"
  defp idle_status_string(_other), do: "idle_awaiting_config"

  defp idle_missing(:config_missing), do: ["config"]
  defp idle_missing(:credential_missing), do: ["credential"]
  defp idle_missing(:credential_unresolved), do: ["credential"]
  defp idle_missing(:provider_unsupported), do: ["supported_provider"]
  defp idle_missing(:manager_session_error), do: []
  defp idle_missing(_other), do: []

  defp maybe_put_field(map, _key, nil), do: map
  defp maybe_put_field(map, _key, ""), do: map
  defp maybe_put_field(map, key, value), do: Map.put(map, key, value)

  defp manager_status_payload(status) when is_map(status) do
    Map.update(status, :status, nil, &stringify_status/1)
  end

  defp stringify_status(status) when is_atom(status), do: Atom.to_string(status)
  defp stringify_status(status), do: status

  defp parse_positive_integer(value, fallback) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> fallback
    end
  end

  defp parse_positive_integer(_value, fallback), do: fallback

  defp put_json_content_type(conn, _opts) do
    put_resp_content_type(conn, "application/json")
  end

  defp assign_trace_id(conn, _opts) do
    Plug.Conn.assign(
      conn,
      :trace_id,
      RuntimeLog.ensure_trace_id(RuntimeLog.trace_id_from_conn(conn))
    )
  end

  defp put_trace_id(params, trace_id) when is_map(params) do
    Map.put_new(params, "trace_id", trace_id)
  end

  defp put_trace_id(_params, trace_id), do: %{"trace_id" => trace_id}

  defp plan_draft_adapter do
    Application.get_env(:symphony_elixir, :planner_plan_draft_adapter, PlanDraft)
  end

  defp agent_diagnostic_probe do
    Application.get_env(
      :symphony_elixir,
      :agent_diagnostic_probe_adapter,
      SymphonyElixir.Diagnostic.AgentProbe
    )
  end

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error(reason) when is_atom(reason), do: Atom.to_string(reason)

  defp format_error({:invalid_agent_config, message, _details}) when is_binary(message),
    do: message

  defp format_error({:invalid_agent_config, message}) when is_binary(message), do: message
  defp format_error(reason), do: inspect(reason)

  defp agent_launch_error_payload(message, details) when is_map(details) do
    %{
      error: message,
      error_code: Map.get(details, :error_code, Map.get(details, "error_code", "invalid_agent_config")),
      required_config: Map.get(details, :required_config, Map.get(details, "required_config", [])),
      resolution_hint: Map.get(details, :resolution_hint, Map.get(details, "resolution_hint")),
      agent_id: Map.get(details, :agent_id, Map.get(details, "agent_id")),
      workspace_id: Map.get(details, :workspace_id, Map.get(details, "workspace_id"))
    }
  end

  defp agent_launch_error_payload(message, error_code, required_config, resolution_hint) do
    %{
      error: message,
      error_code: error_code,
      required_config: required_config,
      resolution_hint: resolution_hint
    }
  end
end
