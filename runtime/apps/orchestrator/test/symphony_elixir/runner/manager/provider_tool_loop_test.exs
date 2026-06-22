defmodule SymphonyElixir.Runner.LlmToolRunner.ProviderToolLoopTest do
  use SymphonyElixir.Runner.ManagerTestSupport

  import ExUnit.CaptureLog

  alias SymphonyElixir.Cutover.Cooldown
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Planner.ToolNameMapping

  defmodule CutoverAgentInventory do
    @spec list_agents() :: {:ok, []}
    def list_agents, do: {:ok, []}

    @spec get_agent(String.t()) :: {:error, :not_found}
    def get_agent(_agent_id), do: {:error, :not_found}

    @spec list_credentials(String.t()) :: {:ok, [StoredCredential.t()]}
    def list_credentials("agent-cutover") do
      {:ok,
       [
         %StoredCredential{
           id: "cred-fallback:OPENAI_API_KEY",
           agent_id: "agent-cutover",
           workspace_id: "workspace-1",
           provider: "openai",
           env_var: "OPENAI_API_KEY",
           secret_value: "fallback-key",
           aliases: ["fallback-openai"]
         }
       ]}
    end
  end

  test "cuts over to a fallback link when the primary model rate-limits" do
    test_pid = self()
    Cooldown.clear()
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, CutoverAgentInventory)
    on_exit(fn -> Application.delete_env(:symphony_elixir, :agent_inventory_adapter) end)

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)
          auth = List.keyfind(conn.req_headers, "authorization", 0)
          send(test_pid, {:cutover_request, request, auth})

          case request["model"] do
            "gpt-4.1" ->
              assert auth == {"authorization", "Bearer primary-key"}

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(429, Jason.encode!(%{"error" => %{"code" => "rate_limit_exceeded"}}))

            "gpt-4.1-mini" ->
              assert auth == {"authorization", "Bearer fallback-key"}

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-fallback",
                  "status" => "completed",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [%{"type" => "output_text", "text" => "Recovered on fallback."}]
                    }
                  ]
                })
              )
          end
      end
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "primary-key",
          "credential_id" => "cred-primary",
          "agent_id" => "agent-cutover",
          "model" => "gpt-4.1",
          "workspace_id" => "workspace-1",
          "fallbacks" => [
            %{
              "provider" => "openai",
              "model" => "gpt-4.1-mini",
              "credential_id" => "cred-fallback"
            }
          ]
        },
        nil
      )

    assert {:ok, %{"response_id" => "resp-fallback", "output_text" => "Recovered on fallback."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{id: "work-1", identifier: "MAN-1"})

    assert_received {:cutover_request, %{"model" => "gpt-4.1"}, {"authorization", "Bearer primary-key"}}
    assert_received {:cutover_request, %{"model" => "gpt-4.1-mini"}, {"authorization", "Bearer fallback-key"}}

    assert :ok = Manager.stop_session(session)
  end

  test "escalates instead of degrading below the model tier floor" do
    test_pid = self()
    Cooldown.clear()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)
          send(test_pid, {:floor_request, request})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(429, Jason.encode!(%{"error" => %{"code" => "rate_limit_exceeded"}}))
      end
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "primary-key",
          "credential_id" => "cred-primary-floor",
          "model" => "gpt-4.1",
          "workspace_id" => "workspace-1",
          "model_tier_floor" => "mid",
          "fallbacks" => [
            %{
              "provider" => "openai_compatible",
              "model" => "qwen3-coder:30b",
              "credential_id" => "cred-local",
              "base_url" => "http://local-model.test/v1"
            }
          ]
        },
        nil
      )

    log =
      capture_log(fn ->
        assert {:error, {:fatal, {:cutover_exhausted, decision}}} =
                 Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{id: "work-1", identifier: "MAN-1"})

        assert decision.outcome == "escalated_exhausted"
      end)

    assert log =~ "attention_required"
    assert log =~ "cutover_exhausted"
    assert_received {:floor_request, %{"model" => "gpt-4.1"}}
    refute_received {:floor_request, %{"model" => "qwen3-coder:30b"}}

    assert :ok = Manager.stop_session(session)
  end

  test "runs an OpenAI-compatible chat-completions manager tool loop" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))

        {"POST", "/v1/chat/completions"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Enum.count(request["messages"], &(Map.get(&1, "role") == "tool")) do
            0 ->
              send(test_pid, {:chat_first_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "chatcmpl-1",
                  "choices" => [
                    %{
                      "finish_reason" => "tool_calls",
                      "message" => %{
                        "role" => "assistant",
                        "content" => nil,
                        "tool_calls" => [
                          %{
                            "id" => "call-1",
                            "type" => "function",
                            "function" => %{
                              "name" => "snooze",
                              "arguments" => Jason.encode!(%{"work_item_id" => "work-1", "seconds" => 300})
                            }
                          }
                        ]
                      }
                    }
                  ]
                })
              )

            1 ->
              send(test_pid, {:chat_follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "chatcmpl-2",
                  "choices" => [
                    %{
                      "finish_reason" => "stop",
                      "message" => %{"role" => "assistant", "content" => "Snoozed locally."}
                    }
                  ],
                  "usage" => %{"prompt_tokens" => 12, "completion_tokens" => 4, "total_tokens" => 16}
                })
              )
          end
      end
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "openai_compatible",
          "model" => "qwen3-coder:30b",
          "workspace_id" => "workspace-1",
          "base_url" => "http://local-model.test/v1"
        },
        nil
      )

    assert session.provider == "openai_compatible"
    assert session.model_client == ModelClient.OpenAICompatibleChat
    assert session.api_key == nil

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"response_id" => "chatcmpl-2", "output_text" => "Snoozed locally."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert_received {:chat_first_request, first_request}
    assert first_request["model"] == "qwen3-coder:30b"
    refute Map.has_key?(first_request, "previous_response_id")

    assert [
             %{"role" => "system", "content" => system},
             %{"role" => "user", "content" => ~s({"due_tasks":[]})}
           ] = first_request["messages"]

    assert system =~ "manager agent"

    assert %{
             "type" => "function",
             "function" => %{"name" => "snooze", "parameters" => %{"type" => "object"}}
           } = Enum.find(first_request["tools"], &(get_in(&1, ["function", "name"]) == "snooze"))

    assert_received {:chat_follow_up_request, follow_up_request}

    assert [
             %{"role" => "system"},
             %{"role" => "user"},
             %{"role" => "assistant", "tool_calls" => [%{"id" => "call-1"}]},
             %{"role" => "tool", "tool_call_id" => "call-1", "content" => output}
           ] = follow_up_request["messages"]

    assert %{"work_item_id" => "work-1", "next_poll_at" => _next_poll_at} = Jason.decode!(output)

    assert {:ok, %{"response_id" => "chatcmpl-2", "output_text" => "Snoozed locally."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert_received {:chat_first_request, second_turn_request}
    refute Map.has_key?(second_turn_request, "previous_response_id")

    assert :ok = Manager.stop_session(session)
  end

  test "runs a Responses API tool loop and executes local manager tools" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.work-1"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:snooze_patch, URI.decode_query(conn.query_string), Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:snooze_event, Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
              send(test_pid, {:first_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-1",
                  "status" => "requires_action",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-1",
                      "name" => "snooze",
                      "arguments" => Jason.encode!(%{"work_item_id" => "work-1", "seconds" => 300})
                    }
                  ]
                })
              )

            "resp-1" ->
              send(test_pid, {:follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-2",
                  "status" => "completed",
                  "usage" => %{"input_tokens" => 10, "output_tokens" => 5, "total_tokens" => 15},
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [%{"type" => "output_text", "text" => "Snoozed."}]
                    }
                  ]
                })
              )
          end
      end
    end)

    on_message = fn message -> send(test_pid, {:manager_event, message}) end

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "workspace_id" => "workspace-1",
          on_message: on_message
        },
        nil
      )

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"response_id" => "resp-2", "output_text" => "Snoozed."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert_received {:first_request, first_request}
    assert first_request["model"] == "gpt-test"
    assert first_request["instructions"] =~ "manager agent"
    assert first_request["metadata"]["runner"] == "manager"
    assert first_request["metadata"]["workspace_id"] == "workspace-1"
    expected_provider_tool_names =
      ToolNameMapping.runtime_to_provider(tool_names())
      |> then(fn mapping -> Enum.map(tool_names(), &Map.fetch!(mapping, &1)) end)

    assert Enum.map(first_request["tools"], & &1["name"]) == expected_provider_tool_names

    assert_received {:follow_up_request, follow_up_request}

    assert [%{"type" => "function_call_output", "call_id" => "call-1", "output" => output}] =
             follow_up_request["input"]

    assert %{"work_item_id" => "work-1", "next_poll_at" => _next_poll_at} = Jason.decode!(output)

    assert_received {:snooze_patch, %{"id" => "eq.work-1", "workspace_id" => "eq.workspace-1"}, %{"next_poll_at" => next_poll_at}}
    assert {:ok, _datetime, _offset} = DateTime.from_iso8601(next_poll_at)
    assert_received {:snooze_event, %{"kind" => "work_item.snoozed"}}

    assert_received {:manager_event,
                     %{
                       event: :tool_call_completed,
                       payload: %{"params" => %{"tool" => "snooze"}}
                     }}

    assert_received {:manager_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => "Snoozed."}
                       }
                     }}

    assert_received {:manager_event, %{event: :turn_completed, payload: %{"id" => "resp-2"}}}

    assert :ok = Manager.stop_session(session)
  end

  test "runs an OpenAI-compatible chat tool loop and sends native tool results as tool messages" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/work_items"} ->
          assert conn.query_params["id"] == "eq.work-1"
          assert conn.query_params["workspace_id"] == "eq.workspace-1"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "workspace_id" => "workspace-1"}]))

        {"PATCH", "/rest/v1/work_items"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          send(test_pid, {:chat_snooze_patch, URI.decode_query(conn.query_string), Jason.decode!(body)})

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "work-1", "next_poll_at" => "2026-04-25T12:05:00Z"}]))

        {"POST", "/rest/v1/event_log"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(201, Jason.encode!([%{"id" => "event-1"}]))

        {"POST", "/v1/chat/completions"} ->
          refute List.keyfind(conn.req_headers, "authorization", 0)
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          if Enum.any?(request["messages"], &(Map.get(&1, "role") == "tool")) do
            send(test_pid, {:chat_follow_up_request, request})

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(
              200,
              Jason.encode!(%{
                "id" => "chatcmpl-2",
                "model" => "qwen-test",
                "usage" => %{"prompt_tokens" => 10, "completion_tokens" => 5, "total_tokens" => 15},
                "choices" => [
                  %{
                    "finish_reason" => "stop",
                    "message" => %{"role" => "assistant", "content" => "Snoozed.", "tool_calls" => nil}
                  }
                ]
              })
            )
          else
            send(test_pid, {:chat_first_request, request})

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(
              200,
              Jason.encode!(%{
                "id" => "chatcmpl-1",
                "model" => "qwen-test",
                "choices" => [
                  %{
                    "finish_reason" => "tool_calls",
                    "message" => %{
                      "role" => "assistant",
                      "content" => nil,
                      "tool_calls" => [
                        %{
                          "id" => "call-1",
                          "type" => "function",
                          "function" => %{
                            "name" => "snooze",
                            "arguments" => Jason.encode!(%{"work_item_id" => "work-1", "seconds" => 300})
                          }
                        }
                      ]
                    }
                  }
                ]
              })
            )
          end
      end
    end)

    on_message = fn message -> send(test_pid, {:manager_event, message}) end

    {:ok, session} =
      Manager.start_session(
        %{
          "provider" => "openai_compatible",
          "base_url" => "http://local.test/v1",
          "model" => "ollama/qwen-test",
          "workspace_id" => "workspace-1",
          on_message: on_message
        },
        nil
      )

    work_item = %WorkItem{id: "work-1", identifier: "MAN-1", title: "Manage work"}

    assert {:ok, %{"response_id" => "chatcmpl-2", "output_text" => "Snoozed."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), work_item)

    assert_received {:chat_first_request, first_request}
    assert first_request["model"] == "qwen-test"

    assert [
             %{"role" => "system", "content" => prompt},
             %{"role" => "user", "content" => ~s({"due_tasks":[]})}
           ] = first_request["messages"]

    assert prompt =~ "manager agent"

    assert Enum.any?(
             first_request["tools"],
             &match?(%{"type" => "function", "function" => %{"name" => "snooze"}}, &1)
           )

    assert_received {:chat_follow_up_request, follow_up_request}

    assert [
             %{"role" => "system"},
             %{"role" => "user"},
             %{"role" => "assistant", "tool_calls" => [%{"id" => "call-1"}]},
             %{"role" => "tool", "tool_call_id" => "call-1", "content" => output}
           ] = follow_up_request["messages"]

    assert %{"work_item_id" => "work-1", "next_poll_at" => _next_poll_at} = Jason.decode!(output)

    assert_received {:chat_snooze_patch, %{"id" => "eq.work-1", "workspace_id" => "eq.workspace-1"}, %{"next_poll_at" => next_poll_at}}
    assert {:ok, _datetime, _offset} = DateTime.from_iso8601(next_poll_at)

    assert_received {:manager_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => "Snoozed."}
                       }
                     }}

    assert_received {:manager_event, %{event: :turn_completed, payload: %{"id" => "chatcmpl-2"}}}

    assert :ok = Manager.stop_session(session)
  end
end
