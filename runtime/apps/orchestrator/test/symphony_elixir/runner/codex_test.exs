defmodule SymphonyElixir.Runner.CodexTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.Codex
  alias SymphonyElixir.WorkItem

  describe "requires_workspace?/0" do
    test "returns true" do
      assert Codex.requires_workspace?() == true
    end
  end

  describe "ping/1" do
    test "returns :ok when codex binary is found" do
      # codex may or may not be on PATH in CI, so just verify the function runs
      result = Codex.ping(%{})
      assert result == :ok or match?({:error, :codex_not_found}, result)
    end

    test "returns error when binary not found" do
      # Temporarily modify PATH to ensure codex won't be found
      original_path = System.get_env("PATH")
      System.put_env("PATH", "/nonexistent")

      try do
        assert {:error, :codex_not_found} = Codex.ping(%{})
      after
        restore_env("PATH", original_path)
      end
    end
  end

  describe "start_session/2" do
    test "delegates to AppServer (integration smoke test)" do
      # This will fail because no real codex binary is running,
      # but it verifies the delegation path is wired up
      result = Codex.start_session(%{}, "/nonexistent/workspace")
      assert match?({:error, _}, result)
    end

    test "can run a real Codex app-server round trip when explicitly configured" do
      workspace = System.get_env("OPENMACAW_REAL_CODEX_WORKSPACE")

      if workspace && System.get_env("OPENMACAW_RUN_REAL_PROCESS_TESTS") == "1" do
        assert :ok = Codex.ping(%{})
        assert {:ok, session} = Codex.start_session(%{}, workspace)

        try do
          assert {:ok, result} = Codex.run_turn(session, "Reply with exactly: codex-real-process-ok", work_item())
          assert is_map(result)
        after
          Codex.stop_session(session)
        end
      else
        assert is_nil(workspace) || System.get_env("OPENMACAW_RUN_REAL_PROCESS_TESTS") != "1"
      end
    end
  end

  describe "stop_session/1" do
    test "delegates to AppServer" do
      # AppServer.stop_session expects a map with a real port
      # Opening and immediately closing a port validates the delegation path
      port = Port.open({:spawn, "echo ok"}, [:binary])
      assert :ok = Codex.stop_session(%{port: port})
    end
  end

  describe "classify_error/1" do
    test "maps 429-equivalent RPC errors to rate limits" do
      assert %{error_code: "provider_rate_limited", retryable: true, status_code: 429} =
               Codex.classify_error({:rpc_error, %{"code" => 429, "message" => "rate limited"}})
    end

    test "maps 5xx-equivalent RPC errors to overloaded" do
      assert %{error_code: "provider_overloaded", retryable: true, status_code: 503} =
               Codex.classify_error(%{"status" => 503, "message" => "unavailable"})
    end
  end

  describe "run_turn/3 cutover" do
    test "walks fallback chain after provider failure" do
      session = %{
        app_server_module: SymphonyElixir.Runner.CodexTest.FakeAppServer,
        model: "primary-model",
        model_provider: "openai_codex",
        workspace_id: "workspace-1",
        fallbacks: [
          %{"model" => "fallback-model", "provider" => "openai_codex"}
        ]
      }

      assert {:ok, %{model: "fallback-model"}} = Codex.run_turn(session, "do work", %{id: "work-1"})
    end
  end

  describe "coding runner I/O contract" do
    test "sends normalized input through the existing turn path" do
      session = %{app_server_module: SymphonyElixir.Runner.CodexTest.EchoAppServer}
      work_item = work_item()

      assert {:ok, %{prompt: "follow up", work_item: ^work_item}} =
               Codex.send_input(session, %{"message" => "follow up"}, work_item, [])
    end

    test "advertises streaming I/O capabilities" do
      assert %{
               input: :turn,
               output_stream: :runner_events,
               interrupt: :unsupported,
               tool_activity: true,
               metadata: %{backend: "codex_app_server"}
             } = Codex.stream_capabilities()
    end
  end

  defp work_item do
    %WorkItem{
      id: "work-1",
      identifier: "TEST-1",
      title: "Test work item",
      description: "Test",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{}
    }
  end
end

defmodule SymphonyElixir.Runner.CodexTest.FakeAppServer do
  @moduledoc false

  @spec run_turn(map(), String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def run_turn(%{model: "primary-model"}, _prompt, _work_item, _opts) do
    {:error, {:rpc_error, %{"code" => 429, "message" => "rate limited"}}}
  end

  def run_turn(%{model: "fallback-model"}, _prompt, _work_item, _opts) do
    {:ok, %{model: "fallback-model"}}
  end
end

defmodule SymphonyElixir.Runner.CodexTest.EchoAppServer do
  @moduledoc false

  @spec run_turn(map(), String.t(), map(), keyword()) :: {:ok, map()}
  def run_turn(_session, prompt, work_item, _opts) do
    {:ok, %{prompt: prompt, work_item: work_item}}
  end
end
