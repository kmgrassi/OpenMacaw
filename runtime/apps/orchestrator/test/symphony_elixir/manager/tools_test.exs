defmodule SymphonyElixir.Manager.ToolRegistryTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.AgentRunner
  alias SymphonyElixir.Orchestrator.IntentVocabulary
  alias SymphonyElixir.Schema.ExecutionProfile
  alias SymphonyElixir.ToolRegistry

  defmodule TestAgentInventory do
    def get_agent("agent-with-context"), do: {:ok, %{id: "agent-with-context", context: "Queue-local agent guidance"}}
    def get_agent("agent-without-context"), do: {:ok, %{id: "agent-without-context", context: "   "}}
    def get_agent(_agent_id), do: {:error, :not_found}
  end

  @expected_tools ~w(
    list_plans
    list_work_items
    dispatch_runner
    escalate_to_human
    snooze
    mark_done
    skill.create
    scheduled_task.create
    scheduled_task.read
    scheduled_task.update
    scheduled_task.list
    scheduled_task.delete
    git.run
  )

  setup do
    Application.put_env(:symphony_elixir, :manager_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :manager_tools_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :launcher_gateway_config_req_options, plug: {Req.Test, __MODULE__})

    Application.put_env(:symphony_elixir, :launcher_gateway_config,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :manager_tools)
      Application.delete_env(:symphony_elixir, :manager_tools_req_options)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_req_options)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config)
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
    end)

    :ok
  end

  test "tool_specs returns exactly the manager tool definitions" do
    specs = tool_specs()

    assert Enum.map(specs, & &1["name"]) == @expected_tools
    assert tool_names() == @expected_tools

    assert Enum.all?(specs, fn spec ->
             is_binary(spec["name"]) and spec["name"] != "" and
               is_binary(spec["description"]) and spec["description"] != "" and
               is_map(spec["inputSchema"])
           end)
  end

  test "every tool spec uses the expected inputSchema shape" do
    for spec <- tool_specs() do
      schema = spec["inputSchema"]

      assert schema["type"] == "object"
      assert schema["additionalProperties"] == false
      assert is_list(schema["required"])
      assert is_map(schema["properties"])
    end
  end

  test "escalate_to_human captures the structured escalation payload" do
    spec = Enum.find(tool_specs(), &(&1["name"] == "escalate_to_human"))
    properties = spec["inputSchema"]["properties"]

    assert spec["inputSchema"]["required"] == [
             "work_item_id",
             "trigger_kind",
             "question",
             "context_summary"
           ]

    assert properties["trigger_kind"]["enum"] == [
             "structural",
             "self_flagged",
             "resource",
             "gate_failure"
           ]

    assert "stuck_after_retries" in properties["reason_kind"]["enum"]
    assert properties["candidate_options"]["items"]["required"] == ["id", "label"]
  end

  test "dispatch_runner advertises intent-first routing with optional canonical runner override" do
    spec = Enum.find(tool_specs(), &(&1["name"] == "dispatch_runner"))
    schema = spec["inputSchema"]
    runner_kinds = schema["properties"]["runner_kind"]["enum"]
    intents = schema["properties"]["intent"]["enum"]

    assert schema["required"] == ["intent"]
    assert schema["properties"]["work_item"]["required"] == ["instructions"]
    assert intents == IntentVocabulary.names()
    assert runner_kinds == ExecutionProfile.supported_runner_kinds() ++ [nil]
    assert "llm_tool_runner" in runner_kinds
    assert "local_model_coding" in runner_kinds
  end

  test "dispatch_runner descriptions include the shared dispatch intent vocabulary" do
    spec = Enum.find(tool_specs(), &(&1["name"] == "dispatch_runner"))

    assert spec["description"] =~ IntentVocabulary.tool_description()

    assert spec["inputSchema"]["properties"]["intent"]["description"] =~
             IntentVocabulary.tool_description()
  end

  test "list_plans scopes to the session workspace" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/plan"
      assert conn.query_params["workspace_id"] == "eq.workspace-1"
      assert conn.query_params["limit"] == "10"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "plan-1"}]))
    end)

    assert %{"success" => true, "output" => output} =
             execute_tool(
               "list_plans",
               %{"limit" => 10},
               manager_context()
             )

    assert [%{"id" => "plan-1"}] = Jason.decode!(output)
  end

  test "list_plans accepts flat runtime workspace context" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/plan"
      assert conn.query_params["workspace_id"] == "eq.workspace-1"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "plan-1"}]))
    end)

    assert %{"success" => true, "output" => output} =
             execute_tool("list_plans", %{}, %{"workspace_id" => "workspace-1"})

    assert [%{"id" => "plan-1"}] = Jason.decode!(output)
  end

  test "list_plans rejects calls without a bound session workspace" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when session workspace is missing")
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool("list_plans", %{}, %{})

    assert Jason.decode!(output)["reason"] =~ "missing_session_workspace_id"
  end

  test "list_plans rejects cross-workspace overrides" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when workspace_id override is rejected")
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool(
               "list_plans",
               %{"workspace_id" => "workspace-other"},
               manager_context()
             )

    assert Jason.decode!(output)["reason"] =~ "must match the session workspace"
  end

  test "list_work_items can read due work items" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/work_items"
      assert conn.query_params["workspace_id"] == "eq.workspace-1"
      assert conn.query_params["state"] == "eq.running"
      assert conn.query_params["next_poll_at"] =~ "lte."
      # `work_items.url` is now a real column (harper-server#514) so the
      # SELECT is allowed — and required — to include it so the model
      # sees the canonical task URL without parsing metadata JSON.
      assert conn.query_params["select"] =~ ~r/(^|,)url(,|$)/

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1"}]))
    end)

    assert %{"success" => true, "output" => output} =
             execute_tool(
               "list_work_items",
               %{"state" => "running", "due_only" => true},
               manager_context()
             )

    assert [%{"id" => "work-1"}] = Jason.decode!(output)
  end

  test "list_work_items surfaces a PostgREST 400 as a structured error the model can act on" do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        400,
        Jason.encode!(%{
          "code" => "42703",
          "message" => "column work_items.bogus does not exist",
          "hint" => nil,
          "details" => nil
        })
      )
    end)

    assert %{"success" => false, "error" => "supabase_error", "output" => output} =
             execute_tool("list_work_items", %{}, manager_context())

    decoded = Jason.decode!(output)
    assert decoded["error"] == "supabase_error"
    # The reason is a structured map (not inspect-stringified) so the
    # model can read status + the PostgREST body fields directly.
    assert decoded["reason"]["kind"] == "http_error"
    assert decoded["reason"]["status"] == 400
    assert decoded["reason"]["body"]["code"] == "42703"
    assert decoded["reason"]["body"]["message"] =~ "does not exist"
  end

  test "list_work_items rejects calls without a bound session workspace" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when session workspace is missing")
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool("list_work_items", %{}, %{})

    assert Jason.decode!(output)["reason"] =~ "missing_session_workspace_id"
  end

  test "list_work_items rejects cross-workspace overrides" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when workspace_id override is rejected")
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool(
               "list_work_items",
               %{"workspace_id" => "workspace-other"},
               manager_context()
             )

    assert Jason.decode!(output)["reason"] =~ "must match the session workspace"
  end

  test "dispatch_runner records an in-flight dispatch and short-circuits repeats" do
    {:ok, metadata_agent} = Agent.start_link(fn -> %{} end)
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/gateway_config"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([gateway_config_row()]))

        {"GET", "/rest/v1/work_items"} ->
          metadata = Agent.get(metadata_agent, & &1)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([work_item_row(metadata)]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          %{"metadata" => metadata} = Jason.decode!(body)
          Agent.update(metadata_agent, fn _ -> metadata end)
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    dispatcher = fn work_item, route, dispatch ->
      send(parent, {:dispatched, work_item.runner_type, route, dispatch})
      :ok
    end

    args = %{
      "work_item_id" => "wi-1",
      "intent" => "address_review",
      "context" => %{"review_id" => "review-1"}
    }

    assert %{"success" => true, "output" => output} =
             execute_tool("dispatch_runner", args, %{dispatcher: dispatcher})

    assert %{"runner_session_id" => first_session_id, "idempotent" => false} =
             Jason.decode!(output)

    assert first_session_id =~ "mgr_"

    assert_received {:dispatched, "codex", route, dispatch}
    assert route["credential_id"] == "cred-1"
    assert dispatch["runner_session_id"] == first_session_id
    assert dispatch["intent"] == "address_review"

    assert %{"success" => true, "output" => output} =
             execute_tool("dispatch_runner", args, %{dispatcher: dispatcher})

    assert %{"runner_session_id" => ^first_session_id, "idempotent" => true} =
             Jason.decode!(output)

    refute_received {:dispatched, _, _, _}
  end

  test "dispatch_runner creates inline work once and dispatches it" do
    {:ok, metadata_agent} = Agent.start_link(fn -> %{} end)
    {:ok, inserted_count} = Agent.start_link(fn -> 0 end)
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          if Map.has_key?(conn.query_params, "metadata->>manager_inline_dispatch_hash") do
            rows =
              case Agent.get(inserted_count, & &1) do
                0 -> []
                _ -> [work_item_row(Agent.get(metadata_agent, & &1))]
              end

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, Jason.encode!(rows))
          else
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, Jason.encode!([work_item_row(Agent.get(metadata_agent, & &1))]))
          end

        {"POST", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)

          assert payload["workspace_id"] == "workspace-1"
          assert payload["title"] == "Fix failing specs"
          assert payload["description"] == "Fix failing specs and add coverage."
          assert payload["instructions"] == "Fix failing specs and add coverage."
          assert payload["state"] == "running"
          assert payload["source"] == "manager"
          assert payload["runner_kind"] == "codex"
          assert payload["metadata"]["created_via"] == "manager_dispatch_runner"
          assert payload["metadata"]["intent"] == "implement"
          assert is_binary(payload["metadata"]["manager_inline_dispatch_hash"])

          Agent.update(inserted_count, &(&1 + 1))
          Agent.update(metadata_agent, fn _ -> payload["metadata"] end)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([Map.merge(work_item_row(payload["metadata"]), payload)]))

        {"GET", "/rest/v1/gateway_config"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([gateway_config_row()]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          %{"metadata" => metadata} = Jason.decode!(body)
          Agent.update(metadata_agent, fn _ -> metadata end)
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    dispatcher = fn work_item, route, dispatch ->
      send(parent, {:inline_dispatched, work_item.id, work_item.runner_type, work_item.description, route, dispatch})
      :ok
    end

    args = %{
      "runner_kind" => "codex",
      "intent" => "implement",
      "work_item" => %{
        "title" => "Fix failing specs",
        "instructions" => "Fix failing specs and add coverage."
      }
    }

    assert %{"success" => true, "output" => output} =
             execute_tool("dispatch_runner", args, %{dispatcher: dispatcher, session: %{workspace_id: "workspace-1"}})

    assert %{"runner_session_id" => first_session_id, "idempotent" => false} = Jason.decode!(output)
    assert_received {:inline_dispatched, "wi-1", "codex", "Fix failing specs and add coverage.", route, dispatch}
    assert route["credential_id"] == "cred-1"
    assert dispatch["context"] == %{}
    assert dispatch["runner_session_id"] == first_session_id

    assert %{"success" => true, "output" => output} =
             execute_tool("dispatch_runner", args, %{dispatcher: dispatcher, session: %{workspace_id: "workspace-1"}})

    assert %{"runner_session_id" => ^first_session_id, "idempotent" => true} = Jason.decode!(output)
    assert Agent.get(inserted_count, & &1) == 1
    refute_received {:inline_dispatched, _, _, _, _, _}
  end

  test "dispatch_runner does not persist in-flight metadata when startup fails" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/gateway_config"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([gateway_config_row()]))

        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([work_item_row(%{})]))

        {"PATCH", "/rest/v1/work_items"} ->
          flunk("dispatch metadata should not be patched when dispatcher startup fails")
      end
    end)

    assert %{"success" => false, "error" => "dispatch_error"} =
             execute_tool(
               "dispatch_runner",
               %{
                 "work_item_id" => "wi-1",
                 "runner_kind" => "codex",
                 "intent" => "address_review",
                 "context" => %{}
               },
               %{
                 dispatcher: fn _work_item, _route, _dispatch ->
                   {:error, :startup_failed}
                 end
               }
             )
  end

  test "agent runner merges manager route into runner config overrides" do
    config =
      AgentRunner.build_runner_config_for_test(SymphonyElixir.Runner.Codex, "worker-1",
        runner_config_override: %{
          "model" => "gpt-5.2",
          "credential_id" => "cred-1"
        }
      )

    assert config["model"] == "gpt-5.2"
    assert config["credential_id"] == "cred-1"
    assert config.worker_host == "worker-1"
  end

  test "agent runner threads local_relay execution profile provider into target_runner_kind" do
    config =
      AgentRunner.build_runner_config_for_test(SymphonyElixir.Runner.LocalRelay, "worker-1",
        execution_profile: %{
          "role" => "coding",
          "runner_kind" => "local_relay",
          "provider" => "openclaw"
        }
      )

    assert config["target_runner_kind"] == "openclaw"
    assert config.worker_host == "worker-1"
  end

  test "agent runner threads agent context into queued local runner configs" do
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)

    config =
      AgentRunner.build_runner_config_for_test(SymphonyElixir.Runner.LocalRelay, "worker-1",
        execution_profile: %{
          "role" => "coding",
          "runner_kind" => "local_relay",
          "provider" => "local",
          "agent_id" => "agent-with-context"
        }
      )

    assert config["agent_context"] == "Queue-local agent guidance"
  end

  test "agent runner preserves explicit queued local agent context overrides" do
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)

    config =
      AgentRunner.build_runner_config_for_test(SymphonyElixir.Runner.LocalModelCoding, "worker-1",
        runner_config_override: %{"agent_context" => "Explicit override"},
        execution_profile: %{
          "role" => "coding",
          "runner_kind" => "local_model_coding",
          "provider" => "openai_compatible",
          "agent_id" => "agent-with-context"
        }
      )

    assert config["agent_context"] == "Explicit override"
  end

  test "escalate_to_human inserts an escalation and marks the work item escalated" do
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([work_item_row(%{})]))

        {"POST", "/rest/v1/escalation"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          payload = Jason.decode!(body)
          send(parent, {:escalation_insert, payload})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([Map.put(payload, "id", "esc-1")]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(parent, {:work_item_patch, Jason.decode!(body)})
          Plug.Conn.send_resp(conn, 204, "")
      end
    end)

    assert %{"success" => true, "output" => output} =
             execute_tool("escalate_to_human", %{
               "work_item_id" => "wi-1",
               "trigger_kind" => "self_flagged",
               "reason_kind" => "stuck_after_retries",
               "question" => "Which path should the agent take?",
               "context_summary" => "Two viable implementations remain."
             })

    assert %{"work_item_id" => "wi-1", "state" => "escalated", "escalation" => %{"id" => "esc-1"}} =
             Jason.decode!(output)

    assert_received {:escalation_insert, escalation}

    assert escalation == %{
             "work_item_id" => "wi-1",
             "workspace_id" => "workspace-1",
             "triggered_by" => "manager",
             "trigger_kind" => "self_flagged",
             "reason_kind" => "stuck_after_retries",
             "payload" => %{
               "question" => "Which path should the agent take?",
               "context_summary" => "Two viable implementations remain."
             }
           }

    assert_received {:work_item_patch, %{"state" => "escalated"}}
  end

  test "snooze bounds seconds and patches next_poll_at" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.wi-1"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "wi-1", "workspace_id" => "workspace-1"}])
          )

        {"PATCH", "/rest/v1/work_items"} ->
          assert URI.decode_query(conn.query_string) == %{
                   "id" => "eq.wi-1",
                   "workspace_id" => "eq.workspace-1"
                 }

          assert {"prefer", "return=representation"} in conn.req_headers

          {:ok, body, conn} = Plug.Conn.read_body(conn)
          assert %{"next_poll_at" => next_poll_at} = Jason.decode!(body)
          assert {:ok, _dt, _offset} = DateTime.from_iso8601(next_poll_at)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(
            200,
            Jason.encode!([%{"id" => "wi-1", "next_poll_at" => next_poll_at}])
          )

        {"POST", "/rest/v1/event_log"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)

          assert %{
                   "kind" => "work_item.snoozed",
                   "source" => "agent_tool",
                   "work_item_id" => "wi-1",
                   "workspace_id" => "workspace-1",
                   "payload" => %{"actor" => %{"kind" => "agent", "agent_id" => "manager"}}
                 } = Jason.decode!(body)

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))
      end
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool(
               "snooze",
               %{"work_item_id" => "wi-1", "seconds" => 9},
               manager_context()
             )

    assert Jason.decode!(output)["reason"] =~ "must be at least 10"

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool(
               "snooze",
               %{"work_item_id" => "wi-1", "seconds" => 86_401},
               manager_context()
             )

    assert Jason.decode!(output)["reason"] =~ "must be at most 86400"

    assert %{"success" => true, "output" => output} =
             execute_tool(
               "snooze",
               %{"work_item_id" => "wi-1", "seconds" => 60},
               manager_context()
             )

    assert %{"work_item_id" => "wi-1", "next_poll_at" => next_poll_at} = Jason.decode!(output)
    assert {:ok, _dt, _offset} = DateTime.from_iso8601(next_poll_at)
  end

  test "snooze rejects work items in another workspace" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.wi-other"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))

        _ ->
          flunk("supabase patch/event_log should not be called when workspace scoping rejects the row")
      end
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool(
               "snooze",
               %{"work_item_id" => "wi-other", "seconds" => 60},
               manager_context()
             )

    assert Jason.decode!(output)["reason"] =~ "work_item_not_found"
  end

  test "snooze surfaces transport failures as supabase_error" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(503, Jason.encode!(%{"message" => "service unavailable"}))

        _ ->
          flunk("subsequent supabase calls should not happen after a read failure")
      end
    end)

    assert %{"success" => false, "error" => "supabase_error"} =
             execute_tool(
               "snooze",
               %{"work_item_id" => "wi-1", "seconds" => 60},
               manager_context()
             )
  end

  test "snooze rejects calls without a bound session workspace" do
    Req.Test.stub(__MODULE__, fn _conn ->
      flunk("supabase should not be called when session workspace is missing")
    end)

    assert %{"success" => false, "error" => "invalid_arguments", "output" => output} =
             execute_tool("snooze", %{"work_item_id" => "wi-1", "seconds" => 60}, %{})

    assert Jason.decode!(output)["reason"] =~ "missing_caller_workspace_id"
  end

  test "mark_done sets state done and clears manager polling" do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "PATCH"
      assert conn.request_path == "/rest/v1/work_items"
      assert URI.decode_query(conn.query_string) == %{"id" => "eq.wi-1"}

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      assert Jason.decode!(body) == %{"state" => "done", "next_poll_at" => nil}

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1", "state" => "done"}]))
    end)

    assert %{"success" => true, "output" => output} =
             execute_tool("mark_done", %{"work_item_id" => "wi-1"})

    assert %{"work_item_id" => "wi-1", "state" => "done"} = Jason.decode!(output)
  end

  defp manager_context(workspace_id \\ "workspace-1") do
    %{session: %{workspace_id: workspace_id}}
  end

  defp work_item_row(metadata) do
    %{
      "id" => "wi-1",
      "workspace_id" => "workspace-1",
      "identifier" => "WI-1",
      "title" => "Address review",
      "description" => "Fix requested PR review comments.",
      "state" => "running",
      "priority" => "2",
      "labels" => ["code"],
      "metadata" => metadata,
      "plan_id" => nil,
      "task_id" => nil
    }
  end

  defp tool_names, do: ToolRegistry.bundle(:manager)

  defp tool_specs, do: ToolRegistry.specs(tool_names())

  defp execute_tool(name, arguments, context \\ %{}) do
    {:ok, module} = ToolRegistry.get(name)
    module.execute(arguments, context)
  end

  defp gateway_config_row do
    %{
      "id" => "gateway-config-1",
      "scope_type" => "workspace",
      "scope_id" => "workspace-1",
      "updated_at" => "2026-04-25T10:00:00Z",
      "updated_by" => "manager-tools-test",
      "version" => 1,
      "config_hash" => "hash",
      "config_json" => %{
        "routing" => %{
          "rules" => [
            %{
              "runner_kind" => "codex",
              "model" => "gpt-5.2",
              "credential_id" => "cred-1"
            }
          ]
        }
      }
    }
  end
end
