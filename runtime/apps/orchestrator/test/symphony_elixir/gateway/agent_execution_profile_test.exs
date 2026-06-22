defmodule SymphonyElixir.Gateway.AgentExecutionProfileTest do
  use SymphonyElixir.TestSupport, async: false

  alias SymphonyElixir.Gateway.AgentExecutionProfile
  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}

  defmodule AgentInventory do
    def get_agent("agent-1"),
      do:
        {:ok,
         %Agent{
           id: "agent-1",
           workspace_id: "workspace-1",
           created_by_user_id: "user-1",
           context: "  Stay terse.  "
         }}

    def get_agent("manager-1"),
      do:
        {:ok,
         %Agent{
           id: "manager-1",
           workspace_id: "workspace-1",
           created_by_user_id: "user-1",
           type: "manager"
         }}

    def get_agent("agent-orphan"),
      do: {:ok, %Agent{id: "agent-orphan", workspace_id: "workspace-1"}}

    def list_credentials("agent-1") do
      {:ok,
       [
         %StoredCredential{
           id: "cred-1:OPENAI_API_KEY",
           agent_id: "agent-1",
           workspace_id: "workspace-1",
           provider: "openai",
           aliases: ["manager-openai"]
         }
       ]}
    end
  end

  defmodule SecretResolver do
    def resolve(%StoredCredential{id: "cred-1:OPENAI_API_KEY"}) do
      {:ok, %{"OPENAI_API_KEY" => "sk-test"}}
    end
  end

  setup do
    put_app_env(:symphony_elixir, :gateway_runtime_req_options, plug: {Req.Test, AgentExecutionProfile})

    put_system_envs([
      {"SUPABASE_URL", "https://test.supabase.co"},
      {"SUPABASE_SERVICE_ROLE_KEY", "test-api-key"}
    ])

    :ok
  end

  test "prefers local_model_coding when multiple matching rules tie on priority" do
    # Coding agents typically have both an agent-scoped `local_model_coding`
    # rule and a broader `local_runtime` rule. PostgREST returns them in an
    # arbitrary order within a priority bucket, so the resolver must apply
    # the same tie-breaker the platform uses (prefer local_model_coding).
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      params = URI.decode_query(conn.query_string)

      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          assert params["workspace_id"] == "eq.workspace-1"

          rows =
            case params do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-runtime"}, %{"rule_id" => "rule-coding"}]

              %{"rule_id" => "in.(rule-runtime,rule-coding)"} ->
                [
                  %{"rule_id" => "rule-runtime", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"},
                  %{"rule_id" => "rule-coding", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"}
                ]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          assert params["id"] == "in.(rule-runtime,rule-coding)"
          assert params["workspace_id"] == "eq.workspace-1"
          assert params["enabled"] == "eq.true"
          assert params["order"] == "priority.desc.nullslast"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              # local_runtime returned first (PostgREST tie order)
              %{
                "id" => "rule-runtime",
                "priority" => 10,
                "runner_kind" => "local_runtime",
                "provider" => "openai_compatible",
                "model" => "qwen3-coder:30b",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              },
              %{
                "id" => "rule-coding",
                "priority" => 10,
                "runner_kind" => "local_model_coding",
                "provider" => "openai_compatible",
                "model" => "qwen3-coder:30b",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok, %{runner_kind: "local_model_coding", provider: "openai_compatible", model: "qwen3-coder:30b"}} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "highest-priority rule wins over a lower-priority local_model_coding rule" do
    # Mirrors the platform's `selectRoutingRule`: priority descending wins
    # outright; the local_model_coding preference only breaks ties within
    # the same priority bucket, never across buckets.
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      params = URI.decode_query(conn.query_string)

      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case params do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-relay"}, %{"rule_id" => "rule-coding"}]

              %{"rule_id" => "in.(rule-relay,rule-coding)"} ->
                [
                  %{"rule_id" => "rule-relay", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"},
                  %{"rule_id" => "rule-coding", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"}
                ]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          assert params["order"] == "priority.desc.nullslast"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              # PostgREST returns rows priority-descending
              %{
                "id" => "rule-relay",
                "priority" => 1000,
                "runner_kind" => "local_relay",
                "provider" => "local",
                "model" => "qwen3-coder:30b",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              },
              %{
                "id" => "rule-coding",
                "priority" => 10,
                "runner_kind" => "local_model_coding",
                "provider" => "openai_compatible",
                "model" => "qwen3-coder:30b",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok, %{runner_kind: "local_relay", provider: "local", model: "qwen3-coder:30b"}} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "rejects higher-priority rules with unmet non-metadata predicates" do
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      params = URI.decode_query(conn.query_string)

      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case params do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-intent"}, %{"rule_id" => "rule-coding"}]

              %{"rule_id" => "in.(rule-intent,rule-coding)"} ->
                [
                  %{"rule_id" => "rule-intent", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"},
                  %{"rule_id" => "rule-intent", "kind" => "intent", "key" => nil, "value" => "draft_plan"},
                  %{"rule_id" => "rule-coding", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"}
                ]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          assert params["order"] == "priority.desc.nullslast"

          json(conn, [
            %{
              "id" => "rule-intent",
              "priority" => 1000,
              "runner_kind" => "local_relay",
              "provider" => "local",
              "model" => "qwen3-coder:30b",
              "enabled" => true,
              "workspace_id" => "workspace-1"
            },
            %{
              "id" => "rule-coding",
              "priority" => 10,
              "runner_kind" => "local_model_coding",
              "provider" => "openai_compatible",
              "model" => "qwen3-coder:30b",
              "enabled" => true,
              "workspace_id" => "workspace-1"
            }
          ])

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok, %{runner_kind: "local_model_coding", provider: "openai_compatible", model: "qwen3-coder:30b"}} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "treats local_model_capability matches as routing metadata" do
    # Registered local runtimes write a `local_model_capability` match row
    # next to the relay rule's endpoint/machine metadata. It describes the
    # advertised model, not an agent predicate, so it must not block rule
    # selection.
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      params = URI.decode_query(conn.query_string)

      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case params do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-relay"}]

              %{"rule_id" => "in.(rule-relay)"} ->
                [
                  %{"rule_id" => "rule-relay", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"},
                  %{
                    "rule_id" => "rule-relay",
                    "kind" => "local_model_capability",
                    "key" => "tool_call",
                    "value" => "native_tools"
                  },
                  %{"rule_id" => "rule-relay", "kind" => "local_machine", "key" => "id", "value" => "machine-1"}
                ]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          json(conn, [
            %{
              "id" => "rule-relay",
              "priority" => 0,
              "runner_kind" => "local_relay",
              "provider" => "local",
              "model" => "qwen3-coder:30b",
              "enabled" => true,
              "workspace_id" => "workspace-1"
            }
          ])

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok, %{runner_kind: "local_relay", provider: "local", model: "qwen3-coder:30b"}} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "resolves routing-rule credentials into runnable profile fields" do
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      params = URI.decode_query(conn.query_string)

      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case params do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-manager"}]

              %{"rule_id" => "in.(rule-manager)"} ->
                [%{"rule_id" => "rule-manager", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"}]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          assert params["id"] == "in.(rule-manager)"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "rule-manager",
                "priority" => 1,
                "runner_kind" => "manager",
                "provider" => "openai",
                "model" => "gpt-test",
                "credential_id" => "cred-1",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok,
            %{
              agent_id: "agent-1",
              workspace_id: "workspace-1",
              runner_kind: "manager",
              provider: "openai",
              model: "gpt-test",
              credential_id: "cred-1:OPENAI_API_KEY",
              credential_scope: "openai",
              api_key: "sk-test",
              user_id: "user-1",
              context: "Stay terse."
            }} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1",
               agent_inventory: AgentInventory,
               secret_resolver: SecretResolver
             )
  end

  test "accepts llm_tool_runner routing rules for coding agents" do
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case URI.decode_query(conn.query_string) do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-manager"}]

              %{"rule_id" => "in.(rule-manager)"} ->
                [%{"rule_id" => "rule-manager", "kind" => "agent_id", "key" => "agent_id", "value" => "agent-1"}]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "rule-manager",
                "priority" => 1,
                "runner_kind" => "llm_tool_runner",
                "provider" => "openai_compatible",
                "model" => "qwen3-coder:30b",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:ok,
            %{
              agent_id: "agent-1",
              workspace_id: "workspace-1",
              agent_type: "coding",
              runner_kind: "llm_tool_runner",
              provider: "openai_compatible",
              model: "qwen3-coder:30b"
            }} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "rejects openai_codex manager profiles before credential resolution" do
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      cond do
        conn.request_path == "/rest/v1/routing_rule_match" ->
          rows =
            case URI.decode_query(conn.query_string) do
              %{"kind" => "eq.agent_id", "value" => "eq.agent-1"} ->
                [%{"rule_id" => "rule-manager-codex"}]

              %{"rule_id" => "in.(rule-manager-codex)"} ->
                [
                  %{
                    "rule_id" => "rule-manager-codex",
                    "kind" => "agent_id",
                    "key" => "agent_id",
                    "value" => "agent-1"
                  }
                ]
            end

          json(conn, rows)

        conn.request_path == "/rest/v1/routing_rule" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([
              %{
                "id" => "rule-manager-codex",
                "priority" => 1,
                "runner_kind" => "manager",
                "provider" => "openai_codex",
                "model" => "gpt-5.3-codex",
                "credential_id" => "cred-1",
                "enabled" => true,
                "workspace_id" => "workspace-1"
              }
            ])
          )

        true ->
          Plug.Conn.send_resp(conn, 404, ~s({"error":"unexpected #{conn.request_path}"}))
      end
    end)

    assert {:error, {:provider_unsupported, "openai_codex"}} =
             AgentExecutionProfile.resolve("agent-1", "workspace-1", agent_inventory: AgentInventory)
  end

  test "returns :not_found when no matching rule_ids exist" do
    Req.Test.stub(AgentExecutionProfile, fn conn ->
      assert conn.request_path == "/rest/v1/routing_rule_match"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:error, :not_found} =
             AgentExecutionProfile.resolve("agent-orphan", "workspace-1", agent_inventory: AgentInventory)
  end

  defp json(conn, body) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(200, Jason.encode!(body))
  end
end
