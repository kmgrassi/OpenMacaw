defmodule SymphonyElixir.Runner.Planner.ResponsesApiTest do
  use SymphonyElixir.Runner.PlannerTestSupport

  test "runs a Responses API tool loop and emits normalized runner events" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          params = URI.decode_query(conn.query_string)

          case {params["scope_type"], params["scope_id"], params["workspace_id"]} do
            {"eq.agent", "eq.agent-1", "eq.workspace-1"} ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")

            {"eq.workspace", "eq.workspace-1", "eq.workspace-1"} ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")

            {"eq.global", "eq.global", "is.null"} ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")
          end

        _ ->
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
                      "name" => "scheduled_task_read",
                      "arguments" => Jason.encode!(%{})
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
                      "content" => [
                        %{"type" => "output_text", "text" => "Plan"},
                        %{"type" => "output_text", "text" => " "},
                        %{"type" => "output_text", "text" => "recorded"},
                        %{"type" => "output_text", "text" => ".\n"},
                        %{"type" => "output_text", "text" => "Next step."}
                      ]
                    }
                  ]
                })
              )

            "resp-2" ->
              send(test_pid, {:second_turn_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-3",
                  "status" => "completed",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [%{"type" => "output_text", "text" => "Continued plan."}]
                    }
                  ]
                })
              )
          end
      end
    end)

    on_message = fn message -> send(test_pid, {:planner_event, message}) end

    {:ok, session} =
      Planner.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "agent" => %{
            id: "agent-1",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          },
          on_message: on_message
        },
        nil
      )

    work_item = %WorkItem{id: "work-1", identifier: "PLAN-1", title: "Plan work"}

    assert {:ok, %{"response_id" => "resp-2", "output_text" => "Plan recorded.\nNext step."}} =
             Planner.run_turn(session, "Create a plan", work_item)

    assert_received {:first_request, first_request}
    assert first_request["model"] == "gpt-test"
    assert Enum.map(first_request["tools"], & &1["name"]) == @provider_tool_names
    assert Enum.all?(first_request["tools"], &(Map.get(&1, "name") =~ ~r/^[a-zA-Z0-9_-]+$/))
    refute Enum.any?(first_request["tools"], &(Map.get(&1, "name") == "linear_graphql"))

    assert_received {:follow_up_request, follow_up_request}
    assert Enum.map(follow_up_request["tools"], & &1["name"]) == @provider_tool_names

    assert [%{"type" => "function_call_output", "call_id" => "call-1", "output" => output}] =
             follow_up_request["input"]

    assert output =~ ~s("reason": "{:missing_argument, \\"workspace_id\\"}")

    assert_received {:planner_event,
                     %{
                       event: :tool_call_failed,
                       payload: %{"params" => %{"tool" => "scheduled_task.read"}}
                     }}

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => "Plan"}
                       }
                     }}

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => " "}
                       }
                     }}

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => "recorded"}
                       }
                     }}

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => ".\n"}
                       }
                     }}

    assert_received {:planner_event,
                     %{
                       event: :notification,
                       payload: %{
                         "method" => "codex/event/agent_message_delta",
                         "params" => %{"textDelta" => "Next step."}
                       }
                     }}

    assert_received {:planner_event, %{event: :turn_completed, payload: %{"id" => "resp-2"}}}

    assert {:ok, %{"response_id" => "resp-3", "output_text" => "Continued plan."}} =
             Planner.run_turn(session, "Continue planning", work_item)

    assert_received {:second_turn_request, second_turn_request}
    assert second_turn_request["previous_response_id"] == "resp-2"
  end

  test "preserves malformed planner tool-call arguments until execution validation" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        _ ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-bad",
                  "status" => "requires_action",
                  "output" => [
                    %{
                      "type" => "function_call",
                      "call_id" => "call-bad",
                      "name" => "scheduled_task_read",
                      "arguments" => "{\"path\""
                    }
                  ]
                })
              )

            "resp-bad" ->
              send(test_pid, {:malformed_follow_up_request, request})

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                200,
                Jason.encode!(%{
                  "id" => "resp-done",
                  "status" => "completed",
                  "output" => [
                    %{
                      "type" => "message",
                      "role" => "assistant",
                      "content" => [%{"type" => "output_text", "text" => "Handled malformed call."}]
                    }
                  ]
                })
              )
          end
      end
    end)

    assert {:ok, session} =
             Planner.start_session(
               %{
                 "api_key" => "test-key",
                 "model" => "gpt-test",
                 "agent" => %{id: "agent-1", workspace_id: "workspace-1", type: "planning", tool_policy: %{}}
               },
               nil
             )

    assert {:ok, %{"response_id" => "resp-done", "output_text" => "Handled malformed call."}} =
             Planner.run_turn(session, "List files", %WorkItem{id: "work-1", identifier: "PLAN-1"})

    assert_received {:malformed_follow_up_request, follow_up_request}

    assert [%{"type" => "function_call_output", "call_id" => "call-bad", "output" => output}] =
             follow_up_request["input"]

    assert output =~ "invalid_arguments"
    refute output =~ "missing_argument"
  end

  test "classifies follow-up Responses API failures with loop attempt count" do
    Req.Test.stub(__MODULE__, fn conn ->
      case {conn.method, conn.request_path} do
        {"GET", "/rest/v1/planning_profile"} ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")

        {"POST", "/v1/responses"} ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          request = Jason.decode!(body)

          case Map.get(request, "previous_response_id") do
            nil ->
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
                      "name" => "linear_graphql",
                      "arguments" => Jason.encode!(%{"query" => "mutation { unsafe }"})
                    }
                  ]
                })
              )

            "resp-1" ->
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(
                429,
                Jason.encode!(%{"error" => %{"message" => "rate limited"}})
              )
          end
      end
    end)

    {:ok, session} =
      Planner.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "agent" => %{
            id: "agent-1",
            workspace_id: "workspace-1",
            type: "planning",
            tool_policy: %{}
          }
        },
        nil
      )

    assert {:error, {:retryable, classification}} =
             Planner.run_turn(session, "Create a plan", %WorkItem{
               id: "work-1",
               identifier: "PLAN-1",
               title: "Plan work"
             })

    assert %{
             event: "model_call_failed",
             error_code: "provider_rate_limited",
             retryable: true,
             attempt: 2,
             reason: "rate limited"
           } = classification

    assert :ok = Planner.stop_session(session)
  end
end
