defmodule SymphonyElixir.Runner.LlmToolRunner.SessionTest do
  use SymphonyElixir.Runner.ManagerTestSupport

  alias SymphonyElixir.ToolRegistry

  test "starts without a workspace and exposes manager session fields" do
    assert Manager.requires_workspace?() == false
    assert Manager.ping(%{}) == {:error, :no_credential}
    assert Manager.ping(%{"api_key" => "test-key"}) == :ok
    assert Manager.ping(%{"provider" => "openai_compatible"}) == :ok

    assert {:ok, session} =
             Manager.start_session(
               %{
                 "api_key" => "test-key",
                 "credential_id" => "cred-1",
                 "workspace_id" => "workspace-1",
                 "model" => "gpt-test"
               },
               nil
             )

    assert session.model == "gpt-test"
    assert session.provider == "openai"
    assert session.credential_id == "cred-1"
    assert session.workspace_id == "workspace-1"
    assert session.prompt =~ "manager agent"
    assert Enum.map(session.tool_specs, & &1["name"]) == tool_names()

    assert :ok = Manager.stop_session(session)
  end

  test "coding sessions use the coding tool bundle without requiring Codex" do
    workspace = System.tmp_dir!()

    assert {:ok, session} =
             Manager.start_session(
               %{
                 "api_key" => "test-key",
                 "credential_id" => "cred-1",
                 "workspace_id" => "workspace-1",
                 "model" => "gpt-test",
                 "agent_type" => "coding"
               },
               workspace
             )

    assert session.provider == "openai"
    assert session.credential_id == "cred-1"
    assert session.workspace == workspace
    assert session.workspace_root == workspace
    assert session.prompt == "You are a helpful agent. Use the available tools when needed."
    assert MapSet.new(session.allowed_tools) == MapSet.new(ToolRegistry.bundle(:coding))
    assert "git.run" in session.allowed_tools
    refute "snooze" in session.allowed_tools

    assert :ok = Manager.stop_session(session)
  end

  test "local relay coding fallback keeps helper tools while excluding broad git execution" do
    assert {:ok, session} =
             Manager.start_session(
               %{
                 "provider" => "local",
                 "workspace_id" => "workspace-1",
                 "model" => "qwen",
                 "agent_type" => "coding"
               },
               nil
             )

    assert session.model_client == ModelClient.LocalRelay
    assert "shell.exec" in session.allowed_tools
    assert "apply_patch" in session.allowed_tools
    refute "scheduled_task.read" in session.allowed_tools
    assert "scheduled_task.list" in session.allowed_tools
    refute "git.run" in session.allowed_tools

    shell_exec = Enum.find(session.tool_specs, &(&1["name"] == "shell.exec"))
    assert shell_exec["execution_kind"] == "helper"
    assert Map.has_key?(shell_exec["inputSchema"]["properties"], "argv")

    assert :ok = Manager.stop_session(session)
  end

  test "appends agent context to the system prompt when provided" do
    assert {:ok, session} =
             Manager.start_session(
               %{
                 "api_key" => "test-key",
                 "credential_id" => "cred-1",
                 "workspace_id" => "workspace-1",
                 "model" => "gpt-test",
                 "agent_context" => "Always answer in French."
               },
               nil
             )

    assert session.prompt =~ "manager agent"
    assert session.prompt =~ "Agent instructions:\nAlways answer in French."

    assert :ok = Manager.stop_session(session)
  end

  test "omits the agent instructions section when no context is provided" do
    assert {:ok, session} =
             Manager.start_session(
               %{
                 "api_key" => "test-key",
                 "credential_id" => "cred-1",
                 "workspace_id" => "workspace-1",
                 "model" => "gpt-test"
               },
               nil
             )

    refute session.prompt =~ "Agent instructions:"

    assert :ok = Manager.stop_session(session)
  end

  test "uses supplied effective grant definitions instead of manager role defaults" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:grant_scoped_manager_request, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "resp-manager-grants",
          "status" => "completed",
          "output" => [
            %{
              "type" => "message",
              "role" => "assistant",
              "content" => [%{"type" => "output_text", "text" => "No snooze tool available."}]
            }
          ]
        })
      )
    end)

    effective_tool_names = tool_names() -- ["snooze"]

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "workspace_id" => "workspace-1",
          "toolDefinitions" => ToolRegistry.specs(effective_tool_names)
        },
        nil
      )

    refute "snooze" in session.allowed_tools

    assert {:ok, %{"response_id" => "resp-manager-grants", "output_text" => "No snooze tool available."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{id: "work-1", identifier: "MAN-1"})

    assert_received {:grant_scoped_manager_request, request}
    provider_names = Enum.map(request["tools"], & &1["name"])

    refute "snooze" in provider_names
    assert "mark_done" in provider_names

    assert :ok = Manager.stop_session(session)
  end

  test "Responses manager preserves canonical schemas from explicit tool definitions" do
    test_pid = self()

    schema = %{
      "type" => "object",
      "required" => ["work_item_id", "seconds"],
      "properties" => %{
        "work_item_id" => %{"type" => "string"},
        "seconds" => %{"type" => "integer"}
      }
    }

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:explicit_schema_request, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "resp-explicit-schema",
          "status" => "completed",
          "output" => [
            %{
              "type" => "message",
              "role" => "assistant",
              "content" => [%{"type" => "output_text", "text" => "Done."}]
            }
          ]
        })
      )
    end)

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "workspace_id" => "workspace-1",
          "tool_definitions" => [%{"name" => "snooze", "description" => "Snooze work", "parameters" => schema}]
        },
        nil
      )

    assert {:ok, %{"output_text" => "Done."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{
               id: "work-1",
               identifier: "MAN-1",
               title: "Manage work"
             })

    assert_received {:explicit_schema_request, request}
    assert [%{"name" => "snooze", "parameters" => ^schema}] = request["tools"]

    assert :ok = Manager.stop_session(session)
  end

  test "Responses manager maps dotted runtime tool names to provider-safe names" do
    test_pid = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:dotted_tool_request, Jason.decode!(body)})

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "resp-dotted-tool",
          "status" => "completed",
          "output" => [
            %{
              "type" => "message",
              "role" => "assistant",
              "content" => [%{"type" => "output_text", "text" => "Done."}]
            }
          ]
        })
      )
    end)

    schema = %{"type" => "object", "properties" => %{}}

    {:ok, session} =
      Manager.start_session(
        %{
          "api_key" => "test-key",
          "model" => "gpt-test",
          "workspace_id" => "workspace-1",
          "tool_definitions" => [%{"name" => "skill.create", "description" => "Create a skill", "parameters" => schema}]
        },
        nil
      )

    assert {:ok, %{"output_text" => "Done."}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{id: "work-1", identifier: "MAN-1"})

    assert_received {:dotted_tool_request, request}
    refute Map.has_key?(request, "provider_tool_name_map")
    assert [%{"name" => "skill_create", "parameters" => ^schema}] = request["tools"]

    assert [
             %{
               "type" => "function_call",
               "call_id" => "call-skill",
               "name" => "skill.create",
               "arguments" => "{\"name\":\"demo\"}"
             }
           ] =
             ModelClient.OpenAIResponses.tool_calls(%{
               "provider_tool_name_map" => %{"skill.create" => "skill_create"},
               "output" => [
                 %{
                   "type" => "function_call",
                   "call_id" => "call-skill",
                   "name" => "skill_create",
                   "arguments" => %{"name" => "demo"}
                 }
               ]
             })

    assert :ok = Manager.stop_session(session)
  end

  test "OpenAI manager clients preserve malformed tool-call arguments for downstream validation" do
    chat_response = %{
      "message" => %{
        "tool_calls" => [
          %{
            "id" => "call-bad",
            "type" => "function",
            "function" => %{"name" => "snooze", "arguments" => "{\"work_item_id\""}
          }
        ]
      }
    }

    responses_response = %{
      "output" => [
        %{
          "type" => "function_call",
          "call_id" => "call-bad",
          "name" => "snooze",
          "arguments" => "{\"work_item_id\""
        }
      ]
    }

    assert [
             %{
               "type" => "function_call",
               "call_id" => "call-bad",
               "name" => "snooze",
               "arguments" => "{\"work_item_id\""
             }
           ] = SymphonyElixir.Manager.ModelClient.OpenAICompatibleChat.tool_calls(chat_response)

    assert [
             %{
               "type" => "function_call",
               "call_id" => "call-bad",
               "name" => "snooze",
               "arguments" => "{\"work_item_id\""
             }
           ] = SymphonyElixir.Manager.ModelClient.OpenAIResponses.tool_calls(responses_response)
  end

  test "OpenAI-compatible manager parses tagged text tool calls from local models" do
    chat_response = %{
      "message" => %{
        "content" => """
        I will check.

        <function=scheduled_task.list>
        <parameter=due_only>
        true
        </parameter>
        </function>
        </tool_call>
        """
      }
    }

    assert [
             %{
               "type" => "function_call",
               "call_id" => "call_1",
               "name" => "scheduled_task.list",
               "arguments" => ~s({"due_only":true})
             }
           ] = SymphonyElixir.Manager.ModelClient.OpenAICompatibleChat.tool_calls(chat_response)
  end

  test "OpenAI-compatible manager encodes structured tool outputs as tool message strings" do
    request =
      ModelClient.OpenAICompatibleChat.follow_up_request(
        %{model: "qwen3-coder:30b", tool_specs: []},
        %{
          "messages" => [%{"role" => "user", "content" => "check PRs"}],
          "message" => %{"role" => "assistant", "content" => nil, "tool_calls" => []},
          "metadata" => %{}
        },
        [
          %{
            "call_id" => "call-1",
            "output" => %{"ok" => true, "stdout" => "PR #1\\n", "stderr" => ""}
          }
        ]
      )

    assert %{"role" => "tool", "tool_call_id" => "call-1", "content" => content} =
             List.last(request["messages"])

    assert is_binary(content)
    assert %{"ok" => true, "stdout" => "PR #1\\n", "stderr" => ""} = Jason.decode!(content)
  end

  test "OpenAI Responses manager encodes structured function call outputs as strings" do
    request =
      ModelClient.OpenAIResponses.follow_up_request(
        %{model: "gpt-test", provider_tool_name_map: %{}},
        %{"id" => "resp-1"},
        [
          %{
            "type" => "function_call_output",
            "call_id" => "call-1",
            "output" => [
              %{"name" => "demo.txt", "path" => "demo.txt"},
              %{"name" => "src", "path" => "src"}
            ]
          },
          %{
            "type" => "function_call_output",
            "call_id" => "call-2",
            "output" => %{"ok" => true, "stdout" => "PR #1\\n"}
          },
          %{
            "type" => "function_call_output",
            "call_id" => "call-3",
            "output" => "already encoded"
          }
        ]
      )

    assert [
             %{"type" => "function_call_output", "call_id" => "call-1", "output" => list_output},
             %{"type" => "function_call_output", "call_id" => "call-2", "output" => map_output},
             %{"type" => "function_call_output", "call_id" => "call-3", "output" => "already encoded"}
           ] = request["input"]

    assert is_binary(list_output)
    assert [%{"name" => "demo.txt"}, %{"name" => "src"}] = Jason.decode!(list_output)
    assert is_binary(map_output)
    assert %{"ok" => true, "stdout" => "PR #1\\n"} = Jason.decode!(map_output)
  end

  test "fails clearly when chat-completions backend omits native tool calls" do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(
        200,
        Jason.encode!(%{
          "id" => "chatcmpl-unsupported",
          "choices" => [
            %{
              "finish_reason" => "tool_calls",
              "message" => %{"role" => "assistant", "content" => ~s({"tool":"snooze"})}
            }
          ]
        })
      )
    end)

    {:ok, session} =
      Manager.start_session(
        %{"provider" => "openai_compatible", "model" => "qwen3-coder:30b"},
        nil
      )

    assert {:error, {:fatal, %{error_code: "unsupported_manager_tool_call_format"}}} =
             Manager.run_turn(session, ~s({"due_tasks":[]}), %WorkItem{id: "work-1", identifier: "MAN-1"})

    assert :ok = Manager.stop_session(session)
  end

  test "classifies Responses API failures" do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(500, Jason.encode!(%{"error" => "boom"}))
    end)

    {:ok, session} = Manager.start_session(%{"api_key" => "test-key"}, nil)

    assert {:error, {:retryable, classification}} =
             Manager.run_turn(session, "{}", %WorkItem{id: "work-1", identifier: "MAN-1"})

    assert %{
             event: "model_call_failed",
             provider: "openai",
             model: "gpt-5.1",
             status: 500,
             error_code: "provider_overloaded",
             retryable: true,
             attempt: 1,
             reason: "boom"
           } = classification

    assert is_integer(classification.duration_ms)
    assert :ok = Manager.stop_session(session)
  end
end
