defmodule SymphonyElixir.WorkerBridge.ServerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
  alias SymphonyElixir.Config
  alias SymphonyElixir.RuntimeLease.Registry, as: RuntimeLeaseRegistry
  alias SymphonyElixir.WorkerBridge.Server

  defmodule TestAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    def list_agents do
      {:ok, Application.get_env(:symphony_elixir, :worker_bridge_test_agents, [])}
    end

    def get_agent(agent_id) do
      Application.get_env(:symphony_elixir, :worker_bridge_test_agents, [])
      |> Enum.find(&(&1.id == agent_id))
      |> case do
        %Agent{} = agent -> {:ok, agent}
        nil -> {:error, :not_found}
      end
    end

    def list_credentials(agent_id) do
      {:ok,
       Application.get_env(:symphony_elixir, :worker_bridge_test_credentials, [])
       |> Enum.filter(&(&1.agent_id == agent_id))}
    end
  end

  defmodule RaisingAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    def list_agents, do: {:ok, []}
    def get_agent(_agent_id), do: raise(ArgumentError, "agent inventory endpoint is required")

    def list_credentials(_agent_id),
      do: raise(ArgumentError, "agent inventory endpoint is required")
  end

  defmodule TestResourceGrantResolver do
    @behaviour SymphonyElixir.WorkerBridge.ResourceAuthorization

    def validate_resource_grant(%{"id" => resource_id}, _context) do
      Application.get_env(:symphony_elixir, :worker_bridge_test_resource_grants, %{})
      |> Map.fetch(resource_id)
      |> case do
        {:ok, grant} -> {:ok, grant}
        :error -> {:error, :resource_grant_not_found}
      end
    end
  end

  setup do
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :worker_bridge_test_agents, [])
    Application.put_env(:symphony_elixir, :worker_bridge_test_credentials, [])
    Application.delete_env(:symphony_elixir, :worker_bridge_secret_ref_resolver)
    Application.delete_env(:symphony_elixir, :worker_bridge_resource_authorization_resolver)
    Application.delete_env(:symphony_elixir, :worker_bridge_test_resource_grants)
    lease_registry = :"worker-bridge-lease-registry-#{System.unique_integer([:positive])}"
    start_supervised!({RuntimeLeaseRegistry, name: lease_registry})
    Application.put_env(:symphony_elixir, :runtime_lease_registry, lease_registry)
    {:ok, pid} = start_supervised(Server)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :worker_bridge_test_agents)
      Application.delete_env(:symphony_elixir, :worker_bridge_test_credentials)
      Application.delete_env(:symphony_elixir, :worker_bridge_secret_ref_resolver)
      Application.delete_env(:symphony_elixir, :worker_bridge_resource_authorization_resolver)
      Application.delete_env(:symphony_elixir, :worker_bridge_test_resource_grants)
      Application.delete_env(:symphony_elixir, :runtime_lease_registry)
    end)

    %{server: pid, lease_registry: lease_registry}
  end

  test "starts a codex session with resolved credentials and tracks it" do
    output_path =
      Path.join(System.tmp_dir!(), "worker_bridge_env_#{System.unique_integer([:positive])}")

    cwd = create_workspace_dir!("worker_bridge_session")

    env_name = "WORKER_BRIDGE_SERVER_SECRET_#{System.unique_integer([:positive])}"
    previous = System.get_env(env_name)

    System.put_env(env_name, "secret-from-env")

    on_exit(fn ->
      if previous, do: System.put_env(env_name, previous), else: System.delete_env(env_name)
      File.rm_rf(output_path)
      File.rm_rf(cwd)
    end)

    command = "printf '%s' \"$OPENAI_API_KEY\" > #{shell_escape(output_path)} && sleep 5"

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "command" => command,
               "cwd" => cwd,
               "credentials" => %{
                 "OPENAI_API_KEY" => %{"source" => "env", "name" => env_name}
               }
             })

    assert session.status == "running"
    assert session.kind == "codex"
    assert session.credential_keys == ["OPENAI_API_KEY"]
    assert session.env_keys == ["OPENAI_API_KEY"]
    assert wait_for_file(output_path) == "secret-from-env"

    assert {:ok, fetched} = Server.get_session(session.id)
    assert fetched.id == session.id
  end

  test "materializes approved skills before launching worker process" do
    cwd = create_workspace_dir!("worker_bridge_skills")
    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "command" => "sleep 5",
               "cwd" => cwd,
               "skills_snapshot" => %{
                 "version" => 1,
                 "agentId" => "agent-1",
                 "workspaceId" => "workspace-1",
                 "skills" => [
                   %{
                     "id" => "skill-1",
                     "name" => "api-debugging",
                     "description" => "Debug APIs",
                     "body" => "Inspect logs."
                   }
                 ]
               }
             })

    assert session.status == "running"
    skill_path = Path.join([cwd, ".codex", "skills", "api-debugging", "SKILL.md"])
    assert File.read!(skill_path) =~ "Inspect logs."
  end

  test "prepares a workspace from repository intent" do
    repo_path =
      Path.join(
        System.tmp_dir!(),
        "worker_bridge_server_repo_#{System.unique_integer([:positive])}"
      )

    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, "README.md"), "# bridge\n")
    git!(["add", "README.md"], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    on_exit(fn ->
      File.rm_rf!(repo_path)
    end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "repository" => %{
                 "url" => repo_path,
                 "ref" => "main"
               },
               "command" => "test -f README.md && sleep 5"
             })

    assert is_binary(session.cwd)
    assert File.exists?(Path.join(session.cwd, "README.md"))

    assert {:ok, _stopped} = Server.stop_session(session.id)
    refute File.exists?(session.cwd)
  end

  test "authorizes granted resources before launching a session" do
    cwd = create_workspace_dir!("worker_bridge_authorized_resource")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "execution_mode" => "planning_readonly",
               "cwd" => cwd,
               "resources" => [
                 resource("repo-runtime", "grant-runtime", "v1"),
                 resource("repo-platform", "grant-platform", "v7")
               ]
             })

    assert [
             %{
               id: "repo-runtime",
               type: "git_repository",
               grant_id: "grant-runtime",
               grant_version: "v1",
               mode: "planning_readonly"
             },
             %{
               id: "repo-platform",
               type: "git_repository",
               grant_id: "grant-platform",
               grant_version: "v7",
               mode: "planning_readonly"
             }
           ] = session.resources
  end

  test "prepares a multi-repository workspace from granted resource intents" do
    first_repo = create_git_repo!("worker_bridge_server_first_repo", "README.md", "# first\n")
    second_repo = create_git_repo!("worker_bridge_server_second_repo", "SECOND.md", "# second\n")

    on_exit(fn ->
      File.rm_rf!(first_repo)
      File.rm_rf!(second_repo)
    end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "execution_mode" => "planning_readonly",
               "resources" => [
                 resource("repo-1", "grant-1", "v1")
                 |> Map.merge(%{"alias" => "first_repo", "url" => first_repo, "ref" => "main"}),
                 resource("repo-2", "grant-2", "v1")
                 |> Map.merge(%{"alias" => "second_repo", "url" => second_repo, "ref" => "main"})
               ],
               "command" => "test -f resources/first_repo/README.md && test -f resources/second_repo/SECOND.md && test -n \"$SYMPHONY_RESOURCE_CONTEXT\" && sleep 5"
             })

    assert is_binary(session.cwd)
    assert File.exists?(Path.join([session.cwd, "resources", "first_repo", "README.md"]))
    assert File.exists?(Path.join([session.cwd, "resources", "second_repo", "SECOND.md"]))

    assert [
             %{"alias" => "first_repo", "status" => "available", "grant_id" => "grant-1"},
             %{"alias" => "second_repo", "status" => "available", "grant_id" => "grant-2"}
           ] = session.resources

    assert "SYMPHONY_RESOURCE_CONTEXT" in session.env_keys

    assert {:ok, _stopped} = Server.stop_session(session.id)
    refute File.exists?(session.cwd)
  end

  test "rejects invalid resource aliases before opening a port" do
    repo = create_git_repo!("worker_bridge_server_bad_alias_repo", "README.md", "# bad alias\n")

    on_exit(fn -> File.rm_rf!(repo) end)

    assert {:error, {:invalid_resource_alias, "bad/alias"}} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "execution_mode" => "planning_readonly",
               "resources" => [
                 resource("repo-1", "grant-1", "v1")
                 |> Map.merge(%{"alias" => "bad/alias", "url" => repo, "ref" => "main"})
               ],
               "command" => "sleep 5"
             })
  end

  test "rejects resource launches without grant metadata before opening a port" do
    cwd = create_workspace_dir!("worker_bridge_missing_resource_grant")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:error, :missing_resource_grant_metadata} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "cwd" => cwd,
               "resources" => [%{"id" => "repo-runtime", "type" => "git_repository"}],
               "command" => "sleep 5"
             })
  end

  test "rejects wrong workspace, wrong agent, disabled grant, wrong mode, and missing credential" do
    cwd = create_workspace_dir!("worker_bridge_resource_denials")

    on_exit(fn -> File.rm_rf(cwd) end)

    denials = [
      {put_in(
         resource("repo-runtime", "grant-runtime", "v1"),
         ["grant", "workspace_id"],
         "workspace-2"
       ), "workspace_write", {:resource_grant_workspace_mismatch, "repo-runtime", "grant-runtime"}},
      {put_in(resource("repo-runtime", "grant-runtime", "v1"), ["grant", "agent_id"], "agent-2"), "workspace_write", {:resource_grant_agent_mismatch, "repo-runtime", "grant-runtime"}},
      {put_in(resource("repo-runtime", "grant-runtime", "v1"), ["grant", "enabled"], false), "workspace_write", {:resource_grant_disabled, "repo-runtime", "grant-runtime"}},
      {put_in(
         resource("repo-runtime", "grant-runtime", "v1"),
         ["grant", "mode"],
         "planning_readonly"
       ), "workspace_write", {:resource_grant_mode_denied, "repo-runtime", "grant-runtime", "workspace_write"}},
      {put_in(resource("repo-runtime", "grant-runtime", "v1"), ["grant", "credential_ref"], %{}), "planning_readonly", {:missing_resource_credential, "repo-runtime", "grant-runtime"}}
    ]

    for {resource, execution_mode, reason} <- denials do
      assert {:error, ^reason} =
               Server.start_session(%{
                 "kind" => "codex",
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "execution_mode" => execution_mode,
                 "cwd" => cwd,
                 "resources" => [resource]
               })
    end
  end

  test "heartbeat revalidates resource grants and revokes the session when a grant is removed" do
    Application.put_env(
      :symphony_elixir,
      :worker_bridge_resource_authorization_resolver,
      TestResourceGrantResolver
    )

    Application.put_env(:symphony_elixir, :worker_bridge_test_resource_grants, %{
      "repo-runtime" => grant("grant-runtime", "v1")
    })

    cwd = create_workspace_dir!("worker_bridge_resource_revocation")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "execution_mode" => "planning_readonly",
               "cwd" => cwd,
               "command" => "sleep 30",
               "resources" => [
                 %{
                   "id" => "repo-runtime",
                   "type" => "git_repository",
                   "grant" => grant("grant-runtime", "v1")
                 }
               ]
             })

    assert {:ok, alive} = Server.heartbeat_session(session.id)
    assert alive.status == "running"

    Application.put_env(:symphony_elixir, :worker_bridge_test_resource_grants, %{})

    assert {:error, {:resource_authorization_revoked, :resource_grant_not_found}} =
             Server.heartbeat_session(session.id)

    assert {:ok, revoked} = Server.get_session(session.id)
    assert revoked.status == "revoked"
  end

  test "tool-call authorization revalidates grant mode before allowing work" do
    Application.put_env(
      :symphony_elixir,
      :worker_bridge_resource_authorization_resolver,
      TestResourceGrantResolver
    )

    Application.put_env(:symphony_elixir, :worker_bridge_test_resource_grants, %{
      "repo-runtime" => grant("grant-runtime", "v1")
    })

    cwd = create_workspace_dir!("worker_bridge_tool_call_resource_auth")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "execution_mode" => "planning_readonly",
               "cwd" => cwd,
               "command" => "sleep 30",
               "resources" => [
                 %{
                   "id" => "repo-runtime",
                   "type" => "git_repository",
                   "grant" => grant("grant-runtime", "v1")
                 }
               ]
             })

    assert :ok = Server.authorize_tool_call(session.id)

    Application.put_env(:symphony_elixir, :worker_bridge_test_resource_grants, %{
      "repo-runtime" => grant("grant-runtime", "v2", mode: "workspace_write")
    })

    assert {:error, {:resource_authorization_revoked, {:resource_grant_mode_denied, "repo-runtime", "grant-runtime", "planning_readonly"}}} =
             Server.authorize_tool_call(session.id)
  end

  test "uses default codex command when command is omitted" do
    cwd = create_workspace_dir!("worker_bridge_default_command")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => cwd
             })

    assert session.command == Config.settings!().codex.command
    assert {:ok, _stopped} = Server.stop_session(session.id)
  end

  test "starts a codex session from agent identity and stored credentials" do
    Application.put_env(:symphony_elixir, :worker_bridge_test_agents, [
      %Agent{id: "agent-1", workspace_id: "workspace-1"}
    ])

    Application.put_env(:symphony_elixir, :worker_bridge_test_credentials, [
      %StoredCredential{
        id: "cred-1:OPENAI_API_KEY",
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        env_var: "OPENAI_API_KEY",
        has_secret: true,
        launchable_kind: "codex",
        secret_value: "sk-test"
      }
    ])

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "agent_id" => "agent-1",
               "workspace_id" => "workspace-1",
               "credential_id" => "cred-1:OPENAI_API_KEY"
             })

    assert session.agent_id == "agent-1"
    assert session.workspace_id == "workspace-1"
    assert session.credential_id == "cred-1:OPENAI_API_KEY"
    assert session.env_keys == ["OPENAI_API_KEY"]
    assert File.dir?(session.cwd)
  end

  test "rejects identity launches with invalid path segments before creating directories" do
    Application.put_env(:symphony_elixir, :worker_bridge_test_agents, [
      %Agent{id: "agent-1", workspace_id: ".."}
    ])

    Application.put_env(:symphony_elixir, :worker_bridge_test_credentials, [
      %StoredCredential{
        id: "cred-1:OPENAI_API_KEY",
        agent_id: "agent-1",
        workspace_id: "..",
        env_var: "OPENAI_API_KEY",
        has_secret: true,
        launchable_kind: "codex",
        secret_value: "sk-test"
      }
    ])

    invalid_workspace =
      Config.settings!().workspace.root
      |> Path.join("..")
      |> Path.join("agent-1")
      |> Path.expand()

    refute File.exists?(invalid_workspace)

    assert {:error, :invalid_identity_path} =
             Server.start_session(%{
               "kind" => "codex",
               "agent_id" => "agent-1",
               "workspace_id" => "..",
               "credential_id" => "cred-1:OPENAI_API_KEY"
             })

    refute File.exists?(invalid_workspace)
  end

  test "starts a codex session from secret_ref-backed stored credentials" do
    test_pid = self()

    Application.put_env(:symphony_elixir, :worker_bridge_test_agents, [
      %Agent{id: "agent-1", workspace_id: "workspace-1"}
    ])

    Application.put_env(:symphony_elixir, :worker_bridge_test_credentials, [
      %StoredCredential{
        id: "cred-1:OPENAI_API_KEY",
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        env_var: "OPENAI_API_KEY",
        has_secret: true,
        launchable_kind: "codex",
        secret_ref: "arn:aws:secretsmanager:us-east-1:123:secret:test",
        aliases: ["OPENAI_API_KEY", "openai_api_key", "api_key"]
      }
    ])

    Application.put_env(
      :symphony_elixir,
      :worker_bridge_secret_ref_resolver,
      fn secret_ref, aliases ->
        send(test_pid, {:resolved_secret_ref, secret_ref, aliases})
        {:ok, "resolved-secret"}
      end
    )

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "agent_id" => "agent-1",
               "workspace_id" => "workspace-1",
               "credential_id" => "cred-1:OPENAI_API_KEY"
             })

    assert session.env_keys == ["OPENAI_API_KEY"]

    assert_receive {:resolved_secret_ref, "arn:aws:secretsmanager:us-east-1:123:secret:test", ["OPENAI_API_KEY", "openai_api_key", "api_key"]}
  end

  test "returns an error when the agent inventory adapter raises" do
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, RaisingAgentInventory)

    assert {:error, {:agent_inventory_unavailable, "agent inventory endpoint is required"}} =
             Server.start_session(%{
               "kind" => "codex",
               "agent_id" => "agent-1",
               "workspace_id" => "workspace-1",
               "credential_id" => "cred-1:OPENAI_API_KEY"
             })
  end

  test "stops a running session" do
    cwd = create_workspace_dir!("worker_bridge_stop")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "command" => "sleep 30",
               "cwd" => cwd
             })

    assert {:ok, stopped} = Server.stop_session(session.id)
    assert stopped.status == "stopped"
    assert stopped.exit_status == 0
  end

  test "writes lease metadata and extends idle deadline on heartbeat", %{lease_registry: lease_registry} do
    Application.put_env(:symphony_elixir, :worker_bridge_test_agents, [
      %Agent{id: "agent-lease", workspace_id: "workspace-lease"}
    ])

    Application.put_env(:symphony_elixir, :worker_bridge_test_credentials, [
      %StoredCredential{
        id: "cred-lease",
        agent_id: "agent-lease",
        workspace_id: "workspace-lease",
        env_var: "OPENAI_API_KEY",
        has_secret: true,
        launchable_kind: "codex",
        secret_value: "sk-test"
      }
    ])

    cwd = create_workspace_dir!("worker_bridge_lease")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "command" => "sleep 30",
               "cwd" => cwd,
               "agent_id" => "agent-lease",
               "workspace_id" => "workspace-lease",
               "credential_id" => "cred-lease",
               "lease" => %{
                 "idle_timeout_ms" => 1_000,
                 "max_lifetime_ms" => 60_000,
                 "materialized_grant_versions" => %{"grant-1" => 3}
               }
             })

    assert {:ok,
            %RuntimeLeaseRegistry.Lease{
              kind: "session",
              workspace_id: "workspace-lease",
              agent_id: "agent-lease",
              materialized_grant_versions: %{"grant-1" => 3}
            }} = RuntimeLeaseRegistry.get_lease(lease_registry, session.id)

    Process.sleep(10)

    assert {:ok, heartbeat} = Server.heartbeat_session(session.id)
    assert heartbeat.idle_expires_at > session.idle_expires_at

    assert {:ok, _stopped} = Server.stop_session(session.id)
  end

  test "reaps expired leased repository workspace but preserves active workspace", %{lease_registry: lease_registry} do
    active_workspace = create_workspace_dir!("worker_bridge_active_lease")
    expired_workspace = create_workspace_dir!("worker_bridge_expired_lease")

    on_exit(fn ->
      File.rm_rf(active_workspace)
      File.rm_rf(expired_workspace)
    end)

    now = DateTime.utc_now()

    assert {:ok, _active_lease} =
             RuntimeLeaseRegistry.upsert_lease(lease_registry, %{
               id: "active-session",
               kind: "session",
               session_id: "active-session",
               workspace_path: active_workspace,
               idle_expires_at: DateTime.add(now, 60_000, :millisecond)
             })

    assert {:ok, _expired_lease} =
             RuntimeLeaseRegistry.upsert_lease(lease_registry, %{
               id: "expired-session",
               kind: "session",
               session_id: "expired-session",
               workspace_path: expired_workspace,
               idle_expires_at: DateTime.add(now, -1, :millisecond)
             })

    assert %{stale_missing_sessions: 1, reaped_sessions: 0, cleanup_failures: 0} =
             Server.reap_stale_sessions(now: now)

    assert File.dir?(active_workspace)
    refute File.exists?(expired_workspace)
  end

  test "active warm worker stays alive while heartbeats continue and stops after idle timeout" do
    cwd = create_workspace_dir!("worker_bridge_warm_worker")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "command" => "sleep 30",
               "cwd" => cwd,
               "lease" => %{"idle_timeout_ms" => 150, "max_lifetime_ms" => 60_000}
             })

    Process.sleep(75)
    assert {:ok, heartbeat} = Server.heartbeat_session(session.id)
    assert heartbeat.status == "running"
    assert %{reaped_sessions: 0} = Server.reap_stale_sessions(now: DateTime.utc_now())

    Process.sleep(180)
    assert %{reaped_sessions: 1} = Server.reap_stale_sessions(now: DateTime.utc_now())
    assert {:ok, stopped} = Server.get_session(session.id)
    assert stopped.status == "stale"
  end

  test "rejects non-string env values" do
    cwd = create_workspace_dir!("worker_bridge_invalid_env")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:error, :invalid_env} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => cwd,
               "env" => %{"OPENAI_TIMEOUT" => 30}
             })
  end

  test "rejects a cwd that does not exist yet" do
    missing_cwd =
      Path.join(
        Config.settings!().workspace.root,
        "worker_bridge_missing_#{System.unique_integer([:positive])}"
      )

    refute File.exists?(missing_cwd)

    assert {:ok, canonical_missing_cwd} = SymphonyElixir.PathSafety.canonicalize(missing_cwd)

    assert {:error, {:cwd_not_found, ^canonical_missing_cwd}} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => missing_cwd
             })
  end

  test "rejects invalid env var names before opening a port" do
    cwd = create_workspace_dir!("worker_bridge_invalid_env_name")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:error, :invalid_env} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => cwd,
               "env" => %{"A=B" => "x"}
             })
  end

  test "rejects invalid credential-derived env var names" do
    cwd = create_workspace_dir!("worker_bridge_invalid_credential_env_name")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:error, :invalid_env} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => cwd,
               "credentials" => %{
                 "BAD=NAME" => "secret"
               }
             })
  end

  test "preserves recorded exit status when stopping an exited session" do
    cwd = create_workspace_dir!("worker_bridge_exit_status")

    on_exit(fn -> File.rm_rf(cwd) end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "cwd" => cwd,
               "command" => "exit 7"
             })

    wait_for_status(session.id, "exited")

    assert {:ok, stopped} = Server.stop_session(session.id)
    assert stopped.status == "stopped"
    assert stopped.exit_status == 7
  end

  test "cleans repository workspaces after process exit" do
    repo_path =
      Path.join(
        System.tmp_dir!(),
        "worker_bridge_exit_repo_#{System.unique_integer([:positive])}"
      )

    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, "README.md"), "# exit cleanup\n")
    git!(["add", "README.md"], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    on_exit(fn ->
      File.rm_rf!(repo_path)
    end)

    assert {:ok, session} =
             Server.start_session(%{
               "kind" => "codex",
               "repository" => %{
                 "url" => repo_path,
                 "ref" => "main"
               },
               "command" => "exit 0"
             })

    wait_for_status(session.id, "exited")
    refute File.exists?(session.cwd)
  end

  defp wait_for_file(path, attempts \\ 30)

  defp wait_for_file(path, attempts) when attempts > 0 do
    case File.read(path) do
      {:ok, contents} ->
        contents

      {:error, _reason} ->
        Process.sleep(50)
        wait_for_file(path, attempts - 1)
    end
  end

  defp wait_for_file(path, 0) do
    raise "timed out waiting for file #{path}"
  end

  defp wait_for_status(session_id, expected_status, attempts \\ 30)

  defp wait_for_status(session_id, expected_status, attempts) when attempts > 0 do
    case Server.get_session(session_id) do
      {:ok, %{status: ^expected_status}} ->
        :ok

      _ ->
        Process.sleep(50)
        wait_for_status(session_id, expected_status, attempts - 1)
    end
  end

  defp wait_for_status(session_id, expected_status, 0) do
    raise "timed out waiting for #{session_id} to reach status #{expected_status}"
  end

  defp shell_escape(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end

  defp git!(args, opts) do
    case System.cmd("git", args, Keyword.merge([stderr_to_stdout: true], opts)) do
      {_output, 0} -> :ok
      {output, status} -> raise "git failed status=#{status}: #{output}"
    end
  end

  defp create_workspace_dir!(prefix) do
    path =
      Path.join(
        Config.settings!().workspace.root,
        "#{prefix}_#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(path)
    path
  end

  defp create_git_repo!(prefix, filename, contents) do
    repo_path = Path.join(System.tmp_dir!(), "#{prefix}_#{System.unique_integer([:positive])}")
    File.rm_rf!(repo_path)
    File.mkdir_p!(repo_path)

    git!(["init", "-b", "main"], cd: repo_path)
    git!(["config", "user.name", "Worker Bridge Test"], cd: repo_path)
    git!(["config", "user.email", "worker-bridge@example.com"], cd: repo_path)
    File.write!(Path.join(repo_path, filename), contents)
    git!(["add", filename], cd: repo_path)
    git!(["commit", "-m", "initial"], cd: repo_path)

    repo_path
  end

  defp resource(id, grant_id, version) do
    %{
      "id" => id,
      "type" => "git_repository",
      "required" => true,
      "grant" => grant(grant_id, version)
    }
  end

  defp grant(id, version, opts \\ []) do
    %{
      "id" => id,
      "version" => version,
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "enabled" => true,
      "mode" => Keyword.get(opts, :mode, "planning_readonly"),
      "credential_ref" =>
        Keyword.get(opts, :credential_ref, %{
          "kind" => "github_app_installation",
          "id" => "cred-1"
        })
    }
  end
end
