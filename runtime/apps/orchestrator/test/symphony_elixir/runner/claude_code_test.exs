defmodule SymphonyElixir.Runner.ClaudeCodeTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.ClaudeCode
  alias SymphonyElixir.WorkItem

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "claude-code-runner-root-#{System.unique_integer([:positive])}"
      )

    workspace = Path.join(root, "workspace")
    File.mkdir_p!(workspace)
    workflow_file = Path.join(root, "WORKFLOW.md")
    write_workflow_file!(workflow_file, workspace_root: root)
    Workflow.set_workflow_file_path(workflow_file)
    WorkflowStore.force_reload()

    on_exit(fn -> File.rm_rf(root) end)

    %{root: root, workspace: workspace}
  end

  test "requires a workspace" do
    assert ClaudeCode.requires_workspace?()
  end

  test "ping accepts a fake bridge without requiring Anthropic credentials" do
    assert :ok = ClaudeCode.ping(%{"bridge_command" => "node -e 'process.exit(0)'"})
  end

  test "runs session lifecycle through a fake bridge", %{workspace: workspace} do
    bridge = fake_bridge!("success")
    events_recipient = self()

    config = %{
      "bridge_command" => "node #{shell_escape(bridge)}",
      "model" => "sonnet",
      "permission_mode" => "acceptEdits",
      "tools" => ["Read", "Edit", "Write"],
      "allowed_tools" => ["Read", "Edit", "Write"],
      "max_turns" => 5,
      "on_message" => fn event -> send(events_recipient, {:claude_event, event}) end
    }

    assert {:ok, session} = ClaudeCode.start_session(config, workspace)
    assert {:ok, canonical_workspace} = SymphonyElixir.PathSafety.canonicalize(workspace)
    assert session.cwd == canonical_workspace
    assert session.session_id == "fake-session"

    work_item = work_item()
    assert {:ok, result} = ClaudeCode.run_turn(session, "Implement this", work_item)
    assert result.result == "done"
    assert result.session_id == "fake-session"

    assert_received {:claude_event, %{"method" => "message/delta", "params" => %{"textDelta" => "working"}}}
    assert_received {:claude_event, %{"method" => "usage/updated"}}

    assert :ok = ClaudeCode.stop_session(session)
  end

  test "real bridge emits can_use_tool events and default-allows tool use", %{workspace: workspace} do
    bridge = stubbed_sdk_bridge!()
    events_recipient = self()

    config = %{
      "bridge_command" => "node #{shell_escape(bridge)}",
      "permission_mode" => "acceptEdits",
      "on_message" => fn event -> send(events_recipient, {:claude_event, event}) end
    }

    assert {:ok, session} = ClaudeCode.start_session(config, workspace)
    assert {:ok, result} = ClaudeCode.run_turn(session, "Use a tool", work_item())
    assert result.result == "done"

    assert_received {:claude_event,
                     %{
                       "method" => "tool/can_use_tool",
                       "params" => %{
                         "tool" => "Bash",
                         "toolName" => "Bash",
                         "toolUseId" => "toolu_1",
                         "input" => %{"command" => "pwd"},
                         "permissionMode" => "acceptEdits",
                         "decision" => "allow",
                         "source" => "can_use_tool"
                       }
                     }}

    assert_received {:claude_event,
                     %{
                       "method" => "sdk/message",
                       "params" => %{"type" => "permission_result", "result" => %{"behavior" => "allow"}}
                     }}

    assert :ok = ClaudeCode.stop_session(session)
  end

  test "surfaces startup failures", %{workspace: workspace} do
    bridge = fake_bridge!("startup_failure")

    assert {:error, {:fatal, "startup failed"}} =
             ClaudeCode.start_session(%{"bridge_command" => "node #{shell_escape(bridge)}"}, workspace)
  end

  test "buffers split JSON lines from the bridge", %{workspace: workspace} do
    bridge = fake_bridge!("large_start")

    assert {:ok, session} =
             ClaudeCode.start_session(%{"bridge_command" => "node #{shell_escape(bridge)}"}, workspace)

    assert session.session_id == "fake-session"
    assert :ok = ClaudeCode.stop_session(session)
  end

  test "surfaces turn failures", %{workspace: workspace} do
    bridge = fake_bridge!("turn_failure")

    assert {:ok, session} =
             ClaudeCode.start_session(%{"bridge_command" => "node #{shell_escape(bridge)}"}, workspace)

    assert {:error, {:retryable, "turn failed"}} =
             ClaudeCode.run_turn(session, "fail", work_item())

    assert :ok = ClaudeCode.stop_session(session)
  end

  test "stop terminates the fake bridge", %{workspace: workspace} do
    bridge = fake_bridge!("success")
    assert {:ok, session} = ClaudeCode.start_session(%{"bridge_command" => "node #{shell_escape(bridge)}"}, workspace)
    assert :ok = ClaudeCode.stop_session(session)
  end

  test "sends normalized input through the coding runner I/O contract", %{workspace: workspace} do
    bridge = fake_bridge!("echo_prompt")

    assert {:ok, session} =
             ClaudeCode.start_session(%{"bridge_command" => "node #{shell_escape(bridge)}"}, workspace)

    assert {:ok, result} = ClaudeCode.send_input(session, %{"message" => "follow up"}, work_item(), [])
    assert result.result == "follow up"

    assert :ok = ClaudeCode.stop_session(session)
  end

  test "advertises streaming I/O capabilities" do
    assert %{
             input: :turn,
             output_stream: :runner_events,
             interrupt: :unsupported,
             tool_activity: true,
             metadata: %{backend: "claude_agent_bridge"}
           } = ClaudeCode.stream_capabilities()
  end

  test "rejects a configured cwd that differs from the workspace", %{workspace: workspace, root: root} do
    other = Path.join(root, "other")
    File.mkdir_p!(other)

    assert {:error, {:invalid_workspace_cwd, :configured_cwd_mismatch, ^other, ^workspace}} =
             ClaudeCode.start_session(%{"bridge_command" => "node -e 'process.exit(0)'", "cwd" => other}, workspace)
  end

  test "rejects a workspace outside the configured workspace root", %{workspace: workspace} do
    outside =
      Path.join(
        System.tmp_dir!(),
        "claude-code-outside-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(outside)

    try do
      assert {:error, {:invalid_workspace_cwd, :outside_workspace_root, actual_outside, _root}} =
               ClaudeCode.start_session(%{"bridge_command" => "node -e 'process.exit(0)'"}, outside)

      assert {:ok, canonical_outside} = SymphonyElixir.PathSafety.canonicalize(outside)
      assert actual_outside == canonical_outside
    after
      File.rm_rf(outside)
      File.rm_rf(workspace)
    end
  end

  defp work_item do
    %WorkItem{
      id: "wi-1",
      identifier: "TEST-1",
      title: "Test item",
      description: "Test",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{"priority" => "normal"}
    }
  end

  defp fake_bridge!(mode) do
    path =
      Path.join(
        System.tmp_dir!(),
        "fake-claude-bridge-#{mode}-#{System.unique_integer([:positive])}.mjs"
      )

    File.write!(path, fake_bridge_source(mode))
    path
  end

  defp fake_bridge_source(mode) do
    """
    import readline from 'node:readline';
    const mode = #{Jason.encode!(mode)};
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\\n`);

    rl.on('line', (line) => {
      const message = JSON.parse(line);

      if (message.method === 'session/start') {
        if (mode === 'startup_failure') {
          write({ id: message.id, error: { reason: 'startup failed', retryable: false } });
          return;
        }

        if (mode === 'large_start') {
          write({ id: message.id, result: { sessionId: 'fake-session', padding: 'x'.repeat(1100000) } });
          return;
        }

        write({ id: message.id, result: { sessionId: 'fake-session' } });
        return;
      }

      if (message.method === 'turn/start') {
        if (mode === 'turn_failure') {
          write({ id: message.id, error: { reason: 'turn failed', retryable: true } });
          return;
        }

        if (mode === 'echo_prompt') {
          write({ id: message.id, result: { result: message.params.prompt, sessionId: 'fake-session' } });
          return;
        }

        write({ method: 'message/delta', params: { textDelta: 'working' } });
        write({ method: 'usage/updated', params: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
        write({ id: message.id, result: { result: 'done', sessionId: 'fake-session' } });
        return;
      }

      if (message.method === 'session/stop') {
        write({ id: message.id, result: { stopped: true } });
        process.exit(0);
      }
    });
    """
  end

  defp stubbed_sdk_bridge! do
    root =
      Path.join(
        System.tmp_dir!(),
        "stubbed-claude-sdk-#{System.unique_integer([:positive])}"
      )

    module_dir = Path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk")
    File.mkdir_p!(module_dir)

    File.write!(Path.join(module_dir, "package.json"), ~s({"type":"module"}))

    File.write!(Path.join(module_dir, "index.js"), """
    export async function* query(request) {
      const result = await request.options.canUseTool(
        'Bash',
        { command: 'pwd' },
        { permissionMode: request.options.permissionMode, toolUseID: 'toolu_1' }
      );

      yield { type: 'permission_result', result };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      yield { type: 'result', result: 'done' };
    }
    """)

    bridge = Path.join(root, "bridge.js")

    File.cp!(
      Path.expand("../../../priv/claude_agent_bridge/bridge.js", __DIR__),
      bridge
    )

    bridge
  end

  defp shell_escape(value) do
    "'" <> String.replace(value, "'", "'\"'\"'") <> "'"
  end
end
