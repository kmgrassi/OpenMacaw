defmodule SymphonyElixir.Runner.LocalModelCodingTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.LocalModelCoding
  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.WorkItem

  defmodule FakeProvider do
    @behaviour SymphonyElixir.Provider

    @impl true
    def start_turn(profile, messages, tools, _opts) do
      send(
        Application.fetch_env!(:symphony_elixir, :local_model_coding_test_pid),
        {:provider_turn, profile, messages, tools}
      )

      case Application.get_env(:symphony_elixir, :local_model_coding_turns, []) do
        [turn | rest] ->
          Application.put_env(:symphony_elixir, :local_model_coding_turns, rest)
          {:ok, turn}

        [] ->
          {:error, {:fatal, %{error_code: :no_fake_turns}}}
      end
    end
  end

  setup do
    Application.put_env(:symphony_elixir, :local_model_coding_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :local_model_coding_test_pid)
      Application.delete_env(:symphony_elixir, :local_model_coding_turns)
    end)

    :ok
  end

  test "runs multi-turn shell and patch calls to final output" do
    workspace = workspace_fixture()
    File.write!(Path.join(workspace, "todo.txt"), "TODO: old\n")

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Need to inspect.", [
        %{id: "call-shell", name: "shell.exec", arguments: %{"argv" => ["cat", "todo.txt"]}}
      ]),
      provider_turn("Need to edit.", [
        %{
          id: "call-patch",
          name: "apply_patch",
          arguments: %{
            "patch" => """
            *** Begin Patch
            *** Update File: todo.txt
            @@
            -TODO: old
            +TODO: new
            *** End Patch
            """
          }
        }
      ]),
      provider_turn("Done.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Make the change", work_item())

    assert result["output_text"] == "Done."
    assert result["metadata"]["iterations"] == 2
    assert File.read!(Path.join(workspace, "todo.txt")) == "TODO: new\n"

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system", "content" => workspace_system},
                      %{"role" => "user", "content" => "Make the change"}
                    ], tools}

    assert workspace_system =~ "operating in workspace directory: " <> workspace

    assert Enum.map(tools, & &1["name"]) == [
             "skill_create",
             "scheduled_task_list",
             "repo_list",
             "repo_read_file",
             "repo_search",
             "shell_exec",
             "apply_patch",
             "git_run"
           ]

    assert_receive {:provider_turn, _profile, messages_after_shell, _tools}

    assert Enum.any?(messages_after_shell, fn message ->
             message["role"] == "tool" and message["tool_call_id"] == "call-shell" and
               String.contains?(message["content"], "TODO: old")
           end)

    assert_receive {:provider_turn, _profile, messages_after_patch, _tools}

    assert Enum.any?(messages_after_patch, fn message ->
             message["role"] == "tool" and message["tool_call_id"] == "call-patch" and
               String.contains?(message["content"], "Patch applied successfully.")
           end)

    assert_receive {:runner_event,
                    %{
                      event: :tool_call_completed,
                      payload: %{"tool_name" => "shell.exec", "success" => true}
                    }}

    assert_receive {:runner_event,
                    %{
                      event: :tool_call_completed,
                      payload: %{"tool_name" => "apply_patch", "success" => true}
                    }}

    assert_receive {:runner_event, %{event: :turn_completed, message: "Done."}}
  end

  test "includes agent context in the local model system message" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Acknowledged.", [])
    ])

    assert {:ok, session} =
             LocalModelCoding.start_session(
               config(agent_context: "Prefer small, reviewed patches."),
               workspace
             )

    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item())
    assert result["output_text"] == "Acknowledged."

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system", "content" => system_message},
                      %{"role" => "user", "content" => "Inspect"}
                    ], _tools}

    assert system_message =~ "Agent instructions:\nPrefer small, reviewed patches."
    assert system_message =~ "operating in workspace directory: " <> workspace
  end

  test "does not promote work item descriptions to agent instructions" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Acknowledged.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)

    work_item = %WorkItem{
      id: "work-item-1",
      title: "Queued task",
      description: "User-authored task body",
      source: "test"
    }

    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item)
    assert result["output_text"] == "Acknowledged."

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system", "content" => system_message},
                      %{"role" => "user", "content" => "Inspect"}
                    ], _tools}

    refute system_message =~ "Agent instructions:"
    refute system_message =~ "User-authored task body"
    assert system_message =~ "operating in workspace directory: " <> workspace
  end

  test "appends unsupported tool errors without executing a tool" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [%{id: "call-unknown", name: "repo.delete_everything", arguments: %{}}]),
      provider_turn("Rejected unsupported tool.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Try a tool", work_item())

    assert result["output_text"] == "Rejected unsupported tool."
    assert_receive {:provider_turn, _profile, messages, _tools}
    assert_receive {:provider_turn, _profile, continuation_messages, _tools}
    assert length(continuation_messages) > length(messages)

    assert Enum.any?(
             continuation_messages,
             &match?(
               %{"role" => "tool", "content" => "Unsupported tool: repo.delete_everything"},
               &1
             )
           )

    assert_receive {:runner_event,
                    %{
                      event: :unsupported_tool_call,
                      message: "Unsupported tool: repo.delete_everything"
                    }}

    assert_receive {:runner_event,
                    %{
                      event: :tool_call_failed,
                      payload: %{"tool_name" => "repo.delete_everything", "success" => false}
                    }}
  end

  test "uses the workspace-scoped local executor when no executor is injected" do
    workspace =
      Path.join(System.tmp_dir!(), "local-model-coding-runner-#{System.unique_integer([:positive])}")

    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "README.md"), "hello\n")

    on_exit(fn -> File.rm_rf(workspace) end)

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        %{id: "call-shell", name: "shell.exec", arguments: %{"argv" => ["cat", "README.md"]}}
      ]),
      provider_turn("Read the file.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Read README", work_item())

    assert result["output_text"] == "Read the file."

    assert_receive {:provider_turn, _profile, _messages, _tools}
    assert_receive {:provider_turn, _profile, continuation_messages, _tools}

    assert Enum.any?(
             continuation_messages,
             &match?(
               %{"role" => "tool", "tool_call_id" => "call-shell", "content" => "hello\n"},
               &1
             )
           )

    assert_receive {:runner_event, %{event: :command_started}}
    assert_receive {:runner_event, %{event: :command_output_delta}}
    assert_receive {:runner_event, %{event: :command_completed}}
  end

  test "uses the workspace-scoped local executor for repository search when no executor is injected" do
    workspace =
      Path.join(
        System.tmp_dir!(),
        "local-model-coding-search-runner-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(workspace)
    File.write!(Path.join(workspace, "README.md"), "hello world\n")
    rg = write_fake_rg!(workspace)

    on_exit(fn -> File.rm_rf(workspace) end)

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        %{id: "call-search", name: "repo_search", arguments: %{"query" => "hello"}}
      ]),
      provider_turn("Found it.", [])
    ])

    runner_config = config(metadata: %{"rg_path" => rg})

    assert {:ok, session} = LocalModelCoding.start_session(runner_config, workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Search the repo", work_item())

    assert result["output_text"] == "Found it."
    assert_receive {:provider_turn, _profile, _messages, _tools}
    assert_receive {:provider_turn, _profile, continuation_messages, _tools}

    assert Enum.any?(continuation_messages, fn message ->
             message["role"] == "tool" and
               message["tool_call_id"] == "call-search" and
               String.contains?(message["content"], "README.md")
           end)
  end

  test "maps provider-safe OpenAI-compatible tool names back to canonical runtime slugs" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        %{id: "call-shell", name: "shell_exec", arguments: %{"argv" => ["pwd"]}}
      ]),
      provider_turn("Done.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item())

    assert result["output_text"] == "Done."

    assert_receive {:provider_turn, _profile, _messages,
                    [
                      %{"name" => "skill_create"},
                      %{"name" => "scheduled_task_list"},
                      %{"name" => "repo_list"},
                      %{"name" => "repo_read_file"},
                      %{"name" => "repo_search"},
                      %{"name" => "shell_exec"},
                      %{"name" => "apply_patch"},
                      %{"name" => "git_run"}
                    ]}
  end

  test "preserves work item runtime IDs for direct scheduled task tools" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        %{id: "call-list", name: "scheduled_task_list", arguments: %{}}
      ]),
      provider_turn("Listed schedules.", [])
    ])

    runner_config =
      config()
      |> Map.put("tool_definitions", ToolRegistry.definitions(["scheduled_task.list"]))
      |> Map.put("tool_executor", fn "scheduled_task.list", %{}, executed_session ->
        send(self(), {:scheduled_task_context, executed_session})
        {:ok, %{"output" => "[]"}}
      end)

    work_item = %WorkItem{
      id: "work-item-1",
      title: "Scheduled work",
      metadata: %{"workspace_id" => "workspace-1", "agent_id" => "agent-1"}
    }

    assert {:ok, session} = LocalModelCoding.start_session(runner_config, workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "List schedules", work_item)

    assert result["output_text"] == "Listed schedules."

    assert_receive {:scheduled_task_context,
                    %{
                      workspace_id: "workspace-1",
                      agent_id: "agent-1",
                      metadata: %{
                        "workspace_id" => "workspace-1",
                        "agent_id" => "agent-1",
                        "work_item_id" => "work-item-1",
                        "title" => "Scheduled work"
                      }
                    }}
  end

  test "maps provider-safe repository tool names back to canonical runtime slugs" do
    workspace = workspace_fixture()
    File.write!(Path.join(workspace, "README.md"), "hello world\n")
    rg = write_fake_rg!(workspace)

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        %{id: "call-search", name: "repo_search", arguments: %{"query" => "hello"}}
      ]),
      provider_turn("Done.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(metadata: %{"rg_path" => rg}), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item())

    assert result["output_text"] == "Done."
  end

  test "appends malformed argument failures without executing a tool" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      %{
        provider: "openai_compatible",
        model: "qwen2.5-coder",
        output_text: "",
        tool_calls: [
          %{
            id: "call-bad-json",
            name: "shell_exec",
            arguments: ~s({"argv":)
          }
        ],
        usage: %{},
        events: []
      },
      provider_turn("Handled malformed arguments.", [])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item())

    assert result["output_text"] == "Handled malformed arguments."
    assert_receive {:provider_turn, _profile, _initial_messages, _tools}
    assert_receive {:provider_turn, _profile, continuation_messages, _tools}

    assert Enum.any?(
             continuation_messages,
             &match?(
               %{"role" => "tool", "content" => "Malformed arguments for tool call: \"{\\\"argv\\\":\""},
               &1
             )
           )
  end

  test "uses prompt-based fallback instructions and parses tool-call JSON when native tools are disabled" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn(~s({"tool_call":{"name":"shell.exec","arguments":{"argv":["pwd"]}}}), []),
      provider_turn("Done.", [])
    ])

    assert {:ok, session} =
             LocalModelCoding.start_session(
               config()
               |> put_in(["execution_profile", "provider"], "prompt_based"),
               workspace
             )

    assert {:ok, result} = LocalModelCoding.run_turn(session, "Inspect", work_item())

    assert result["output_text"] == "Done."

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system", "content" => workspace_system},
                      %{"role" => "system", "content" => tool_system},
                      %{"role" => "user"}
                    ], []}

    assert workspace_system =~ "operating in workspace directory: " <> workspace
    assert tool_system =~ "Available tools:"
  end

  test "replays persisted chat history before the current local coding prompt" do
    workspace = workspace_fixture()

    SymphonyElixir.Runner.ManagerTestSupport.configure_history_adapter([
      %{"role" => "user", "content" => "current persisted prompt", "run_id" => "run-current", "created_at" => "2026-05-12T10:01:00Z"},
      %{
        "role" => "assistant",
        "content" => "",
        "run_id" => "run-old",
        "created_at" => "2026-05-12T10:00:01Z",
        "tool_calls" => [
          %{
            "input" =>
              Jason.encode!(%{
                "call_id" => "call-shell",
                "tool_name" => "shell.exec",
                "input" => %{"arguments" => %{"argv" => ["pwd"]}}
              }),
            "output" => Jason.encode!(%{"output" => "workspace\n"})
          }
        ]
      },
      %{"role" => "user", "content" => "previous prompt", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"}
    ])

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Done.", [])
    ])

    runner_config =
      config()
      |> Map.put("message_recorder_scope", %{
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        session_key: "agent:agent-1:main",
        session_thread_id: "thread-1",
        user_id: "user-1"
      })

    work_item = %{work_item() | metadata: %{"run_id" => "run-current"}}

    assert {:ok, session} = LocalModelCoding.start_session(runner_config, workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "new prompt", work_item)
    assert result["output_text"] == "Done."

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system"},
                      %{"role" => "user", "content" => "previous prompt"},
                      %{
                        "role" => "assistant",
                        "tool_calls" => [
                          %{
                            "id" => "call-shell",
                            "function" => %{
                              "name" => "shell_exec",
                              "arguments" => ~s({"argv":["pwd"]})
                            }
                          }
                        ]
                      },
                      %{"role" => "tool", "tool_call_id" => "call-shell", "content" => "workspace\n"},
                      %{"role" => "user", "content" => "new prompt", "metadata" => %{"work_item_id" => "work-item-1"}}
                    ], _tools}
  end

  test "history_window zero disables local coding history replay" do
    workspace = workspace_fixture()

    SymphonyElixir.Runner.ManagerTestSupport.configure_history_adapter([
      %{"role" => "assistant", "content" => "old answer", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:01Z"},
      %{"role" => "user", "content" => "old prompt", "run_id" => "run-old", "created_at" => "2026-05-12T10:00:00Z"}
    ])

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Done.", [])
    ])

    runner_config =
      config()
      |> Map.put("history_window", 0)
      |> Map.put("message_recorder_scope", %{
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        session_key: "agent:agent-1:scheduled",
        session_thread_id: "thread-1",
        user_id: "user-1"
      })

    assert {:ok, session} = LocalModelCoding.start_session(runner_config, workspace)
    assert {:ok, result} = LocalModelCoding.run_turn(session, "fresh prompt", work_item())
    assert result["output_text"] == "Done."

    assert_receive {:provider_turn, _profile,
                    [
                      %{"role" => "system"},
                      %{"role" => "user", "content" => "fresh prompt"}
                    ], _tools}
  end

  test "stops when the tool-call iteration limit is exceeded" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [%{id: "call-1", name: "shell.exec", arguments: %{"argv" => ["pwd"]}}]),
      provider_turn("", [%{id: "call-2", name: "shell.exec", arguments: %{"argv" => ["pwd"]}}])
    ])

    assert {:ok, session} =
             LocalModelCoding.start_session(config(max_iterations: 1), workspace)

    assert {:error, {:fatal, {:max_tool_call_iterations_exceeded, 1}}} =
             LocalModelCoding.run_turn(session, "Loop", work_item())

    assert_receive {:runner_event,
                    %{
                      event: :turn_ended_with_error,
                      message: "Tool-call iteration limit exceeded"
                    }}
  end

  test "merges runtime model and credential fields into provider profile" do
    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("Done.", [])
    ])

    runner_config =
      config()
      |> put_in(["execution_profile", "model"], "[REDACTED]")
      |> put_in(["execution_profile", "credential"], %{"value" => "[REDACTED]"})
      |> Map.merge(%{
        "model" => "qwen-runtime",
        "credential" => %{"value" => "runtime-token"},
        "base_url" => "http://127.0.0.1:11434/v1"
      })

    assert {:ok, session} = LocalModelCoding.start_session(runner_config, workspace_fixture())
    assert {:ok, _result} = LocalModelCoding.run_turn(session, "Use runtime fields", work_item())

    assert_receive {:provider_turn, profile, _messages, _tools}
    assert profile["model"] == "qwen-runtime"
    assert profile["credential"] == %{"value" => "runtime-token"}
    assert profile["base_url"] == "http://127.0.0.1:11434/v1"
  end

  test "next local model coding start uses the changed effective grant tool set" do
    workspace = workspace_fixture()

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("First done.", []),
      provider_turn("Second done.", [])
    ])

    first_config = Map.put(config(), "tool_definitions", ToolRegistry.definitions(["repo.list"]))
    assert {:ok, first_session} = LocalModelCoding.start_session(first_config, workspace)
    assert {:ok, _result} = LocalModelCoding.run_turn(first_session, "Use current grants", work_item())
    assert_receive {:provider_turn, _profile, _messages, first_tools}
    assert Enum.map(first_tools, & &1["name"]) == ["repo_list"]

    second_config = Map.put(config(), "tool_definitions", ToolRegistry.definitions(["shell.exec"]))
    assert {:ok, second_session} = LocalModelCoding.start_session(second_config, workspace)
    assert {:ok, _result} = LocalModelCoding.run_turn(second_session, "Use changed grants", work_item())
    assert_receive {:provider_turn, _profile, _messages, second_tools}
    assert Enum.map(second_tools, & &1["name"]) == ["shell_exec"]
  end

  test "rejects repeated tool calls in the current provider batch before execution" do
    workspace = workspace_fixture()
    repeated_call = %{name: "shell.exec", arguments: %{"argv" => ["pwd"]}}

    Application.put_env(:symphony_elixir, :local_model_coding_turns, [
      provider_turn("", [
        Map.put(repeated_call, :id, "call-1"),
        Map.put(repeated_call, :id, "call-2"),
        Map.put(repeated_call, :id, "call-3")
      ])
    ])

    assert {:ok, session} = LocalModelCoding.start_session(config(), workspace)

    assert {:error, {:fatal, {:repeated_tool_call_detected, "shell.exec", %{"argv" => ["pwd"]}, 3}}} =
             LocalModelCoding.run_turn(session, "Repeat", work_item())
  end

  defp config(opts \\ []) do
    %{
      "execution_profile" => %{
        "provider" => "openai_compatible",
        "model" => "qwen2.5-coder",
        "credential" => %{"value" => "unused"}
      },
      "provider_module" => FakeProvider,
      "max_iterations" => Keyword.get(opts, :max_iterations, 4),
      "agent_context" => Keyword.get(opts, :agent_context),
      "metadata" => Keyword.get(opts, :metadata, %{}),
      "on_message" => fn event -> send(self(), {:runner_event, event}) end
    }
  end

  defp provider_turn(output_text, tool_calls) do
    %{
      provider: "openai_compatible",
      model: "qwen2.5-coder",
      output_text: output_text,
      tool_calls: tool_calls,
      usage: %{"total_tokens" => 1},
      events: []
    }
  end

  defp write_fake_rg!(root) do
    path = Path.join(root, "fake-rg")

    File.write!(
      path,
      """
      #!/bin/sh
      printf '%s\\n' '{"type":"match","data":{"path":{"text":"README.md"},"line_number":1,"submatches":[{"start":0}],"lines":{"text":"hello world\\n"}}}'
      """
    )

    File.chmod!(path, 0o755)
    path
  end

  defp workspace_fixture do
    workspace = Path.join(System.tmp_dir!(), "local-model-coding-runner-#{System.unique_integer([:positive])}")
    File.mkdir_p!(workspace)
    on_exit(fn -> File.rm_rf(workspace) end)
    workspace
  end

  defp work_item do
    %WorkItem{id: "work-item-1", title: "Test work item", source: "test"}
  end
end
