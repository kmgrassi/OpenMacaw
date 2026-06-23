defmodule SymphonyElixir.Gateway.ChatRunnerTestSupport do
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential
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
         runner: SymphonyElixir.Gateway.ChatRunnerTestSupport.TestManagerRunner,
         provider: "openai_compatible",
         model: "manager-model",
         on_message: fn message -> send(owner, {:resolver_on_message, message}) end,
         message_recorder_scope: SymphonyElixir.Gateway.ChatRunnerTestSupport.manager_scope("workspace-1")
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
           },
           %{
             "name" => "repo.list",
             "description" => "List repository files",
             "inputSchema" => %{
               "type" => "object",
               "properties" => %{
                 "workspace_id" => %{"type" => "string"},
                 "repo_id" => %{"type" => "string"},
                 "path" => %{"type" => "string"}
               },
               "required" => ["workspace_id", "repo_id", "path"]
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

  def setup_local_relay_routing(req_module, rule_overrides \\ %{}) do
    Registry.reset!()

    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, req_module})

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

    Req.Test.stub(req_module, fn conn ->
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

  def setup_manager_profile_routing(req_module, rule_overrides) do
    Registry.reset!()

    put_app_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, req_module})

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

    Req.Test.stub(req_module, fn conn ->
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

  def relay_agent do
    %Agent{
      id: "relay-1",
      slug: "relay",
      name: "Relay",
      workspace_id: "workspace-1",
      type: "coding",
      context: "Chat through the local relay"
    }
  end

  def relay_scope do
    %{
      agent_id: "relay-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "agent:relay-1:main"
    }
  end

  def manager_agent do
    %Agent{
      id: "manager-1",
      slug: "manager",
      name: "Manager",
      workspace_id: "workspace-1",
      type: "manager",
      context: "Coordinate the workspace"
    }
  end

  def learning_agent do
    %Agent{
      id: "learning-1",
      slug: "learning",
      name: "Learning",
      workspace_id: "workspace-1",
      type: "learning",
      context: "Review transcripts"
    }
  end

  def router_agent do
    %Agent{
      id: "router-1",
      slug: "router",
      name: "Router",
      workspace_id: "workspace-1",
      type: "router",
      context: "Review routing performance"
    }
  end

  def coding_agent do
    %Agent{
      id: "coding-1",
      slug: "coding",
      name: "Coding",
      workspace_id: "workspace-1",
      type: "coding",
      context: "Work on code"
    }
  end

  def planning_agent do
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

  def planner_scope do
    %{
      agent_id: "planner-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      session_key: "agent:planner-1:main"
    }
  end

  def manager_scope(workspace_id) do
    %{
      agent_id: "manager-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:manager-1:main"
    }
  end

  def learning_scope(workspace_id) do
    %{
      agent_id: "learning-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:learning-1:main"
    }
  end

  def router_scope(workspace_id) do
    %{
      agent_id: "router-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:router-1:main"
    }
  end

  def coding_scope(workspace_id) do
    %{
      agent_id: "coding-1",
      workspace_id: workspace_id,
      user_id: "user-1",
      session_key: "agent:coding-1:main"
    }
  end

  defp put_app_env(app, key, value), do: Application.put_env(app, key, value)

  defp put_system_envs(pairs) do
    Enum.each(pairs, fn {key, value} -> System.put_env(key, value) end)
  end
end
