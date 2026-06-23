defmodule SymphonyElixir.Provider.OpenAICompatibleTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Provider.OpenAICompatible

  setup do
    req_options = [plug: {Req.Test, __MODULE__}]
    %{req_options: req_options}
  end

  test "posts an OpenAI-compatible chat completion request and normalizes text, tool calls, and usage", %{
    req_options: req_options
  } do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/v1/chat/completions"
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer test-token"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      request = Jason.decode!(body)
      send(test_pid, {:request, request})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "chatcmpl-1",
          "model" => "compatible-model",
          "choices" => [
            %{
              "finish_reason" => "tool_calls",
              "message" => %{
                "role" => "assistant",
                "content" => "Need repository context.",
                "tool_calls" => [
                  %{
                    "id" => "call-1",
                    "type" => "function",
                    "function" => %{
                      "name" => "scheduled_task.list",
                      "arguments" => Jason.encode!(%{"query" => "Provider.OpenAICompatible"})
                    }
                  }
                ]
              }
            }
          ],
          "usage" => %{"prompt_tokens" => 10, "completion_tokens" => 4, "total_tokens" => 14}
        })
      )
    end)

    profile = %{
      "base_url" => "https://provider.test/v1",
      "model" => "compatible-model",
      "credential" => %{"value" => "test-token"},
      "temperature" => 0.2
    }

    messages = [%{role: "user", content: "Inspect the repo"}]

    tools = [
      %{
        "name" => "scheduled_task.list",
        "description" => "Search repository files",
        "inputSchema" => %{
          "type" => "object",
          "properties" => %{"query" => %{"type" => "string"}}
        }
      }
    ]

    assert {:ok, result} = OpenAICompatible.start_turn(profile, messages, tools, req_options: req_options)

    assert_received {:request, request}
    assert request["model"] == "compatible-model"
    assert request["temperature"] == 0.2
    assert request["messages"] == [%{"role" => "user", "content" => "Inspect the repo"}]
    assert [%{"type" => "function", "function" => function}] = request["tools"]
    assert function["name"] == "scheduled_task.list"
    assert function["parameters"]["properties"]["query"]["type"] == "string"

    assert result.provider == "openai_compatible"
    assert result.id == "chatcmpl-1"
    assert result.output_text == "Need repository context."
    assert result.finish_reason == "tool_calls"

    assert Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments])) == [
             %{
               id: "call-1",
               name: "scheduled_task.list",
               arguments: %{"query" => "Provider.OpenAICompatible"}
             }
           ]

    assert result.usage == %{"prompt_tokens" => 10, "completion_tokens" => 4, "total_tokens" => 14}

    assert [
             %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => "Need repository context."}}},
             %{event: :tool_call_started, payload: %{"method" => "tool.started", "name" => "scheduled_task.list"}},
             %{event: :tool_call_completed, payload: %{"method" => "tool.completed", "name" => "scheduled_task.list"}},
             %{event: :notification, payload: %{"method" => "usage.updated", "params" => %{"usage" => %{"total_tokens" => 14}}}},
             %{event: :turn_completed, payload: %{"method" => "run.completed"}}
           ] = result.events
  end

  test "fixture-backed fake model scenario captures provider request shape", %{req_options: req_options} do
    scenario = fake_model_scenario!("planner-create-work-item")
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/v1/chat/completions"

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:request, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(scenario["response"]))
    end)

    tools = [
      %{
        "name" => "work_item.create",
        "description" => "Create a planner work item",
        "parameters" => %{
          "type" => "object",
          "properties" => %{"title" => %{"type" => "string"}},
          "required" => ["title"]
        }
      }
    ]

    assert {:ok, result} =
             OpenAICompatible.start_turn(
               %{
                 "base_url" => "http://127.0.0.1:7999/v1",
                 "model" => "fake-openai-compatible",
                 "api_key" => "fake-token"
               },
               [%{"role" => "user", "content" => "run scenario"}],
               tools,
               req_options: req_options
             )

    assert_received {:request, request}
    assert request["model"] == "fake-openai-compatible"
    assert [%{"function" => %{"name" => "work_item.create", "parameters" => parameters}}] = request["tools"]
    assert parameters["properties"]["title"]["type"] == "string"

    assert [
             %{id: "call_fake_work_item_create", name: "work_item.create", arguments: %{"title" => "Verify direct work item creation"} = arguments}
           ] = Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments]))

    assert arguments["description"] =~ "planner-create-work-item"
  end

  test "normalizes local OpenAI-compatible chunks into runtime boundary events" do
    chunks = [
      %{
        "id" => "chatcmpl-local",
        "model" => "qwen2.5-coder:latest",
        "choices" => [
          %{
            "delta" => %{
              "role" => "assistant",
              "content" => "Need "
            }
          }
        ]
      },
      %{
        "id" => "chatcmpl-local",
        "model" => "qwen2.5-coder:latest",
        "choices" => [
          %{
            "delta" => %{"content" => "context."}
          }
        ]
      },
      %{
        "id" => "chatcmpl-local",
        "model" => "qwen2.5-coder:latest",
        "choices" => [
          %{
            "delta" => %{
              "tool_calls" => [
                %{
                  "index" => 0,
                  "id" => "call-1",
                  "type" => "function",
                  "function" => %{"name" => "scheduled_task.list", "arguments" => "{\"query\""}
                }
              ]
            }
          }
        ]
      },
      %{
        "id" => "chatcmpl-local",
        "model" => "qwen2.5-coder:latest",
        "choices" => [
          %{
            "delta" => %{
              "tool_calls" => [
                %{
                  "index" => 0,
                  "function" => %{"arguments" => ":\"Provider\"}"}
                }
              ]
            },
            "finish_reason" => "tool_calls"
          }
        ],
        "usage" => %{"prompt_tokens" => 8, "completion_tokens" => 6, "total_tokens" => 14}
      }
    ]

    result = OpenAICompatible.normalize_chunks(chunks, "fallback-model")

    assert result.provider == "openai_compatible"
    assert result.id == "chatcmpl-local"
    assert result.model == "qwen2.5-coder:latest"
    assert result.output_text == "Need context."
    assert result.finish_reason == "tool_calls"
    assert result.usage == %{"prompt_tokens" => 8, "completion_tokens" => 6, "total_tokens" => 14}

    assert Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments])) == [
             %{id: "call-1", name: "scheduled_task.list", arguments: %{"query" => "Provider"}}
           ]

    assert [
             %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => "Need "}}},
             %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => "context."}}},
             %{event: :tool_call_started, payload: %{"method" => "tool.started", "callId" => "call-1"}},
             %{event: :tool_call_completed, payload: %{"method" => "tool.completed", "arguments" => %{"query" => "Provider"}}},
             %{event: :notification, payload: %{"method" => "usage.updated", "params" => %{"usage" => %{"total_tokens" => 14}}}},
             %{event: :turn_completed, payload: %{"method" => "run.completed", "params" => %{"output" => "Need context."}}}
           ] = result.events
  end

  test "normalizes local OpenAI-compatible chunk failures" do
    result =
      OpenAICompatible.normalize_chunks(
        [
          %{"id" => "chatcmpl-local", "choices" => [%{"delta" => %{"content" => "partial"}}]},
          %{"error" => %{"message" => "model not found", "code" => "model_not_found"}}
        ],
        "qwen2.5-coder:latest"
      )

    assert result.output_text == "partial"
    refute Enum.any?(result.events, &match?(%{event: :turn_completed}, &1))

    assert [
             %{event: :notification, payload: %{"method" => "message.delta"}},
             %{event: :turn_ended_with_error, message: "model not found", payload: %{"method" => "run.failed"}}
           ] = result.events
  end

  test "normalizes streamed tool-call arguments that arrive as parsed JSON" do
    result =
      OpenAICompatible.normalize_chunks(
        [
          %{
            "id" => "chatcmpl-local",
            "choices" => [
              %{
                "delta" => %{
                  "tool_calls" => [
                    %{
                      "index" => 0,
                      "id" => "call-1",
                      "function" => %{
                        "name" => "scheduled_task.list",
                        "arguments" => %{"query" => "Provider.OpenAICompatible"}
                      }
                    }
                  ]
                },
                "finish_reason" => "tool_calls"
              }
            ]
          }
        ],
        "qwen2.5-coder:latest"
      )

    assert Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments])) == [
             %{id: "call-1", name: "scheduled_task.list", arguments: %{"query" => "Provider.OpenAICompatible"}}
           ]

    assert Enum.any?(result.events, fn
             %{event: :tool_call_completed, payload: %{"arguments" => %{"query" => "Provider.OpenAICompatible"}}} -> true
             _event -> false
           end)
  end

  test "normalizes local chunk content parts and completes tool calls on terminal finish reasons" do
    result =
      OpenAICompatible.normalize_chunks(
        [
          %{
            "id" => "chatcmpl-local",
            "choices" => [
              %{
                "delta" => %{
                  "content" => [
                    %{"type" => "text", "text" => "Need "},
                    %{"type" => "output_text", "text" => "tools."}
                  ],
                  "tool_calls" => [
                    %{
                      "index" => 0,
                      "id" => "call-1",
                      "function" => %{"name" => "scheduled_task.list", "arguments" => "{\"query\":\"runtime\"}"}
                    }
                  ]
                }
              }
            ]
          },
          %{
            "choices" => [
              %{
                "delta" => %{},
                "finish_reason" => "stop"
              }
            ]
          }
        ],
        "qwen2.5-coder:latest"
      )

    assert result.output_text == "Need tools."
    assert result.finish_reason == "stop"

    assert Enum.map(result.tool_calls, &Map.take(&1, [:id, :name, :arguments])) == [
             %{id: "call-1", name: "scheduled_task.list", arguments: %{"query" => "runtime"}}
           ]

    assert [
             %{event: :notification, payload: %{"method" => "message.delta", "params" => %{"textDelta" => "Need tools."}}},
             %{event: :tool_call_started, payload: %{"method" => "tool.started", "callId" => "call-1"}},
             %{event: :tool_call_completed, payload: %{"method" => "tool.completed", "arguments" => %{"query" => "runtime"}}},
             %{event: :turn_completed, payload: %{"method" => "run.completed"}}
           ] = result.events
  end

  test "classifies auth failures as fatal", %{req_options: req_options} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(401, Jason.encode!(%{"error" => %{"message" => "bad key"}}))
    end)

    assert {:error,
            {:fatal,
             %{
               error_code: :provider_auth_failed,
               provider_status: 401,
               retryable: false,
               message: "bad key"
             }}} =
             OpenAICompatible.start_turn(
               %{"model" => "compatible-model", "api_key" => "bad-key"},
               [%{"role" => "user", "content" => "hello"}],
               [],
               req_options: req_options
             )
  end

  test "preserves false-valued profile options", %{req_options: req_options} do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:request, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "chatcmpl-false",
          "choices" => [%{"finish_reason" => "stop", "message" => %{"content" => "ok"}}]
        })
      )
    end)

    assert {:ok, _result} =
             OpenAICompatible.start_turn(
               %{
                 "model" => "compatible-model",
                 "api_key" => "test-key",
                 "parallel_tool_calls" => false
               },
               [%{"role" => "user", "content" => "hello"}],
               [],
               req_options: req_options
             )

    assert_received {:request, %{"parallel_tool_calls" => false}}
  end

  test "classifies rate limits as retryable", %{req_options: req_options} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(429, Jason.encode!(%{"error" => %{"message" => "slow down"}}))
    end)

    assert {:error,
            {:retryable,
             %{
               error_code: :provider_rate_limited,
               provider_status: 429,
               retryable: true,
               message: "slow down"
             }}} =
             OpenAICompatible.start_turn(
               %{"model" => "compatible-model", "bearer_token" => "token"},
               [%{"role" => "user", "content" => "hello"}],
               [],
               req_options: req_options
             )
  end

  test "requires model and bearer credential" do
    assert {:error, {:missing_requirement, :model}} = OpenAICompatible.start_turn(%{"api_key" => "key"}, [], [])
    assert {:error, {:missing_requirement, :credential}} = OpenAICompatible.start_turn(%{"model" => "model"}, [], [])
  end

  defp fake_model_scenario!(name) do
    path =
      File.cwd!()
      |> Path.join("../../scripts/fixtures/fake-model/#{name}.json")
      |> Path.expand()

    path
    |> File.read!()
    |> Jason.decode!()
  end
end
