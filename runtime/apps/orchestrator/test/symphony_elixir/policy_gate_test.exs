defmodule SymphonyElixir.PolicyGateTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.PolicyGate

  test "ask_on_tool writes escalation and allows after approval" do
    parent = self()

    session = %{
      workspace_id: Ecto.UUID.generate(),
      agent_id: Ecto.UUID.generate(),
      session_id: Ecto.UUID.generate(),
      run_id: Ecto.UUID.generate(),
      policies: [
        %{
          "id" => "policy-1",
          "scope" => "session",
          "kind" => "ask_on_tool",
          "params" => %{"tools" => ["read_file"]},
          "enabled" => true
        }
      ],
      policy_escalation_writer: fn payload ->
        send(parent, {:escalation, payload})
        Map.put(payload, "id", "esc-1")
      end,
      policy_approval_callback: fn request ->
        send(parent, {:approval_request, request})
        :approved
      end,
      on_message: fn event -> send(parent, {:event, event}) end
    }

    assert :allow =
             PolicyGate.evaluate(%{
               type: :tool_call,
               target: "read_file",
               data: %{"path" => "README.md"},
               session: session
             })

    assert_received {:escalation, %{"reason" => "Tool requires approval", "tool_name" => "read_file", "workspace_id" => _}}
    assert_received {:approval_request, %{"escalation" => %{"id" => "esc-1"}}}
    assert_received {:event, %{event: :approval_requested, payload: %{"approval_state" => "requested"}}}
    assert_received {:event, %{event: :approval_resolved, payload: %{"approval_state" => "approved", "decision" => "approved"}}}
  end

  test "ask_on_shell resolves refusal to deny" do
    session = %{
      policies: [%{"scope" => "workspace", "kind" => "ask_on_shell", "params" => %{}, "enabled" => true}],
      policy_approval_callback: fn _request -> :denied end
    }

    assert {:deny, %{"approval_state" => "denied", "policy_kind" => "ask_on_shell", "tool_name" => "shell.exec"}} =
             PolicyGate.evaluate(%{
               type: :tool_call,
               target: "shell.exec",
               data: %{"argv" => ["pwd"]},
               session: session
             })
  end
end
