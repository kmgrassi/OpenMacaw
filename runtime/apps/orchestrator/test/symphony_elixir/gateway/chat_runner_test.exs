defmodule SymphonyElixir.Gateway.ChatRunnerTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Gateway.ChatRunner
  alias SymphonyElixir.LocalRelay.Registry
  alias SymphonyElixir.WorkItem

  defmodule TestAgentInventory do
    def list_agents, do: {:ok, []}

    def get_agent("relay-1") do
      {:ok,
       %Agent{
         id: "relay-1",
         slug: "relay",
         name: "Relay",
         workspace_id: "workspace-1",
         type: "coding",
         created_by_user_id: "user-1"
       }}
    end

    def get_agent("manager-1") do
      {:ok,
       %Agent{
         id: "manager-1",
         slug: "manager",
         name: "Manager",
         workspace_id: "workspace-1",
         type: "manager",
         created_by_user_id: "user-1"
       }}
    end

    def get_agent("coding-1") do
      {:ok,
       %Agent{
         id: "coding-1",
         slug: "coding",
         name: "Coding",
         workspace_id: "workspace-1",
         type: "coding",
         created_by_user_id: "user-1"
       }}
    end

    def get_agent(_agent_id), do: {:error, :not_found}

    def list_credentials("planner-1") do
      {:ok,
       [
         %StoredCredential{
           id: "credential-openai",
           agent_id: "planner-1",
           workspace_id: "workspace-1",
           provider: "openai",
           label: "OpenAI",
           env_var: "OPENAI_API_KEY",
           has_secret: true,
           secret_value: "test-openai-key",
           aliases: ["OPENAI_API_KEY", "api_key"]
         }
       ]}
    end

    def list_credentials("relay-1") do
      {:ok,
       [
         %StoredCredential{
           id: "cred-relay:OPENAI_API_KEY",
           agent_id: "relay-1",
           workspace_id: "workspace-1",
           provider: "openclaw",
           label: "OpenClaw",
           env_var: "OPENAI_API_KEY",
           has_secret: true,
           secret_value: "test-relay-key",
           aliases: []
         }
       ]}
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  defmodule TestSessionResolver do
    def resolve("workspace-1") do
      owner = owner()

      send(owner, {:manager_session_resolved, "workspace-1"})

      {:ok,
       %{
         workspace_id: "workspace-1",
         runner: SymphonyElixir.Gateway.ChatRunnerTest.TestManagerRunner,
         provider: "openai_compatible",
         model: "manager-model",
         on_message: fn message -> send(owner, {:resolver_on_message, message}) end,
         message_recorder_scope: %{
           agent_id: "manager-1",
           workspace_id: "workspace-1",
           user_id: "user-1",
           session_key: "agent:manager-1:main"
         }
       }, %{agent_id: "manager-1"}}
    end

    def resolve("idle-workspace") do
      {:idle, :config_missing, %{status: :idle_awaiting_config}}
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :chat_runner_test_owner)
  end

  defmodule TestManagerRunner do
    def run_turn(session, prompt, %WorkItem{} = work_item) do
      send(owner(), {:manager_run_turn, session, prompt, work_item})

      session.on_message.(%{
        type: :notification,
        payload: %{"text" => "manager event"}
      })

      {:ok, %{"response_id" => "resp-1", "output_text" => "manager response"}}
    end

    def stop_session(session) do
      send(owner(), {:manager_stop_session, session})
      :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :chat_runner_test_owner)
  end

  defmodule TestManagerToolDefinitionResolver do
    def resolve_for_agent("manager-1") do
      {:ok,
       %{
         tool_definitions: [
           %{
             "name" => "git.run",
             "description" => "Run a git command",
             "inputSchema" => %{
               "type" => "object",
               "properties" => %{
                 "command" => %{"type" => "string"}
               },
               "required" => ["command"]
             }
           }
         ]
       }}
    end

    def resolve_for_agent(_agent_id), do: {:ok, %{tool_definitions: []}}
  end

  defmodule TestEmptyManagerToolDefinitionResolver do
    def resolve_for_agent("manager-1"), do: {:ok, %{tool_definitions: []}}
    def resolve_for_agent(_agent_id), do: {:error, :not_found}
  end

  setup do
    put_app_env(:symphony_elixir, :chat_runner_test_owner, self())
    put_app_env(:symphony_elixir, :gateway_manager_session_resolver, TestSessionResolver)

    :ok
  end

  test "planning agents resolve stored OpenAI credentials for gateway chat turns" do
    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :planner_responses_req_options, plug: {Req.Test, __MODULE__})

    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/v1/responses"} ->
          send(test_pid, {:authorization, Plug.Conn.get_req_header(conn, "authorization")})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "resp-chat",
              "status" => "completed",
              "output" => [
                %{
                  "type" => "message",
                  "role" => "assistant",
                  "content" => [%{"type" => "output_text", "text" => "Planner response"}]
                }
              ]
            })
          )
      end
    end)

    assert :ok =
             ChatRunner.run(
               planning_agent(),
               planner_scope(),
               "hello planner",
               "run-planner",
               self()
             )

    assert_receive {:authorization, ["Bearer test-openai-key"]}

    assert_receive {:gateway_runner_complete, "agent:planner-1:main", "run-planner", {:ok, %{"output_text" => "Planner response"} = result}}

    assert result["model"] == "gpt-test"
    assert result["provider"] == "openai"
    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "manager agents dispatch through SessionResolver and Runner.LlmToolRunner-compatible turns" do
    agent = manager_agent()
    scope = scope("workspace-1")

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-1", self())

    assert_received {:manager_session_resolved, "workspace-1"}

    assert_received {:manager_run_turn, session, "hello manager", work_item}
    assert session.provider == "openai_compatible"
    assert session.model == "manager-model"
    assert work_item.id == "agent:manager-1:main"
    assert work_item.identifier == "manager"
    assert work_item.runner_type == "manager"
    assert work_item.metadata == %{"run_id" => "run-1"}

    assert_received {:resolver_on_message, %{payload: %{"text" => "manager event"}} = event}
    assert_received {:gateway_runner_event, "agent:manager-1:main", "run-1", ^event}

    assert_received {:gateway_runner_complete, "agent:manager-1:main", "run-1", {:ok, result}}
    assert result["response_id"] == "resp-1"
    assert result["output_text"] == "manager response"
    assert result["provider"] == "openai_compatible"
    assert result["model"] == "manager-model"

    assert_received {:manager_stop_session, stopped_session}
    assert stopped_session.workspace_id == "workspace-1"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "learning agents dispatch through Runner.LlmToolRunner-compatible turns" do
    agent = learning_agent()

    scope =
      "workspace-1"
      |> learning_scope()
      |> Map.put(:manager_session, %{
        workspace_id: "workspace-1",
        runner: TestManagerRunner,
        provider: "openai_compatible",
        model: "learning-model"
      })

    assert :ok = ChatRunner.run(agent, scope, "review transcript", "run-learning", self())

    assert_received {:manager_run_turn, session, "review transcript", work_item}
    assert session.provider == "openai_compatible"
    assert session.model == "learning-model"
    assert work_item.id == "agent:learning-1:main"
    assert work_item.identifier == "learning"
    assert work_item.runner_type == "manager"

    assert_received {:gateway_runner_complete, "agent:learning-1:main", "run-learning", {:ok, result}}

    assert result["output_text"] == "manager response"
    assert result["provider"] == "openai_compatible"
    assert result["model"] == "learning-model"
  end

  test "router agents dispatch through Runner.LlmToolRunner-compatible turns" do
    agent = router_agent()

    scope =
      "workspace-1"
      |> router_scope()
      |> Map.put(:manager_session, %{
        workspace_id: "workspace-1",
        runner: TestManagerRunner,
        provider: "openai_compatible",
        model: "router-model",
        tool_bundle: :router
      })

    assert :ok = ChatRunner.run(agent, scope, "review routing", "run-router", self())

    assert_received {:manager_run_turn, session, "review routing", work_item}
    assert session.provider == "openai_compatible"
    assert session.model == "router-model"
    assert session.tool_bundle == :router
    assert work_item.id == "agent:router-1:main"
    assert work_item.identifier == "router"
    assert work_item.runner_type == "manager"

    assert_received {:gateway_runner_complete, "agent:router-1:main", "run-router", {:ok, result}}

    assert result["output_text"] == "manager response"
    assert result["provider"] == "openai_compatible"
    assert result["model"] == "router-model"
  end

  test "coding agents with llm_tool_runner routes dispatch through Runner.LlmToolRunner-compatible turns" do
    agent = coding_agent()

    scope =
      "workspace-1"
      |> coding_scope()
      |> Map.put(:manager_session, %{
        workspace_id: "workspace-1",
        runner: TestManagerRunner,
        provider: "openai",
        model: "gpt-5.2",
        tool_bundle: :coding
      })

    setup_manager_profile_routing(%{
      "id" => "rule-coding",
      "agent_id" => "coding-1",
      "runner_kind" => "llm_tool_runner",
      "provider" => "openai",
      "model" => "gpt-5.2"
    })

    assert :ok = ChatRunner.run(agent, scope, "hello coding", "run-coding", self())

    assert_received {:manager_run_turn, session, "hello coding", work_item}
    assert session.provider == "openai"
    assert session.model == "gpt-5.2"
    assert session.tool_bundle == :coding
    assert work_item.id == "agent:coding-1:main"
    assert work_item.identifier == "coding"

    assert_received {:gateway_runner_complete, "agent:coding-1:main", "run-coding", {:ok, result}}

    assert result["output_text"] == "manager response"
    assert result["provider"] == "openai"
    assert result["model"] == "gpt-5.2"
    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "manager agents do not stop caller-owned scheduler sessions" do
    agent = manager_agent()

    scope =
      "workspace-1"
      |> scope()
      |> Map.put(:manager_session, %{
        workspace_id: "workspace-1",
        runner: TestManagerRunner,
        provider: "openai_compatible",
        model: "manager-model",
        on_message: fn message -> send(self(), {:caller_on_message, message}) end
      })

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-1", self())

    refute_received {:manager_session_resolved, "workspace-1"}
    assert_received {:manager_run_turn, _session, "hello manager", _work_item}
    refute_received {:manager_stop_session, _session}
    assert_received {:gateway_runner_complete, "agent:manager-1:main", "run-1", {:ok, _result}}
  end

  test "manager resolver idle states fail the gateway run without invoking a runner" do
    agent = manager_agent()
    scope = scope("idle-workspace")

    assert :ok = ChatRunner.run(agent, scope, "hello manager", "run-idle", self())

    assert_received {:gateway_runner_failed, "agent:manager-1:main", "run-idle", {:agent_idle, :config_missing}}

    refute_received {:manager_run_turn, _session, _prompt, _work_item}
    refute_received {:gateway_runner_complete, _session_key, _run_id, _result}
  end

  test "nil manager resolver config falls back to profile resolution instead of crashing" do
    delete_app_env(:symphony_elixir, :gateway_manager_session_resolver)
    put_system_env("SUPABASE_URL", nil)
    put_system_env("LAUNCHER_SUPABASE_URL", nil)
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", nil)
    put_system_env("LAUNCHER_SUPABASE_SERVICE_KEY", nil)

    assert :ok =
             ChatRunner.run(
               manager_agent(),
               scope("workspace-1"),
               "hello manager",
               "run-nil",
               self()
             )

    assert_received {:gateway_runner_failed, "agent:manager-1:main", "run-nil", :supabase_unconfigured}

    refute_received {:manager_session_resolved, _workspace_id}
    refute_received {:manager_run_turn, _session, _prompt, _work_item}
  end

  test "manager gateway profile sessions include grant-derived tool definitions" do
    delete_app_env(:symphony_elixir, :gateway_manager_session_resolver)
    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)

    put_app_env(
      :symphony_elixir,
      :manager_tool_definition_resolver,
      TestManagerToolDefinitionResolver
    )

    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, __MODULE__})

    put_app_env(:symphony_elixir, :manager_openai_compatible_req_options, plug: {Req.Test, __MODULE__})

    put_system_envs([
      {"SUPABASE_URL", "https://test.supabase.co"},
      {"SUPABASE_SERVICE_ROLE_KEY", "test-api-key"}
    ])

    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          params = URI.decode_query(conn.query_string)

          matches =
            if params["kind"] == "eq.agent_id" do
              [%{"rule_id" => "rule-manager"}]
            else
              [
                %{
                  "rule_id" => "rule-manager",
                  "kind" => "agent_id",
                  "key" => "agent_id",
                  "value" => "manager-1"
                }
              ]
            end

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!(matches))

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "rule-manager",
                "priority" => 1,
                "runner_kind" => "manager",
                "provider" => "openai_compatible",
                "model" => "qwen-manager",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        conn.request_path == "/v1/chat/completions" ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:manager_chat_request, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "chatcmpl-manager",
              "choices" => [
                %{
                  "finish_reason" => "stop",
                  "message" => %{"role" => "assistant", "content" => "manager response"}
                }
              ]
            })
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert :ok =
             ChatRunner.run(
               manager_agent(),
               scope("workspace-1"),
               "hello manager",
               "run-manager-profile",
               self()
             )

    assert_receive {:manager_chat_request, request}
    assert [%{"type" => "function", "function" => %{"name" => "git_run"}}] = request["tools"]

    assert_receive {:gateway_runner_complete, "agent:manager-1:main", "run-manager-profile", {:ok, result}}

    assert result["output_text"] == "manager response"
    assert result["model"] == "qwen-manager"
    assert result["provider"] == "openai_compatible"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "manager gateway profile sessions preserve empty grant-derived tool definitions" do
    delete_app_env(:symphony_elixir, :gateway_manager_session_resolver)
    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)

    put_app_env(
      :symphony_elixir,
      :manager_tool_definition_resolver,
      TestEmptyManagerToolDefinitionResolver
    )

    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, __MODULE__})

    put_app_env(:symphony_elixir, :manager_openai_compatible_req_options, plug: {Req.Test, __MODULE__})

    put_system_envs([
      {"SUPABASE_URL", "https://test.supabase.co"},
      {"SUPABASE_SERVICE_ROLE_KEY", "test-api-key"}
    ])

    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          params = URI.decode_query(conn.query_string)

          matches =
            if params["kind"] == "eq.agent_id" do
              [%{"rule_id" => "rule-manager"}]
            else
              [
                %{
                  "rule_id" => "rule-manager",
                  "kind" => "agent_id",
                  "key" => "agent_id",
                  "value" => "manager-1"
                }
              ]
            end

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!(matches))

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "rule-manager",
                "priority" => 1,
                "runner_kind" => "manager",
                "provider" => "openai_compatible",
                "model" => "qwen-manager",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        conn.request_path == "/v1/chat/completions" ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:manager_chat_request, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!(%{
              "id" => "chatcmpl-manager",
              "choices" => [
                %{
                  "finish_reason" => "stop",
                  "message" => %{"role" => "assistant", "content" => "manager response"}
                }
              ]
            })
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert :ok =
             ChatRunner.run(
               manager_agent(),
               scope("workspace-1"),
               "hello manager",
               "run-manager-empty-profile",
               self()
             )

    assert_receive {:manager_chat_request, request}
    assert request["tools"] == []

    assert_receive {:gateway_runner_complete, "agent:manager-1:main", "run-manager-empty-profile", {:ok, result}}

    assert result["output_text"] == "manager response"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "local manager gateway profile sessions dispatch grant-derived tool definitions to helper" do
    delete_app_env(:symphony_elixir, :gateway_manager_session_resolver)
    setup_manager_profile_routing(%{"provider" => "local", "model" => "qwen-manager"})

    put_app_env(
      :symphony_elixir,
      :manager_tool_definition_resolver,
      TestManagerToolDefinitionResolver
    )

    test_pid = self()

    helper =
      spawn_link(fn ->
        receive do
          {:local_relay_dispatch, frame} ->
            send(test_pid, {:manager_relay_dispatch_frame, frame})

            Registry.complete(frame["correlation_id"], %{
              "output_text" => "local manager response"
            })
        end
      end)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-manager",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "local",
          model: "qwen-manager",
          capabilities: %{runtime_managed_tools: true, tool_calls: true}
        }
      ]
    })

    assert :ok =
             ChatRunner.run(
               manager_agent(),
               scope("workspace-1"),
               "hello local manager",
               "run-manager-local",
               self()
             )

    assert_receive {:manager_relay_dispatch_frame, frame}
    assert frame["runner_kind"] == "local_relay"
    assert frame["target_runner_kind"] == "openai_compatible"
    assert frame["tool_calling_mode"] == "runtime_managed"
    assert frame["provider"] == "local"
    assert frame["model"] == "qwen-manager"

    assert %{"name" => "git.run", "execution_kind" => "helper"} =
             Enum.find(frame["tool_definitions"], &(&1["name"] == "git.run"))

    assert [%{"function" => %{"name" => "git_run"}}] = frame["provider_tool_specs"]

    assert_receive {:gateway_runner_complete, "agent:manager-1:main", "run-manager-local", {:ok, result}}

    assert result["output_text"] == "local manager response"
    assert result["model"] == "qwen-manager"
    assert result["provider"] == "local"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "local_relay agents run gateway chat turns through the relay tool-calling loop" do
    setup_local_relay_routing()

    SymphonyElixir.Runner.ManagerTestSupport.configure_history_adapter([
      %{
        "role" => "assistant",
        "content" => "should not replay",
        "run_id" => "run-old",
        "created_at" => "2026-05-12T10:00:01Z"
      },
      %{
        "role" => "user",
        "content" => "old scheduled prompt",
        "run_id" => "run-old",
        "created_at" => "2026-05-12T10:00:00Z"
      }
    ])

    test_pid = self()

    helper =
      spawn_link(fn ->
        receive do
          {:local_relay_dispatch, frame} ->
            send(test_pid, {:relay_dispatch_frame, frame})

            Registry.complete(frame["correlation_id"], %{
              "output_text" => "local relay response",
              "usage" => %{"total_tokens" => 7}
            })
        end
      end)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-relay",
      pid: helper,
      runners: [
        %{
          runner_kind: "openai_compatible",
          provider: "local",
          model: "qwen-chat",
          capabilities: %{tool_calls: true}
        }
      ]
    })

    assert :ok =
             ChatRunner.run(
               relay_agent(),
               Map.put(relay_scope(), :history_window, 0),
               "hello relay",
               "run-relay",
               self()
             )

    assert_receive {:relay_dispatch_frame, frame}
    assert frame["runner_kind"] == "local_relay"
    assert frame["target_runner_kind"] == "openai_compatible"
    assert frame["tool_calling_mode"] == "cloud_managed"
    assert frame["workspace_id"] == "workspace-1"
    assert frame["agent_id"] == "relay-1"
    assert frame["session_id"] == "agent:relay-1:main"
    assert frame["run_id"] == "run-relay"
    assert frame["model"] == "qwen-chat"
    assert [%{"role" => "system", "content" => system_message} | _] = frame["messages"]
    assert system_message =~ "Agent instructions:\nChat through the local relay"
    assert system_message =~ "local_workspace_root: /Users/dev/repos/openmacaw"
    refute Enum.any?(frame["messages"], &(Map.get(&1, "content") == "should not replay"))
    assert [%{"name" => _name} | _rest] = frame["tool_definitions"]

    # Agents without persisted grants get only the universal fallback surface;
    # broad local CLI access must be explicitly granted.
    git_tool = Enum.find(frame["tool_definitions"], &(&1["name"] == "git.run"))
    refute git_tool, "did not expect git.run in no-grants local_relay tool_definitions"

    assert_receive {:gateway_runner_event, "agent:relay-1:main", "run-relay", %{event: :turn_started}}

    assert_receive {:gateway_runner_complete, "agent:relay-1:main", "run-relay", {:ok, result}}
    assert result["output_text"] == "local relay response"
    assert result["model"] == "qwen-chat"
    assert result["provider"] == "local"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "local_relay agents thread a helper-runtime provider into the relay target runner kind" do
    setup_local_relay_routing(%{
      "provider" => "openclaw",
      "model" => nil,
      "credential_id" => "cred-relay"
    })

    test_pid = self()

    helper =
      spawn_link(fn ->
        receive do
          {:local_relay_dispatch, frame} ->
            send(test_pid, {:relay_dispatch_frame, frame})
            Registry.complete(frame["correlation_id"], %{"output_text" => "openclaw response"})
        end
      end)

    Registry.register(%{
      workspace_id: "workspace-1",
      machine_id: "machine-openclaw",
      pid: helper,
      runners: [
        %{runner_kind: "openclaw", provider: "openclaw", capabilities: %{tool_calls: true}}
      ]
    })

    assert :ok =
             ChatRunner.run(
               relay_agent(),
               relay_scope(),
               "hello openclaw",
               "run-openclaw",
               self()
             )

    assert_receive {:relay_dispatch_frame, frame}
    assert frame["target_runner_kind"] == "openclaw"
    assert frame["provider"] == "openclaw"

    assert_receive {:gateway_runner_complete, "agent:relay-1:main", "run-openclaw", {:ok, result}}
    assert result["output_text"] == "openclaw response"

    refute_received {:gateway_runner_failed, _session_key, _run_id, _reason}
  end

  test "local_relay agents fail the gateway run with a typed error when no helper is online" do
    setup_local_relay_routing()

    assert :ok =
             ChatRunner.run(relay_agent(), relay_scope(), "hello relay", "run-offline", self())

    assert_receive {:gateway_runner_failed, "agent:relay-1:main", "run-offline", {:retryable, :local_runtime_offline}}

    refute_received {:gateway_runner_complete, _session_key, _run_id, _result}
  end

  defp setup_local_relay_routing(rule_overrides \\ %{}) do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)

    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, __MODULE__})

    put_system_envs([
      {"SUPABASE_URL", "https://test.supabase.co"},
      {"SUPABASE_SERVICE_ROLE_KEY", "test-api-key"}
    ])

    rule =
      Map.merge(
        %{
          "id" => "rule-relay",
          "priority" => 1,
          "runner_kind" => "local_relay",
          "provider" => "local",
          "model" => "qwen-chat",
          "enabled" => true,
          "workspace_id" => "workspace-1"
        },
        rule_overrides
      )

    Req.Test.stub(__MODULE__, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          params = URI.decode_query(conn.query_string)

          matches =
            if params["kind"] == "eq.agent_id" do
              [%{"rule_id" => "rule-relay"}]
            else
              [
                %{
                  "rule_id" => "rule-relay",
                  "kind" => "agent_id",
                  "key" => "agent_id",
                  "value" => "relay-1"
                },
                %{
                  "rule_id" => "rule-relay",
                  "kind" => "local_workspace_root",
                  "key" => "path",
                  "value" => "/Users/dev/repos/openmacaw"
                }
              ]
            end

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!(matches))

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([rule]))

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)
  end

  defp setup_manager_profile_routing(rule_overrides) do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)

    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, __MODULE__})

    put_system_envs([
      {"SUPABASE_URL", "https://test.supabase.co"},
      {"SUPABASE_SERVICE_ROLE_KEY", "test-api-key"}
    ])

    rule =
      Map.merge(
        %{
          "id" => "rule-manager",
          "priority" => 1,
          "runner_kind" => "manager",
          "provider" => "openai_compatible",
          "model" => "qwen-manager",
          "enabled" => true,
          "workspace_id" => "workspace-1"
        },
        rule_overrides
    )

    rule_id = Map.fetch!(rule, "id")

    Req.Test.stub(__MODULE__, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          params = URI.decode_query(conn.query_string)

          matches =
            if params["kind"] == "eq.agent_id" do
              [%{"rule_id" => rule_id}]
            else
              [
                %{
                  "rule_id" => rule_id,
                  "kind" => "agent_id",
                  "key" => "agent_id",
                  "value" => Map.get(rule, "agent_id") || "manager-1"
                }
              ]
            end

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!(matches))

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([rule]))

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)
  end

  defp relay_agent do
    %Agent{
      id: "relay-1",
      slug: "relay",
      name: "Relay",
      workspace_id: "workspace-1",
      type: "coding",
      context: "Chat through the local relay"
    }
  end

  defp relay_scope do
    %{
      agent_id: "relay-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "agent:relay-1:main"
    }
  end

  defp manager_agent do
    %Agent{
      id: "manager-1",
      slug: "manager",
      name: "Manager",
      workspace_id: "workspace-1",
      type: "manager",
      context: "Coordinate the workspace"
    }
  end

  defp learning_agent do
    %Agent{
      id: "learning-1",
      slug: "learning",
      name: "Learning",
      workspace_id: "workspace-1",
      type: "learning",
      context: "Review transcripts"
    }
  end

  defp router_agent do
    %Agent{
      id: "router-1",
      slug: "router",
      name: "Router",
      workspace_id: "workspace-1",
      type: "router",
      context: "Review routing performance"
    }
  end

  defp coding_agent do
    %Agent{
      id: "coding-1",
      slug: "coding",
      name: "Coding",
      workspace_id: "workspace-1",
      type: "coding",
      context: "Work on code"
    }
  end

  defp planning_agent do
    %Agent{
      id: "planner-1",
      slug: "planner",
      name: "Planner",
      workspace_id: "workspace-1",
      type: "planning",
      context: "Plan the workspace",
      model_settings: %{"model" => "gpt-test", "provider" => "openai"},
      tool_policy: %{}
    }
  end

  defp planner_scope do
    %{
      agent_id: "planner-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "agent:planner-1:main"
    }
  end

  defp scope(workspace_id) do
    %{
      agent_id: "manager-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:manager-1:main"
    }
  end

  defp learning_scope(workspace_id) do
    %{
      agent_id: "learning-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:learning-1:main"
    }
  end

  defp router_scope(workspace_id) do
    %{
      agent_id: "router-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:router-1:main"
    }
  end

  defp coding_scope(workspace_id) do
    %{
      agent_id: "coding-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:coding-1:main"
    }
  end
end
