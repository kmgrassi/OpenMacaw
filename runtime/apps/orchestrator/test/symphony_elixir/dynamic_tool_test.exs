defmodule SymphonyElixir.Codex.DynamicToolTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Codex.DynamicTool
  alias SymphonyElixir.Schema.ExecutionProfile

  test "tool_specs advertises the linear_graphql input contract" do
    assert [
             %{
               "description" => description,
               "inputSchema" => %{
                 "properties" => %{
                   "query" => _,
                   "variables" => _
                 },
                 "required" => ["query"],
                 "type" => "object"
               },
               "name" => "linear_graphql"
             },
             %{"name" => "snooze_work_item"}
           ] = DynamicTool.tool_specs()

    assert description =~ "Linear"
  end

  test "planner_tool_specs advertises repo-read and database-backed planner input contracts" do
    specs = DynamicTool.planner_tool_specs()

    assert Enum.map(specs, & &1["name"]) == [
             "repo.list",
             "repo.search",
             "repo.read_file",
             "repo.read_symbols",
             "plan.create",
             "plan.update",
             "plan.delete",
             "delegate",
             "task.create",
             "task.update",
             "task.schedule",
             "agent_tool_grant.create",
             "agent_tool_grant.update",
             "skill.create",
             "scheduled_task.create",
             "scheduled_task.read",
             "scheduled_task.update",
             "scheduled_task.list",
             "scheduled_task.delete",
             "plan.read",
             "task.read",
             "task.status",
             "planning_profile.create_update",
             "planning_profile.delete",
             "workspace_settings.manage",
             "workspace_settings.update_tracker_kind",
             "snooze_work_item"
           ]

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id", "path"],
               "properties" => %{"workspace_id" => _, "path" => _, "byte_limit" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.read_file"))

    assert %{
             "inputSchema" => %{
               "required" => ["name"],
               "properties" => %{"workspace_id" => _, "name" => _, "is_ongoing" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "plan.create"))

    assert %{
             "inputSchema" => %{
               "required" => ["plan_id"],
               "properties" => %{
                 "workspace_id" => _,
                 "plan_id" => _,
                 "status" => _,
                 "metadata" => %{"type" => "object"}
               }
             }
           } = Enum.find(specs, &(&1["name"] == "plan.update"))

    assert %{
             "inputSchema" => %{
               "required" => ["plan_id"],
               "properties" => %{"workspace_id" => _, "plan_id" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "plan.delete"))

    assert %{
             "description" => task_create_description,
             "inputSchema" => %{
               "properties" => %{
                 "when" => %{
                   "properties" => %{
                     "mode" => %{"enum" => when_modes}
                   }
                 },
                 "routing" => %{
                   "properties" => %{
                     "intent" => %{"enum" => routing_intents},
                     "runner_family" => %{"enum" => runner_families},
                     "execution_location" => %{"enum" => execution_locations},
                     "transport" => %{"enum" => transports},
                     "runner_kind" => %{"enum" => runner_kinds}
                   }
                 }
               }
             }
           } = Enum.find(specs, &(&1["name"] == "task.create"))

    assert task_create_description =~ "routing.intent"
    assert task_create_description =~ "set when to"
    assert task_create_description =~ "not manager-runnable"
    assert when_modes == ["planned", "now", "at"]
    assert "implement" in routing_intents
    assert "address_review" in routing_intents
    assert "workspace_coding" in runner_families
    assert "tool_calling_llm" in runner_families
    assert "local" in execution_locations
    assert "local_relay" in transports

    assert runner_kinds == ExecutionProfile.supported_runner_kinds() ++ [nil]

    refute "local_runtime" in runner_kinds
    refute "openclaw_http_sse" in runner_kinds

    assert %{
             "inputSchema" => %{
               "required" => ["task_id"],
               "properties" => %{"workspace_id" => _, "task_id" => _, "status" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "task.update"))

    assert %{
             "inputSchema" => %{
               "required" => ["task_id", "next_poll_at"],
               "properties" => %{
                 "workspace_id" => _,
                 "task_id" => _,
                 "next_poll_at" => %{"type" => ["string", "null"]},
                 "poll_cadence_seconds" => _
               }
             }
           } = Enum.find(specs, &(&1["name"] == "task.schedule"))

    task_schedule = Enum.find(specs, &(&1["name"] == "task.schedule"))
    assert task_schedule["description"] =~ "Scheduling alone does not make todo work manager-runnable"

    assert %{
             "description" => task_status_description,
             "inputSchema" => %{
               "required" => ["task_id"],
               "properties" => %{"workspace_id" => _, "task_id" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "task.status"))

    assert task_status_description =~ "dispatch eligibility"

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id"],
               "properties" => %{"workspace_id" => _, "path" => _, "query" => _, "kinds" => _, "limit" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.read_symbols"))
  end

  test "repository_tool_specs advertises repository read input contracts" do
    specs = DynamicTool.repository_tool_specs()

    assert Enum.map(specs, & &1["name"]) == ["repo.list", "repo.search", "repo.read_file", "repo.read_symbols"]

    assert %{
             "inputSchema" => %{
               "required" => ["workspace_id", "path"],
               "properties" => %{"workspace_id" => _, "path" => _, "byte_limit" => _}
             }
           } = Enum.find(specs, &(&1["name"] == "repo.read_file"))
  end

  test "planner tool execution returns a normal failure when Supabase is not configured" do
    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
    System.delete_env("SUPABASE_URL")
    System.delete_env("SUPABASE_SERVICE_ROLE_KEY")

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
    end)

    response =
      DynamicTool.execute("plan.create", %{"workspace_id" => "workspace-1", "name" => "Plan"})

    assert response["success"] == false

    assert %{"error" => %{"message" => "plan.create failed.", "reason" => reason}} =
             Jason.decode!(response["output"])

    assert reason =~ "missing_supabase_config"
  end

  test "allowed_tools rejects tools outside the resolved agent policy" do
    response =
      DynamicTool.execute("linear_graphql", %{"query" => "query Viewer { viewer { id } }"}, allowed_tools: ["plan.create"])

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => ~s(Dynamic tool "linear_graphql" is not allowed by this agent's tool policy.),
               "supportedTools" => ["plan.create"]
             }
           }
  end

  test "repository tools can be executed when allowed by policy" do
    root =
      Path.join(
        System.tmp_dir!(),
        "symphony-dynamic-repo-tools-#{System.unique_integer([:positive])}"
      )

    workspace = Path.join(root, "workspace-1")
    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "README.md"), "# Runtime\n")

    on_exit(fn -> File.rm_rf(root) end)

    response =
      DynamicTool.execute(
        "repo.read_file",
        %{"workspace_id" => "workspace-1", "path" => "README.md"},
        allowed_tools: ["repo.read_file"],
        workspace_root: root
      )

    assert response["success"] == true
    assert Jason.decode!(response["output"])["content"] == "# Runtime\n"
  end

  test "agent communication tools execute through the dynamic tool dispatcher" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/api/agents/agent-target/remediations"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(202, Jason.encode!(%{"id" => "rem-1"}))
    end)

    response =
      DynamicTool.execute(
        "agent.remediate",
        %{
          "workspace_id" => "workspace-1",
          "observer_agent_id" => "agent-manager",
          "target_agent_id" => "agent-target",
          "action" => "retry"
        },
        allowed_tools: ["agent.remediate"],
        control_plane_config: [endpoint: "https://platform.test"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == true
    assert Jason.decode!(response["output"])["remediation"] == %{"id" => "rem-1"}
  end

  test "snooze_work_item patches next_poll_at and writes an agent event" do
    until = DateTime.utc_now() |> DateTime.add(120, :second) |> DateTime.to_iso8601()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.wi-1"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.wi-1",
                   "workspace_id" => "eq.workspace-1"
                 }

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"next_poll_at" => until}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1", "next_poll_at" => until}]))

        {"POST", "/rest/v1/event_log"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert %{
                   "kind" => "work_item.snoozed",
                   "source" => "agent_tool",
                   "work_item_id" => "wi-1",
                   "workspace_id" => "workspace-1",
                   "payload" => %{
                     "actor" => %{"kind" => "agent", "agent_id" => "agent-1"},
                     "next_poll_at" => ^until,
                     "reason" => "wait for review"
                   }
                 } = Jason.decode!(body)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    response =
      DynamicTool.execute(
        "snooze_work_item",
        %{"work_item_id" => "wi-1", "until" => until, "reason" => "wait for review"},
        allowed_tools: ["snooze_work_item"],
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        config: [endpoint: "https://test.supabase.co", api_key: "secret"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == true
    assert Jason.decode!(response["output"])["next_poll_at"] == until
  end

  test "planner agents can call task.schedule through dynamic tool execution" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.wi-1",
                   "workspace_id" => "eq.workspace-1",
                   "order" => "id.asc",
                   "limit" => "1"
                 }

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert Jason.decode!(body) == %{"next_poll_at" => "2026-05-01T12:00:00Z"}

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1", "next_poll_at" => "2026-05-01T12:00:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    response =
      DynamicTool.execute(
        "task.schedule",
        %{
          "workspace_id" => "workspace-1",
          "task_id" => "wi-1",
          "next_poll_at" => "2026-05-01T12:00:00Z"
        },
        allowed_tools: ["task.schedule"],
        config: [endpoint: "https://test.supabase.co", api_key: "secret"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == true
    assert Jason.decode!(response["output"])["next_poll_at"] == "2026-05-01T12:00:00Z"
  end

  test "snooze_work_item rejects unauthorized agent callers before writing" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called without an agent actor")
    end)

    response =
      DynamicTool.execute(
        "snooze_work_item",
        %{"work_item_id" => "wi-1", "seconds" => 60},
        allowed_tools: ["snooze_work_item"],
        workspace_id: "workspace-1",
        config: [endpoint: "https://test.supabase.co", api_key: "secret"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == false
    assert Jason.decode!(response["output"])["error"]["reason"] =~ "unauthorized_agent_caller"
  end

  test "snooze_work_item rejects callers without a bound workspace" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when workspace scoping is missing")
    end)

    response =
      DynamicTool.execute(
        "snooze_work_item",
        %{"work_item_id" => "wi-1", "seconds" => 60},
        allowed_tools: ["snooze_work_item"],
        agent_id: "agent-1",
        config: [endpoint: "https://test.supabase.co", api_key: "secret"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == false
    assert Jason.decode!(response["output"])["error"]["reason"] =~ "missing_caller_workspace_id"
  end

  test "snooze_work_item refuses cross-workspace ids" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.wi-other"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))

        _ ->
          flunk("supabase patch/event_log should not be called for foreign work items")
      end
    end)

    response =
      DynamicTool.execute(
        "snooze_work_item",
        %{"work_item_id" => "wi-other", "seconds" => 60},
        allowed_tools: ["snooze_work_item"],
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        config: [endpoint: "https://test.supabase.co", api_key: "secret"],
        req_options: [plug: {Req.Test, __MODULE__}]
      )

    assert response["success"] == false
    assert Jason.decode!(response["output"])["error"]["reason"] =~ "work_item_not_found"
  end

  test "unsupported tool failures report policy-allowed tools when supplied" do
    allowed_tools = [
      "repo.list",
      "repo.search",
      "repo.read_file",
      "repo.read_symbols",
      "plan.create",
      "plan.update",
      "plan.delete",
      "task.create",
      "task.update",
      "task.schedule",
      "plan.read",
      "task.read",
      "task.status"
    ]

    response = DynamicTool.execute("plan.list", %{}, allowed_tools: allowed_tools)

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => ~s(Unsupported dynamic tool: "plan.list".),
               "supportedTools" => allowed_tools
             }
           }
  end

  test "allowed_tools rejects planning profile tools outside the policy" do
    for tool <- ["planning_profile.create_update", "planning_profile.delete"] do
      response =
        DynamicTool.execute(
          tool,
          %{
            "workspace_id" => "workspace-1",
            "scope_type" => "workspace",
            "scope_id" => "workspace-1"
          },
          allowed_tools: ["plan.create"]
        )

      assert response["success"] == false

      assert Jason.decode!(response["output"]) == %{
               "error" => %{
                 "message" => ~s(Dynamic tool #{inspect(tool)} is not allowed by this agent's tool policy.),
                 "supportedTools" => ["plan.create"]
               }
             }
    end
  end

  test "unsupported tools return a failure payload with the supported tool list" do
    response = DynamicTool.execute("not_a_real_tool", %{})

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => ~s(Unsupported dynamic tool: "not_a_real_tool".),
               "supportedTools" => ["linear_graphql", "snooze_work_item"]
             }
           }

    assert response["contentItems"] == [
             %{
               "type" => "inputText",
               "text" => response["output"]
             }
           ]
  end

  test "linear_graphql returns successful GraphQL responses as tool text" do
    test_pid = self()

    response =
      DynamicTool.execute(
        "linear_graphql",
        %{
          "query" => "query Viewer { viewer { id } }",
          "variables" => %{"includeTeams" => false}
        },
        linear_client: fn query, variables, opts ->
          send(test_pid, {:linear_client_called, query, variables, opts})
          {:ok, %{"data" => %{"viewer" => %{"id" => "usr_123"}}}}
        end
      )

    assert_received {:linear_client_called, "query Viewer { viewer { id } }", %{"includeTeams" => false}, []}

    assert response["success"] == true
    assert Jason.decode!(response["output"]) == %{"data" => %{"viewer" => %{"id" => "usr_123"}}}
    assert response["contentItems"] == [%{"type" => "inputText", "text" => response["output"]}]
  end

  test "linear_graphql accepts a raw GraphQL query string" do
    test_pid = self()

    response =
      DynamicTool.execute(
        "linear_graphql",
        "  query Viewer { viewer { id } }  ",
        linear_client: fn query, variables, opts ->
          send(test_pid, {:linear_client_called, query, variables, opts})
          {:ok, %{"data" => %{"viewer" => %{"id" => "usr_456"}}}}
        end
      )

    assert_received {:linear_client_called, "query Viewer { viewer { id } }", %{}, []}
    assert response["success"] == true
  end

  test "linear_graphql ignores legacy operationName arguments" do
    test_pid = self()

    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }", "operationName" => "Viewer"},
        linear_client: fn query, variables, opts ->
          send(test_pid, {:linear_client_called, query, variables, opts})
          {:ok, %{"data" => %{"viewer" => %{"id" => "usr_789"}}}}
        end
      )

    assert_received {:linear_client_called, "query Viewer { viewer { id } }", %{}, []}
    assert response["success"] == true
  end

  test "linear_graphql passes multi-operation documents through unchanged" do
    test_pid = self()

    query = """
    query Viewer { viewer { id } }
    query Teams { teams { nodes { id } } }
    """

    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => query},
        linear_client: fn forwarded_query, variables, opts ->
          send(test_pid, {:linear_client_called, forwarded_query, variables, opts})

          {:ok,
           %{
             "errors" => [
               %{
                 "message" => "Must provide operation name if query contains multiple operations."
               }
             ]
           }}
        end
      )

    assert_received {:linear_client_called, forwarded_query, %{}, []}
    assert forwarded_query == String.trim(query)
    assert response["success"] == false
  end

  test "linear_graphql rejects blank raw query strings even when using the default client" do
    response = DynamicTool.execute("linear_graphql", "   ")

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => "`linear_graphql` requires a non-empty `query` string."
             }
           }
  end

  test "linear_graphql marks GraphQL error responses as failures while preserving the body" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "mutation BadMutation { nope }"},
        linear_client: fn _query, _variables, _opts ->
          {:ok, %{"errors" => [%{"message" => "Unknown field `nope`"}], "data" => nil}}
        end
      )

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "data" => nil,
             "errors" => [%{"message" => "Unknown field `nope`"}]
           }
  end

  test "linear_graphql marks atom-key GraphQL error responses as failures" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts ->
          {:ok, %{errors: [%{message: "boom"}], data: nil}}
        end
      )

    assert response["success"] == false
  end

  test "linear_graphql validates required arguments before calling Linear" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"variables" => %{"commentId" => "comment-1"}},
        linear_client: fn _query, _variables, _opts ->
          flunk("linear client should not be called when arguments are invalid")
        end
      )

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => "`linear_graphql` requires a non-empty `query` string."
             }
           }

    blank_query =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "   "},
        linear_client: fn _query, _variables, _opts ->
          flunk("linear client should not be called when the query is blank")
        end
      )

    assert blank_query["success"] == false
  end

  test "linear_graphql rejects invalid argument types" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        [:not, :valid],
        linear_client: fn _query, _variables, _opts ->
          flunk("linear client should not be called when arguments are invalid")
        end
      )

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
             }
           }
  end

  test "linear_graphql rejects invalid variables" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }", "variables" => ["bad"]},
        linear_client: fn _query, _variables, _opts ->
          flunk("linear client should not be called when variables are invalid")
        end
      )

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => "`linear_graphql.variables` must be a JSON object when provided."
             }
           }
  end

  test "linear_graphql formats transport and auth failures" do
    missing_token =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts -> {:error, :missing_linear_api_token} end
      )

    assert missing_token["success"] == false

    assert Jason.decode!(missing_token["output"]) == %{
             "error" => %{
               "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
             }
           }

    status_error =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts -> {:error, {:linear_api_status, 503}} end
      )

    assert Jason.decode!(status_error["output"]) == %{
             "error" => %{
               "message" => "Linear GraphQL request failed with HTTP 503.",
               "status" => 503
             }
           }

    request_error =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts ->
          {:error, {:linear_api_request, :timeout}}
        end
      )

    assert Jason.decode!(request_error["output"]) == %{
             "error" => %{
               "message" => "Linear GraphQL request failed before receiving a successful response.",
               "reason" => ":timeout"
             }
           }
  end

  test "linear_graphql formats unexpected failures from the client" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts -> {:error, :boom} end
      )

    assert response["success"] == false

    assert Jason.decode!(response["output"]) == %{
             "error" => %{
               "message" => "Linear GraphQL tool execution failed.",
               "reason" => ":boom"
             }
           }
  end

  test "linear_graphql falls back to inspect for non-JSON payloads" do
    response =
      DynamicTool.execute(
        "linear_graphql",
        %{"query" => "query Viewer { viewer { id } }"},
        linear_client: fn _query, _variables, _opts -> {:ok, :ok} end
      )

    assert response["success"] == true
    assert response["output"] == ":ok"
  end
end
