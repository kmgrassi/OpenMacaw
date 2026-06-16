defmodule SymphonyElixirWeb.GatewaySocketCase do
  use ExUnit.CaseTemplate

  import ExUnit.Assertions

  alias SymphonyElixir.Gateway.SessionStore

  defmodule FakeRunner do
    def run(agent, scope, prompt, run_id, owner_pid) do
      send(owner_pid, {:fake_runner_workflow, SymphonyElixir.Launcher.ConfigRegistry.get(self())})

      send(
        owner_pid,
        {:gateway_runner_event, scope.session_key, run_id,
         %{
           event: :notification,
           payload: %{"params" => %{"textDelta" => "hello #{agent.name || scope.agent_id}"}}
         }}
      )

      send(owner_pid, {:gateway_runner_complete, scope.session_key, run_id, :ok})
      send(owner_pid, {:fake_runner_prompt, prompt})
      :ok
    end
  end

  defmodule FakeMessageLog do
    def upsert_session_thread(scope, opts) do
      send(owner(), {:message_log_upsert_session_thread, scope, opts})
      failure(:upsert_session_thread) || {:ok, "thread-1"}
    end

    def record_user_message(scope, session_thread_id, content, opts) do
      send(owner(), {:message_log_user_message, scope, session_thread_id, content, opts})
      failure(:record_user_message) || :ok
    end

    def record_assistant_message(scope, session_thread_id, content, run_id, metadata, opts \\ []) do
      send(
        owner(),
        {:message_log_assistant_message, scope, session_thread_id, content, run_id, metadata, opts}
      )

      failure(:record_assistant_message) || :ok
    end

    defp owner, do: Application.fetch_env!(:symphony_elixir, :gateway_socket_test_owner)

    defp failure(operation) do
      :symphony_elixir
      |> Application.get_env(:gateway_socket_test_message_log_failure, %{})
      |> Map.get(operation)
    end
  end

  defmodule AgentInventoryStub do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents, do: {:ok, []}

    def get_agent(agent_id) do
      {:ok,
       %Agent{
         id: agent_id,
         name: "Stub Agent",
         slug: "stub-agent",
         workspace_id: "22222222-2222-4222-8222-222222222222",
         model_settings: %{"model" => "gpt-5.3-codex", "provider" => "openai"},
         has_credentials: true
       }}
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  defmodule AgentInventoryUnavailableStub do
    @behaviour SymphonyElixir.AgentInventory

    def list_agents, do: {:ok, []}
    def get_agent(_agent_id), do: raise(ArgumentError, "agent inventory endpoint is required")
    def list_credentials(_agent_id), do: {:ok, []}
  end

  using do
    quote do
      use SymphonyElixir.TestSupport

      import ExUnit.CaptureLog
      import SymphonyElixirWeb.GatewaySocketCase

      alias SymphonyElixir.Gateway.SessionStore
      alias SymphonyElixirWeb.GatewaySocket
    end
  end

  setup do
    if is_nil(Process.whereis(SymphonyElixir.Launcher.ConfigRegistry)) do
      start_supervised!(SymphonyElixir.Launcher.ConfigRegistry)
    end

    Application.put_env(:symphony_elixir, :gateway_chat_runner, FakeRunner)
    Application.put_env(:symphony_elixir, :agent_inventory_adapter, AgentInventoryStub)
    Application.put_env(:symphony_elixir, :message_log_adapter, FakeMessageLog)
    Application.put_env(:symphony_elixir, :gateway_socket_test_owner, self())
    Application.put_env(:symphony_elixir, :gateway_socket_test_message_log_failure, %{})

    restart_session_store!()

    :ok
  end

  def request_frame(method, params) do
    Jason.encode!(%{type: "req", id: Ecto.UUID.generate(), method: method, params: params})
  end

  def scope_query do
    %{
      "agent_id" => "11111111-1111-4111-8111-111111111111",
      "workspace_id" => "22222222-2222-4222-8222-222222222222",
      "user_id" => "33333333-3333-4333-8333-333333333333"
    }
  end

  def default_session_key do
    "22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111"
  end

  def logged_event!(log, event_name) do
    log
    |> String.split("\n", trim: true)
    |> Enum.find_value(fn line ->
      with [_, json] <- Regex.run(~r/(\{.*\})/, line),
           {:ok, %{"event" => ^event_name} = payload} <- Jason.decode(json) do
        payload
      else
        _ -> nil
      end
    end) ||
      flunk("expected #{event_name} log in:\n#{log}")
  end

  def restart_session_store! do
    case Enum.find(Supervisor.which_children(SymphonyElixir.Supervisor), fn
           {SessionStore, _pid, _type, _modules} -> true
           _child -> false
         end) do
      {SessionStore, _pid, _type, _modules} ->
        :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SessionStore)
        {:ok, _pid} = Supervisor.restart_child(SymphonyElixir.Supervisor, SessionStore)
        :ok

      _ ->
        :ok
    end
  end
end
