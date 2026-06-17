defmodule SymphonyElixir.ToolRegistryTest do
  use ExUnit.Case, async: false
  import SymphonyElixir.TestSupport, only: [delete_app_env: 2, delete_system_envs: 1, put_app_envs: 2]

  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.Tools.Echo

  defmodule TestTool do
    @behaviour SymphonyElixir.Tool

    @impl true
    def name, do: "test.registered"

    @impl true
    def description, do: "A test-only registered tool."

    @impl true
    def parameters_schema, do: %{"type" => "object", "properties" => %{}}

    @impl true
    def bundle, do: :test

    @impl true
    def execution_kind, do: :runtime

    @impl true
    def execute(arguments, context), do: {:ok, %{arguments: arguments, context: context}}
  end

  describe "get/1" do
    test "resolves default tools" do
      assert ToolRegistry.get("echo") == {:ok, Echo}
    end

    test "returns :error for unknown tools" do
      assert ToolRegistry.get("missing") == :error
    end
  end

  describe "register/1" do
    test "registers a module implementing the tool behaviour" do
      assert :ok = ToolRegistry.register(TestTool)
      assert ToolRegistry.get("test.registered") == {:ok, TestTool}
    end

    test "keeps registered tools after the registering process exits" do
      task = Task.async(fn -> ToolRegistry.register(TestTool) end)

      assert Task.await(task) == :ok
      assert ToolRegistry.get("test.registered") == {:ok, TestTool}
    end

    test "handles concurrent registration safely" do
      results =
        1..16
        |> Task.async_stream(fn _index -> ToolRegistry.register(TestTool) end, max_concurrency: 16)
        |> Enum.map(fn {:ok, result} -> result end)

      assert Enum.all?(results, &(&1 == :ok))
      assert ToolRegistry.get("test.registered") == {:ok, TestTool}
    end
  end

  describe "bundle/1" do
    test "returns known tool names for a bundle" do
      assert "echo" in ToolRegistry.bundle(:test)
      assert "list_plans" in ToolRegistry.bundle(:manager)
    end
  end

  describe "execute/4" do
    test "enforces the allowlist before dispatch" do
      assert ToolRegistry.execute("echo", %{}, %{}, []) == {:error, :not_allowed}
    end

    test "returns unknown_tool for allowed missing tools" do
      assert ToolRegistry.execute("missing", %{}, %{}, ["missing"]) == {:error, :unknown_tool}
    end

    test "executes allowed tools and normalizes output" do
      assert {:ok, result} =
               ToolRegistry.execute(
                 "echo",
                 %{"message" => "hello"},
                 %{request_id: "req_123", ignored: true},
                 ["echo"]
               )

      assert result == %{
               output: %{
                 arguments: %{"message" => "hello"},
                 context: %{"request_id" => "req_123"}
               },
               usage: nil,
               metadata: %{tool: "echo"}
             }
    end

    test "accepts MapSet allowlists" do
      assert {:ok, _result} = ToolRegistry.execute("echo", %{}, %{}, MapSet.new(["echo"]))
    end
  end

  describe "provider_specs/2" do
    test "emits OpenAI-compatible provider specs for registered tools" do
      assert [
               %{
                 "type" => "function",
                 "function" => %{
                   "name" => "echo",
                   "description" => description,
                   "parameters" => %{"type" => "object"}
                 }
               }
             ] = ToolRegistry.provider_specs(["echo"], :openai_compatible)

      assert description =~ "Echoes"
    end

    test "ignores unknown tools" do
      assert ToolRegistry.provider_specs(["missing"], :openai_compatible) == []
    end
  end

  describe "resolve_for_agent/1" do
    setup do
      put_app_envs(:symphony_elixir,
        tool_registry_req_options: [plug: {Req.Test, ToolRegistry}],
        tool_registry_db: [
          endpoint: "https://test.supabase.co/rest/v1",
          api_key: "test-api-key",
          grant_table: "agent_tool_grant"
        ]
      )

      :ok
    end

    test "reads included enabled grants from agent_tool_grant" do
      Req.Test.stub(ToolRegistry, fn conn ->
        assert conn.method == "GET"
        params = URI.decode_query(conn.query_string)

        rows =
          case conn.request_path do
            "/rest/v1/agent_tool_grant" ->
              assert params["agent_id"] == "eq.agent-1"
              assert params["mode"] == "eq.include"
              assert params["select"] == "tool_id"
              assert params["order"] == "created_at.asc.nullslast"
              refute conn.query_string =~ "tool_policy_template"
              [%{"tool_id" => "tool-echo"}, %{"tool_id" => "tool-repo"}]

            "/rest/v1/tool" ->
              assert params["enabled"] == "eq.true"
              assert params["select"] == "id,slug"
              [%{"id" => "tool-echo", "slug" => "echo"}, %{"id" => "tool-repo", "slug" => "repo.read_file"}]
          end

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!(rows))
      end)

      assert {:ok, resolved} = ToolRegistry.resolve_for_agent("agent-1")
      assert resolved.source == "agent_tool_grant"
      assert resolved.dynamic_tool_names == ["echo", "repo.read_file"]
      assert Enum.map(resolved.dynamic_tool_specs, & &1["name"]) == ["echo", "repo.read_file"]
      assert Enum.map(resolved.tool_definitions, & &1["name"]) == ["echo", "repo.read_file"]
    end

    test "drops disabled and unknown tools from returned rows" do
      Req.Test.stub(ToolRegistry, fn conn ->
        rows =
          case conn.request_path do
            "/rest/v1/agent_tool_grant" ->
              [%{"tool_id" => "tool-echo"}, %{"tool_id" => "tool-apply"}, %{"tool_id" => "tool-unknown"}]

            # The catalog query filters enabled=true server-side, so the disabled
            # apply_patch tool is simply absent from the response.
            "/rest/v1/tool" ->
              [%{"id" => "tool-echo", "slug" => "echo"}, %{"id" => "tool-unknown", "slug" => "unknown.runtime_tool"}]
          end

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!(rows))
      end)

      assert {:ok, resolved} = ToolRegistry.resolve_for_agent("agent-1")
      assert resolved.dynamic_tool_names == ["echo"]
    end

    test "returns config errors without raising" do
      delete_app_env(:symphony_elixir, :tool_registry_db)
      delete_system_envs(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])

      assert {:error, {:missing_supabase_config, message}} = ToolRegistry.resolve_for_agent("agent-1")
      assert message =~ "Supabase PostgREST endpoint is not configured"
    end
  end
end
