defmodule SymphonyElixir.Launcher.ServerGatewayConfigTest do
  use SymphonyElixir.LauncherServerCase, async: false

  @moduletag :launcher

  describe "gateway_config resolution" do
    test "agent-scoped gateway_config overrides the local template" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"}
      })

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-agent",
          version: 4,
          config_json: %{
            "tracker" => %{"kind" => "database", "endpoint" => "https://db"},
            "runners" => [%{"kind" => "codex"}]
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"
      assert get_in(orchestrator.config, ["runners"]) == [%{"kind" => "codex"}]
      assert get_in(orchestrator.config, ["stored_agent", "id"]) == "agent-1"

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-agent"
      assert Keyword.get(opts, :last_applied_version) == 4
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "falls back to workspace-scoped gateway_config when agent scope is missing" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"workspace", "workspace-1"} => %Resolved{
          scope_type: "workspace",
          scope_id: "workspace-1",
          config_hash: "hash-workspace",
          version: 2,
          config_json: %{"tracker" => %{"kind" => "database"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"

      assert_receive {:gateway_config_state, "workspace", "workspace-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-workspace"
      assert Keyword.get(opts, :last_applied_version) == 2
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "falls back to the local template when no gateway_config row exists" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"},
        "runners" => []
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert get_in(orchestrator.config, ["tracker", "kind"]) == "memory"

      refute_receive {:gateway_config_state, _, _, _, _}, 50
    end

    test "uses forwarded resolved execution profile with gateway_config launch settings" do
      Application.put_env(:symphony_elixir, :agent_launch_template, %{
        "tracker" => %{"kind" => "memory"}
      })

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-agent",
          version: 4,
          config_json: %{
            "tracker" => %{"kind" => "database", "endpoint" => "https://db"},
            "runners" => [%{"kind" => "planner", "provider" => "anthropic"}]
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:ok, orchestrator} =
               Server.start_agent("agent-1", %{
                 "trace_id" => "trace-1",
                 "resolved_execution_profile" => %{
                   "agentId" => "agent-1",
                   "workspaceId" => "workspace-1",
                   "role" => "coding",
                   "runnerKind" => "codex",
                   "provider" => "openai",
                   "model" => "gpt-5.2",
                   "credentialRef" => %{"type" => "credential_id", "value" => "cred-1"},
                   "toolProfile" => "coding"
                 }
               })

      assert get_in(orchestrator.config, ["tracker", "kind"]) == "database"
      assert get_in(orchestrator.config, ["tracker", "endpoint"]) == "https://db"
      assert get_in(orchestrator.config, ["runners"]) == [%{"kind" => "planner", "provider" => "anthropic"}]
      assert get_in(orchestrator.config, ["execution_profile", "runner_kind"]) == "codex"
      assert get_in(orchestrator.config, ["execution_profile", "provider"]) == "openai"
      assert get_in(orchestrator.config, ["execution_profile", "model"]) == "gpt-5.2"
      assert get_in(orchestrator.config, ["execution_profile", "credential_ref", "type"]) == "credential_id"
      assert get_in(orchestrator.config, ["resolved_execution_profile", "runner_kind"]) == "codex"

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, opts}
      assert Keyword.get(opts, :last_applied_hash) == "hash-agent"
      assert Keyword.get(opts, :last_applied_version) == 4
      assert Keyword.get(opts, :broker_instance_id) == orchestrator.id
    end

    test "records last_apply_status=error when the orchestrator fails to start" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-err"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-err",
          config_hash: "hash-err",
          version: 7,
          config_json: %{"tracker" => %{"kind" => "memory"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-err",
          name: "Broken",
          workspace_id: "workspace-1"
        }
      ])

      :sys.replace_state(Server, fn state ->
        %{state | starter: fn _opts -> {:error, :boom} end}
      end)

      assert {:error, :boom} = Server.start_agent("agent-err")

      assert_receive {:gateway_config_state, "agent", "agent-err", :error, opts}
      assert Keyword.get(opts, :last_apply_error) == ":boom"
      assert Keyword.get(opts, :broker_instance_id) == nil
    end

    test "propagates gateway_config transport errors instead of silently falling back" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => {:error, {:http_error, 500, "boom"}}
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1"
        }
      ])

      assert {:error, {:http_error, 500, "boom"}} = Server.start_agent("agent-1")
      refute_receive {:gateway_config_state, _, _, _, _}, 50
    end

    test "reuses a running orchestrator even when gateway_config is unavailable" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-1",
          version: 1,
          config_json: %{"tracker" => %{"kind" => "memory"}}
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert first.reused != true

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => {:error, {:http_error, 500, "boom"}},
        {"workspace", "workspace-1"} => {:error, {:http_error, 500, "boom"}}
      })

      assert {:ok, second} = Server.start_agent("agent-1")
      assert second.id == first.id
      assert second.reused == true
    end

    test "reuses a credentialed orchestrator when stored credential refresh is incomplete" do
      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
        %StoredCredential{
          id: "cred-openai",
          agent_id: "agent-1",
          provider: "openai",
          label: "OpenAI",
          env_var: "OPENAI_API_KEY",
          secret_value: "sk-existing",
          has_secret: true
        }
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert get_in(first.config, ["credentials", "OPENAI_API_KEY"]) == "sk-existing"

      Application.put_env(:symphony_elixir, :test_agent_inventory_credentials, [
        %StoredCredential{
          id: "cred-openai",
          agent_id: "agent-1",
          provider: "openai",
          label: "OpenAI",
          env_var: "OPENAI_API_KEY",
          secret_ref: "secret/openai",
          has_secret: true
        }
      ])

      Application.put_env(:symphony_elixir, :worker_bridge_secret_ref_resolver, fn _secret_ref, _aliases ->
        {:error, :temporarily_unavailable}
      end)

      on_exit(fn -> Application.delete_env(:symphony_elixir, :worker_bridge_secret_ref_resolver) end)

      assert {:ok, second} = Server.start_agent("agent-1")

      assert second.id == first.id
      assert second.reused == true
      assert second.restart_count == 0
      assert get_in(second.config, ["credentials", "OPENAI_API_KEY"]) == "sk-existing"
    end

    test "refreshes a running agent orchestrator when resolved config changes" do
      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-1",
          version: 1,
          config_json: %{
            "tracker" => %{"kind" => "memory"},
            "execution_profile" => %{
              "runner_kind" => "manager",
              "provider" => "local",
              "model" => "qwen3-coder:30b"
            }
          }
        }
      })

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{id: "agent-1", name: "Builder", workspace_id: "workspace-1"}
      ])

      assert {:ok, first} = Server.start_agent("agent-1")
      assert get_in(first.config, ["stored_agent", "tool_policy"]) == %{}
      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, first_opts}
      assert Keyword.get(first_opts, :last_applied_hash) == "hash-1"

      Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
        %Agent{
          id: "agent-1",
          name: "Builder",
          workspace_id: "workspace-1",
          tool_policy: %{"allowed_tools" => ["git.run", "shell.exec"]}
        }
      ])

      Application.put_env(:symphony_elixir, :test_gateway_config_rows, %{
        {"agent", "agent-1"} => %Resolved{
          scope_type: "agent",
          scope_id: "agent-1",
          config_hash: "hash-2",
          version: 2,
          config_json: %{
            "tracker" => %{"kind" => "memory"},
            "execution_profile" => %{
              "runner_kind" => "manager",
              "provider" => "local",
              "model" => "qwen3-coder:30b"
            }
          }
        }
      })

      assert {:ok, second} = Server.start_agent("agent-1")

      assert second.id == first.id
      assert second.port == first.port
      assert second.reused == false
      assert second.restart_count == 1
      assert get_in(second.config, ["stored_agent", "tool_policy", "allowed_tools"]) == ["git.run", "shell.exec"]

      assert_receive {:gateway_config_state, "agent", "agent-1", :ok, second_opts}
      assert Keyword.get(second_opts, :last_applied_hash) == "hash-2"
      assert Keyword.get(second_opts, :last_applied_version) == 2
    end
  end
end
