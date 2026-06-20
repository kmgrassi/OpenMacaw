defmodule SymphonyElixir.WorkerBridge.Server do
  @moduledoc """
  Lightweight listener that launches credential-backed local worker processes.

  Startup path:

  1. `mix launcher.start` boots `SymphonyElixir.Launcher.Supervisor`.
  2. The launcher supervisor starts `SymphonyElixir.WorkerBridge.Server`.
  3. `SymphonyElixir.Launcher.Router` exposes `/worker-bridge/sessions` on the
     launcher HTTP server, typically port `4100`.
  4. Platform callers post a worker session request. For `"kind": "codex"`
     requests, this server resolves the actual shell command from
     `WORKFLOW.md` via `Config.settings!().codex.command`.
  5. Credential specs are converted into environment variables and the worker
     process is spawned under the requested workspace path.

  This first slice is intentionally narrow:

  - UI or API caller asks for a worker by `kind`
  - launcher resolves credentials into process env
  - launcher starts the worker subprocess locally in the background
  - lifecycle is exposed over the Launcher HTTP API

  The caller does not need direct CLI access and does not need to know the
  underlying launch command.
  """

  use GenServer

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
  alias SymphonyElixir.RuntimeLease
  alias SymphonyElixir.Runner.SkillMaterializer
  alias SymphonyElixir.{Config, PathSafety, Time}

  alias SymphonyElixir.WorkerBridge.{
    CredentialResolver,
    RepositoryManager,
    ResourceAuthorization,
    SecretResolver
  }

  @type start_params :: %{required(String.t()) => term()}

  @supported_kinds ~w(codex claude_code)
  @default_idle_timeout_ms 15 * 60 * 1_000
  @default_max_lifetime_ms 3 * 60 * 60 * 1_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec start_session(start_params()) :: {:ok, map()} | {:error, term()}
  def start_session(params) when is_map(params) do
    GenServer.call(__MODULE__, {:start_session, params}, 30_000)
  end

  @spec list_sessions() :: [map()]
  def list_sessions do
    GenServer.call(__MODULE__, :list_sessions)
  end

  @spec get_session(String.t()) :: {:ok, map()} | {:error, :not_found}
  def get_session(id) when is_binary(id) do
    GenServer.call(__MODULE__, {:get_session, id})
  end

  @spec heartbeat_session(String.t()) :: {:ok, map()} | {:error, term()}
  def heartbeat_session(id) when is_binary(id) do
    GenServer.call(__MODULE__, {:heartbeat_session, id})
  end

  @spec authorize_tool_call(String.t()) :: :ok | {:error, term()}
  def authorize_tool_call(id) when is_binary(id) do
    GenServer.call(__MODULE__, {:authorize_tool_call, id})
  end

  @spec stop_session(String.t()) :: {:ok, map()} | {:error, :not_found}
  def stop_session(id) when is_binary(id) do
    GenServer.call(__MODULE__, {:stop_session, id})
  end

  @spec reap_stale_sessions(keyword()) :: map()
  def reap_stale_sessions(opts \\ []) do
    GenServer.call(__MODULE__, {:reap_stale_sessions, opts}, 30_000)
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       sessions: %{},
       port_opener: Keyword.get(opts, :port_opener, &open_port/1),
       lease_registry:
         Keyword.get(
           opts,
           :lease_registry,
           Application.get_env(:symphony_elixir, :runtime_lease_registry, RuntimeLease.Registry)
         )
     }}
  end

  @impl true
  def handle_call({:start_session, params}, _from, state) do
    with :ok <- validate_params(params),
         {:ok, authorized_resources} <- ResourceAuthorization.authorize(params),
         {:ok, resolved_env} <- resolve_env(params),
         id = session_id(),
         {:ok, workspace_path, resources} <- resolve_workspace_path(params, id),
         :ok <- SkillMaterializer.materialize(params["kind"], params, workspace_path),
         {:ok, launch_spec} <- build_launch_spec(params, resolved_env, workspace_path, resources),
         {:ok, port} <- state.port_opener.(launch_spec) do
      entry = build_session_entry(id, params, resolved_env, launch_spec, port, authorized_resources)
      :ok = write_session_lease(state.lease_registry, entry, params)

      {:reply, {:ok, serialize_entry(entry)}, put_in(state.sessions[id], entry)}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:list_sessions, _from, state) do
    sessions =
      state.sessions
      |> Map.values()
      |> Enum.sort_by(& &1.started_at, {:desc, DateTime})
      |> Enum.map(&serialize_entry/1)

    {:reply, sessions, state}
  end

  def handle_call({:get_session, id}, _from, state) do
    case Map.get(state.sessions, id) do
      nil -> {:reply, {:error, :not_found}, state}
      entry -> {:reply, {:ok, serialize_entry(entry)}, state}
    end
  end

  def handle_call({:heartbeat_session, id}, _from, state) do
    case Map.get(state.sessions, id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      entry ->
        case revalidate_and_heartbeat_entry(entry, state.lease_registry) do
          {:ok, refreshed} ->
            {:reply, {:ok, serialize_entry(refreshed)}, put_in(state.sessions[id], refreshed)}

          {:error, reason, stopped} ->
            {:reply, {:error, reason}, put_in(state.sessions[id], stopped)}
        end
    end
  end

  def handle_call({:authorize_tool_call, id}, _from, state) do
    case Map.get(state.sessions, id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      entry ->
        case revalidate_and_heartbeat_entry(entry, state.lease_registry) do
          {:ok, refreshed} ->
            {:reply, :ok, put_in(state.sessions[id], refreshed)}

          {:error, reason, stopped} ->
            {:reply, {:error, reason}, put_in(state.sessions[id], stopped)}
        end
    end
  end

  def handle_call({:stop_session, id}, _from, state) do
    case Map.get(state.sessions, id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      entry ->
        stop_port(entry.port)
        stopped = finalize_entry(entry, "stopped", entry.exit_status || 0, state.lease_registry)

        {:reply, {:ok, serialize_entry(stopped)}, put_in(state.sessions[id], stopped)}
    end
  end

  def handle_call({:reap_stale_sessions, opts}, _from, state) do
    now = Keyword.get(opts, :now, DateTime.utc_now())

    stale_session_leases =
      state.lease_registry
      |> RuntimeLease.Registry.reap_stale_leases(now: now)
      |> Enum.filter(&(&1.kind == "session"))

    {sessions, metrics} =
      Enum.reduce(stale_session_leases, {state.sessions, empty_reap_metrics()}, fn lease, {sessions, metrics} ->
        case Map.get(sessions, lease.session_id || lease.id) do
          nil ->
            metrics = cleanup_stale_workspace(lease.workspace_path, metrics)
            {sessions, %{metrics | stale_missing_sessions: metrics.stale_missing_sessions + 1}}

          entry ->
            stop_port(entry.port)
            stopped = finalize_entry(entry, "stale", entry.exit_status || 0, state.lease_registry)
            metrics = %{metrics | reaped_sessions: metrics.reaped_sessions + 1}
            {Map.put(sessions, stopped.id, stopped), metrics}
        end
      end)

    {:reply, metrics, %{state | sessions: sessions}}
  end

  @impl true
  def handle_info({port, {:exit_status, exit_status}}, state) when is_port(port) do
    {:noreply,
     update_session_for_port(state, port, fn entry ->
       finalize_entry(entry, "exited", exit_status, state.lease_registry)
     end)}
  end

  def handle_info({port, {:data, _data}}, state) when is_port(port), do: {:noreply, state}
  def handle_info({_port, :closed}, state), do: {:noreply, state}
  def handle_info(_message, state), do: {:noreply, state}

  defp validate_params(%{"kind" => kind} = params) when is_binary(kind) do
    cond do
      kind not in @supported_kinds ->
        {:error, {:unsupported_worker_kind, kind}}

      identity_launch_params?(params) and not valid_identity_launch_params?(params) ->
        {:error, :invalid_agent_launch_params}

      not identity_launch_params?(params) and not Map.has_key?(params, "cwd") and
        not Map.has_key?(params, "repository") and not Map.has_key?(params, "resources") ->
        {:error, :missing_workspace_source}

      Map.has_key?(params, "cwd") and not is_binary(params["cwd"]) ->
        {:error, :invalid_cwd}

      Map.has_key?(params, "repository") and not valid_repository?(params["repository"]) ->
        {:error, :invalid_repository}

      Map.has_key?(params, "resources") and not valid_resources?(params["resources"]) ->
        {:error, :invalid_resources}

      is_map(Map.get(params, "env", %{})) == false ->
        {:error, :invalid_env}

      not valid_env_map?(Map.get(params, "env", %{})) ->
        {:error, :invalid_env}

      Map.has_key?(params, "credentials") and not is_map(params["credentials"]) ->
        {:error, :invalid_credentials}

      true ->
        :ok
    end
  end

  defp validate_params(_params), do: {:error, :invalid_start_params}

  defp resolve_env(params) do
    static_env = Map.get(params, "env", %{})
    credential_spec = Map.get(params, "credentials", %{})

    with {:ok, credential_env} <- resolve_credential_env(params, credential_spec),
         merged_env = Map.merge(static_env, credential_env),
         true <- valid_env_map?(merged_env) do
      {:ok, merged_env}
    else
      false -> {:error, :invalid_env}
      {:error, reason} -> {:error, reason}
    end
  end

  defp resolve_workspace_path(%{"cwd" => cwd}, _session_id) when is_binary(cwd) do
    case validate_workspace_cwd(cwd) do
      {:ok, workspace_path} -> {:ok, workspace_path, []}
      {:error, reason} -> {:error, reason}
    end
  end

  defp resolve_workspace_path(%{"resources" => resources}, session_id) when is_list(resources) do
    RepositoryManager.prepare_resources(resources, session_id)
  end

  defp resolve_workspace_path(%{"repository" => repository}, session_id)
       when is_map(repository) do
    case RepositoryManager.prepare_workspace(repository, session_id) do
      {:ok, workspace_path} -> {:ok, workspace_path, []}
      {:error, reason} -> {:error, reason}
    end
  end

  defp resolve_workspace_path(
         %{"agent_id" => agent_id, "workspace_id" => workspace_id},
         _session_id
       )
       when is_binary(agent_id) and is_binary(workspace_id) do
    workspace =
      Config.settings!().workspace.root
      |> Path.join(workspace_id)
      |> Path.join(agent_id)

    with :ok <- validate_identity_path_segments([workspace_id, agent_id]),
         {:ok, validated_workspace} <- validate_identity_workspace_path(workspace) do
      File.mkdir_p!(validated_workspace)
      {:ok, validated_workspace, []}
    end
  end

  defp build_launch_spec(%{"kind" => "codex"} = params, env, workspace_path, resources) do
    with {:ok, default_command} <- codex_command() do
      command =
        case Map.get(params, "command") do
          custom when is_binary(custom) ->
            if String.trim(custom) == "", do: default_command, else: custom

          _ ->
            default_command
        end

      {:ok,
       %{
         kind: "codex",
         command: command,
         cwd: workspace_path,
         env: maybe_put_resource_env(env, resources),
         resources: resources
       }}
    end
  end

  defp build_launch_spec(%{"kind" => "claude_code"} = params, env, workspace_path, resources) do
    case Map.get(params, "command") do
      command when is_binary(command) ->
        command = String.trim(command)

        if command == "" do
          {:error, :missing_worker_command}
        else
          {:ok,
           %{
             kind: "claude_code",
             command: command,
             cwd: workspace_path,
             env: maybe_put_resource_env(env, resources),
             resources: resources
           }}
        end

      _command ->
        {:error, :missing_worker_command}
    end
  end

  defp build_session_entry(id, params, resolved_env, launch_spec, port, authorized_resources) do
    %{
      id: id,
      kind: params["kind"],
      command: launch_spec.command,
      cwd: launch_spec.cwd,
      workspace_cleanup_path: cleanup_path(params, launch_spec.cwd),
      status: "running",
      port: port,
      lease_id: id,
      started_at: DateTime.utc_now(),
      heartbeat_at: DateTime.utc_now(),
      idle_timeout_ms: lease_timeout_ms(params, "idle_timeout_ms", @default_idle_timeout_ms),
      max_lifetime_ms: lease_timeout_ms(params, "max_lifetime_ms", @default_max_lifetime_ms),
      idle_expires_at: nil,
      max_expires_at: nil,
      stopped_at: nil,
      exit_status: nil,
      env_keys: launch_spec.env |> Map.keys() |> Enum.sort(),
      credential_keys: credential_keys(params, resolved_env),
      agent_id: Map.get(params, "agent_id"),
      workspace_id: Map.get(params, "workspace_id"),
      credential_id: Map.get(params, "credential_id"),
      execution_mode: Map.get(params, "execution_mode") || "planning_readonly",
      run_id: Map.get(params, "run_id"),
      session_id: Map.get(params, "session_id"),
      authorized_resources: authorized_resources,
      resources: launch_spec.resources
    }
    |> put_initial_deadlines()
  end

  defp serialize_entry(entry) do
    %{
      id: entry.id,
      kind: entry.kind,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      heartbeat_at: Time.to_iso8601(Map.get(entry, :heartbeat_at)),
      idle_expires_at: Time.to_iso8601(Map.get(entry, :idle_expires_at)),
      max_expires_at: Time.to_iso8601(Map.get(entry, :max_expires_at)),
      started_at: Time.to_iso8601(entry.started_at),
      stopped_at: Time.to_iso8601(entry.stopped_at),
      exit_status: entry.exit_status,
      env_keys: entry.env_keys,
      credential_keys: entry.credential_keys,
      agent_id: Map.get(entry, :agent_id),
      workspace_id: Map.get(entry, :workspace_id),
      credential_id: Map.get(entry, :credential_id),
      execution_mode: Map.get(entry, :execution_mode),
      run_id: Map.get(entry, :run_id),
      session_id: Map.get(entry, :session_id),
      resources: serialize_resources(entry)
    }
  end

  defp serialize_authorized_resources(resources) when is_list(resources) do
    Enum.map(resources, fn resource ->
      %{
        id: resource.id,
        type: resource.type,
        grant_id: resource.grant_id,
        grant_version: resource.grant_version,
        mode: resource.mode,
        required: resource.required,
        credential_ref: resource.credential_ref
      }
    end)
  end

  defp serialize_authorized_resources(_resources), do: []

  defp serialize_resources(entry) do
    case Map.get(entry, :resources, []) do
      resources when is_list(resources) and resources != [] ->
        resources

      _resources ->
        serialize_authorized_resources(Map.get(entry, :authorized_resources, []))
    end
  end

  defp resolve_credential_env(
         %{
           "agent_id" => agent_id,
           "workspace_id" => workspace_id,
           "credential_id" => credential_id
         },
         _credential_spec
       )
       when is_binary(agent_id) and is_binary(workspace_id) and is_binary(credential_id) do
    with {:ok, %Agent{} = agent} <- safe_get_agent(agent_id),
         :ok <- validate_agent_workspace(agent, workspace_id),
         {:ok, credentials} <- safe_list_credentials(agent_id),
         {:ok, %StoredCredential{} = credential} <-
           select_stored_credential(credentials, credential_id, workspace_id),
         {:ok, resolved} <- SecretResolver.resolve(credential) do
      {:ok, resolved}
    end
  end

  defp resolve_credential_env(_params, credential_spec) do
    CredentialResolver.resolve(credential_spec)
  end

  defp validate_agent_workspace(%Agent{workspace_id: agent_workspace_id}, workspace_id)
       when is_binary(agent_workspace_id) and agent_workspace_id != "" do
    if agent_workspace_id == workspace_id, do: :ok, else: {:error, :workspace_mismatch}
  end

  defp validate_agent_workspace(_agent, _workspace_id), do: :ok

  defp select_stored_credential(credentials, credential_id, workspace_id)
       when is_list(credentials) do
    credentials
    |> Enum.find(fn %StoredCredential{id: id, workspace_id: candidate_workspace_id} ->
      id == credential_id and candidate_workspace_id == workspace_id
    end)
    |> case do
      %StoredCredential{} = credential -> {:ok, credential}
      nil -> {:error, :credential_not_found}
    end
  end

  defp credential_keys(%{"credential_id" => _credential_id}, resolved_env)
       when is_map(resolved_env) do
    resolved_env |> Map.keys() |> Enum.sort()
  end

  defp credential_keys(params, _resolved_env) do
    params |> Map.get("credentials", %{}) |> Map.keys() |> Enum.sort()
  end

  defp identity_launch_params?(params) when is_map(params) do
    not Map.has_key?(params, "cwd") and not Map.has_key?(params, "repository") and
      not Map.has_key?(params, "resources") and
      (Map.has_key?(params, "agent_id") or Map.has_key?(params, "workspace_id") or
         Map.has_key?(params, "credential_id"))
  end

  defp valid_identity_launch_params?(%{
         "agent_id" => agent_id,
         "workspace_id" => workspace_id,
         "credential_id" => credential_id
       })
       when is_binary(agent_id) and agent_id != "" and is_binary(workspace_id) and
              workspace_id != "" and
              is_binary(credential_id) and credential_id != "" do
    true
  end

  defp valid_identity_launch_params?(_params), do: false

  defp validate_identity_path_segments(segments) when is_list(segments) do
    if Enum.all?(segments, &valid_identity_path_segment?/1),
      do: :ok,
      else: {:error, :invalid_identity_path}
  end

  defp valid_identity_path_segment?(segment) when is_binary(segment) do
    segment != "" and
      segment not in [".", ".."] and
      not String.contains?(segment, ["/", "\\", <<0>>, "\n", "\r"])
  end

  defp valid_identity_path_segment?(_segment), do: false

  defp validate_identity_workspace_path(workspace) when is_binary(workspace) do
    expanded_workspace = Path.expand(workspace)
    expanded_root = Path.expand(Config.settings!().workspace.root)
    expanded_root_prefix = expanded_root <> "/"

    cond do
      expanded_workspace == expanded_root ->
        {:error, {:invalid_workspace_cwd, :workspace_root, expanded_workspace}}

      String.starts_with?(expanded_workspace <> "/", expanded_root_prefix) ->
        {:ok, expanded_workspace}

      true ->
        {:error, {:invalid_workspace_cwd, :outside_workspace_root, expanded_workspace, expanded_root}}
    end
  end

  defp safe_get_agent(agent_id) do
    AgentInventory.get_agent(agent_id)
  rescue
    error in [ArgumentError] ->
      {:error, {:agent_inventory_unavailable, Exception.message(error)}}
  end

  defp safe_list_credentials(agent_id) do
    AgentInventory.list_credentials(agent_id)
  rescue
    error in [ArgumentError] ->
      {:error, {:agent_inventory_unavailable, Exception.message(error)}}
  end

  defp valid_repository?(%{"url" => url}) when is_binary(url), do: String.trim(url) != ""
  defp valid_repository?(_repository), do: false

  defp valid_resources?(resources) when is_list(resources) and length(resources) > 0 do
    Enum.all?(resources, &is_map/1)
  end

  defp valid_resources?(_resources), do: false

  defp valid_env_map?(env) when env in [%{}, nil], do: true

  defp valid_env_map?(env) when is_map(env) do
    Enum.all?(env, fn
      {key, value} when is_binary(key) and is_binary(value) -> valid_env_name?(key)
      _ -> false
    end)
  end

  defp valid_env_map?(_env), do: false

  defp valid_env_name?(name) when is_binary(name) do
    String.match?(name, ~r/^[A-Za-z_][A-Za-z0-9_]*$/)
  end

  defp validate_workspace_cwd(workspace) when is_binary(workspace) do
    case PathSafety.validate_local_workspace_cwd(workspace, Config.settings!().workspace.root, require_dir?: true) do
      {:error, {:invalid_workspace_cwd, :cwd_not_found, canonical_workspace}} ->
        {:error, {:cwd_not_found, canonical_workspace}}

      other ->
        other
    end
  end

  defp codex_command do
    {:ok, Config.settings!().codex.command}
  rescue
    error in [ArgumentError] ->
      {:error, {:invalid_runtime_config, Exception.message(error)}}
  end

  defp revalidate_and_heartbeat_entry(entry, lease_registry) do
    with {:ok, refreshed} <- revalidate_entry(entry, lease_registry),
         {:ok, heartbeat} <-
           RuntimeLease.Registry.heartbeat(lease_registry, refreshed.lease_id, idle_timeout_ms: refreshed.idle_timeout_ms) do
      {:ok, %{refreshed | heartbeat_at: heartbeat.heartbeat_at, idle_expires_at: heartbeat.idle_expires_at}}
    else
      {:error, reason, stopped} -> {:error, reason, stopped}
      {:error, reason} -> {:error, reason, entry}
    end
  end

  defp revalidate_entry(%{status: status} = entry, _lease_registry) when status != "running" do
    {:ok, entry}
  end

  defp revalidate_entry(%{authorized_resources: []} = entry, _lease_registry), do: {:ok, entry}

  defp revalidate_entry(%{authorized_resources: resources} = entry, lease_registry) when is_list(resources) do
    case ResourceAuthorization.revalidate(resources, entry) do
      {:ok, refreshed_resources} ->
        {:ok, %{entry | authorized_resources: refreshed_resources}}

      {:error, reason} ->
        stop_port(entry.port)
        {:error, reason, finalize_entry(entry, "revoked", entry.exit_status || 0, lease_registry)}
    end
  end

  defp revalidate_entry(entry, _lease_registry), do: {:ok, Map.put(entry, :authorized_resources, [])}

  defp update_session_for_port(state, port, fun) do
    updated_sessions =
      Map.new(state.sessions, fn {id, entry} ->
        if entry.port == port, do: {id, fun.(entry)}, else: {id, entry}
      end)

    %{state | sessions: updated_sessions}
  end

  defp session_id do
    "worker_" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end

  defp cleanup_path(%{"repository" => _repository}, workspace_path), do: workspace_path
  defp cleanup_path(%{"resources" => _resources}, workspace_path), do: workspace_path
  defp cleanup_path(_params, _workspace_path), do: nil

  defp maybe_put_resource_env(env, []), do: env

  defp maybe_put_resource_env(env, resources) do
    sanitized = Enum.map(resources, &sanitize_resource_status/1)

    case Jason.encode(sanitized) do
      {:ok, encoded} -> Map.put(env, "SYMPHONY_RESOURCE_CONTEXT", encoded)
      {:error, _reason} -> env
    end
  end

  defp sanitize_resource_status(%{"locator" => locator} = resource) when is_binary(locator) do
    Map.put(resource, "locator", RepositoryManager.sanitize_url(locator))
  end

  defp sanitize_resource_status(resource), do: resource

  defp finalize_entry(entry, status, exit_status, lease_registry) do
    cleanup_result = maybe_cleanup_workspace(entry.workspace_cleanup_path)
    release_session_lease(lease_registry, entry, status)
    log_cleanup_result(entry, status, cleanup_result)

    %{
      entry
      | status: status,
        stopped_at: DateTime.utc_now(),
        exit_status: exit_status,
        workspace_cleanup_path: nil
    }
  end

  defp maybe_cleanup_workspace(nil), do: :ok

  defp maybe_cleanup_workspace(path) do
    case RepositoryManager.cleanup_workspace(path) do
      :ok ->
        :ok

      {:error, {:workspace_cleanup_failed, failed_path, reason}} ->
        {:error, {reason, failed_path}}

      {:error, {:resource_path_outside_workspace, _expanded_path, _expanded_root}} ->
        cleanup_workspace_fallback(path)

      {:error, :invalid_workspace_path} ->
        cleanup_workspace_fallback(path)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp cleanup_workspace_fallback(path) do
    case File.rm_rf(path) do
      {:ok, _paths} -> :ok
      {:error, reason, failed_path} -> {:error, {reason, failed_path}}
    end
  end

  defp empty_reap_metrics do
    %{reaped_sessions: 0, stale_missing_sessions: 0, cleanup_failures: 0}
  end

  defp cleanup_stale_workspace(nil, metrics), do: metrics

  defp cleanup_stale_workspace(path, metrics) do
    case maybe_cleanup_workspace(path) do
      :ok ->
        metrics

      {:error, reason} ->
        require Logger
        Logger.warning("worker_bridge_cleanup event=workspace_cleanup_failed path=#{path} reason=#{inspect(reason)}")
        %{metrics | cleanup_failures: metrics.cleanup_failures + 1}
    end
  end

  defp write_session_lease(lease_registry, entry, params) do
    metadata = Map.get(params, "lease", %{}) |> normalize_lease_metadata()
    grant_versions = Map.merge(resource_grant_versions(entry), Map.get(metadata, "materialized_grant_versions", %{}))

    {:ok, _lease} =
      RuntimeLease.Registry.upsert_lease(lease_registry, %{
        id: entry.lease_id,
        kind: "session",
        owner: "worker_bridge",
        workspace_id: entry.workspace_id,
        agent_id: entry.agent_id,
        session_id: entry.id,
        workspace_path: entry.workspace_cleanup_path,
        heartbeat_at: entry.heartbeat_at,
        idle_expires_at: entry.idle_expires_at,
        max_expires_at: entry.max_expires_at,
        materialized_grant_versions: grant_versions,
        metadata: metadata
      })

    :ok
  end

  defp release_session_lease(lease_registry, entry, status) do
    if Map.get(entry, :lease_id) do
      case RuntimeLease.Registry.release_lease(lease_registry, entry.lease_id) do
        {:ok, _lease} ->
          :ok

        {:error, :not_found} ->
          require Logger
          Logger.warning("worker_bridge_cleanup event=lease_release_missing session_id=#{entry.id} status=#{status}")
      end
    end
  end

  defp log_cleanup_result(entry, status, :ok) do
    require Logger

    Logger.info("worker_bridge_cleanup event=session_finalized session_id=#{entry.id} status=#{status} workspace_id=#{entry.workspace_id || "unknown"}")
  end

  defp log_cleanup_result(entry, status, {:error, reason}) do
    require Logger

    Logger.warning("worker_bridge_cleanup event=session_cleanup_failed session_id=#{entry.id} status=#{status} reason=#{inspect(reason)}")
  end

  defp lease_timeout_ms(params, key, default) do
    params
    |> Map.get("lease", %{})
    |> case do
      %{} = lease -> Map.get(lease, key, default)
      _ -> default
    end
    |> normalize_timeout_ms(default)
  end

  defp normalize_timeout_ms(value, _default) when is_integer(value) and value > 0, do: value

  defp normalize_timeout_ms(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> default
    end
  end

  defp normalize_timeout_ms(_value, default), do: default

  defp put_initial_deadlines(entry) do
    %{
      entry
      | idle_expires_at: DateTime.add(entry.heartbeat_at, entry.idle_timeout_ms, :millisecond),
        max_expires_at: DateTime.add(entry.started_at, entry.max_lifetime_ms, :millisecond)
    }
  end

  defp normalize_lease_metadata(%{} = metadata), do: metadata
  defp normalize_lease_metadata(_metadata), do: %{}

  defp resource_grant_versions(%{authorized_resources: resources}) when is_list(resources) do
    Map.new(resources, fn resource -> {resource.grant_id, resource.grant_version} end)
  end

  defp resource_grant_versions(_entry), do: %{}

  defp open_port(%{command: command, cwd: cwd, env: env}) do
    case System.find_executable("bash") do
      nil ->
        {:error, :bash_not_found}

      executable ->
        opts =
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [~c"-lc", String.to_charlist(command)]
          ]
          |> maybe_put_cd(cwd)
          |> maybe_put_env(env)

        {:ok, Port.open({:spawn_executable, String.to_charlist(executable)}, opts)}
    end
  end

  defp maybe_put_cd(opts, nil), do: opts
  defp maybe_put_cd(opts, cwd), do: Keyword.put(opts, :cd, String.to_charlist(cwd))

  defp maybe_put_env(opts, env) when env in [%{}, nil], do: opts

  defp maybe_put_env(opts, env) when is_map(env) do
    formatted =
      Enum.map(env, fn {key, value} ->
        {String.to_charlist(key), String.to_charlist(value)}
      end)

    Keyword.put(opts, :env, formatted)
  end

  defp stop_port(port) when is_port(port) do
    try do
      Port.close(port)
    catch
      :error, :badarg -> :ok
    end

    :ok
  end
end
