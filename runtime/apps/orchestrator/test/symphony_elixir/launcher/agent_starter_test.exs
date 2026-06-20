defmodule SymphonyElixir.Launcher.AgentStarterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.AgentStarter
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved

  defmodule GatewayConfigMock do
    @behaviour SymphonyElixir.Launcher.GatewayConfig

    def fetch("agent", "agent-1") do
      {:ok,
       %Resolved{
         scope_type: "agent",
         scope_id: "agent-1",
         config_hash: "hash-1",
         version: 1,
         config_json: %{
           "tracker" => %{"kind" => "database"},
           "execution_profile" => %{
             "runner_kind" => "codex",
             "provider" => "openai_codex",
             "model" => "gpt-5.2"
           }
         }
       }}
    end

    def fetch(_scope_type, _scope_id), do: {:error, :not_found}
    def record_apply_state(_scope_type, _scope_id, _status, _opts), do: :ok
  end

  setup do
    put_app_env(:symphony_elixir, :launcher_gateway_config_adapter, GatewayConfigMock)

    agent = %Agent{
      id: "agent-1",
      name: "Builder",
      workspace_id: "workspace-1",
      type: "coding"
    }

    %{agent: agent}
  end

  test "preserves skills snapshot from launch params in resolved runtime config", %{agent: agent} do
    skills_snapshot = %{
      "version" => 1,
      "agentId" => "agent-1",
      "workspaceId" => "workspace-1",
      "skills" => [%{"name" => "api-debugging", "body" => "Inspect logs."}]
    }

    assert {:ok, config, _resolution} =
             AgentStarter.resolve_and_validate_agent_config(agent, %{
               "trace_id" => "trace-1",
               "skills_snapshot" => skills_snapshot
             })

    assert config["trace_id"] == "trace-1"
    assert config["skills_snapshot"] == skills_snapshot
  end
end
