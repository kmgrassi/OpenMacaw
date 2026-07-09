defmodule SymphonyElixir.Policy.EngineTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Policy.Engine
  alias SymphonyElixir.Policy.StateStore
  alias SymphonyElixir.PostgRESTClient

  test "denies before ask and otherwise asks before allow" do
    event = tool_event([policy("ask_on_tool", %{"tools" => ["shell.exec"]}), policy("block_tools", %{"tools" => ["shell.exec"]}, scope: "workspace")])
    assert {:deny, reason} = Engine.evaluate_stateless(event)
    assert reason =~ "blocked"

    event = tool_event([policy("ask_on_tool", %{"tools" => ["shell.exec"]})])
    assert {:ask, reason} = Engine.evaluate_stateless(event)
    assert reason =~ "requires approval"
  end

  test "sorts by tier then priority and disabled policies are ignored" do
    event =
      tool_event([
        policy("block_tools", %{"tools" => ["other"]}, scope: "workspace", priority: 0),
        policy("block_tools", %{"tools" => ["shell.exec"]}, scope: "session", priority: 10),
        %{scope: "agent", kind: "block_tools", params: %{"tools" => ["shell.exec"]}, priority: 0, enabled: false}
      ])

    assert {:deny, reason} = Engine.evaluate_stateless(event)
    assert reason =~ "shell.exec"
  end

  test "increments tool_call_count and denies at max_tool_calls_per_session limit" do
    policy = policy("max_tool_calls_per_session", %{"limit" => 2})
    event = tool_event([policy])

    assert {:allow, %{"tool_call_count" => 1}, [{"tool_call_count", 1}]} =
             Engine.evaluate_with_state(event, %{})

    assert {:allow, %{"tool_call_count" => 2}, [{"tool_call_count", 2}]} =
             Engine.evaluate_with_state(event, %{"tool_call_count" => 1})

    assert {{:deny, reason}, %{"tool_call_count" => 2}, []} =
             Engine.evaluate_with_state(event, %{"tool_call_count" => 2})

    assert reason =~ "limit of 2"
  end

  test "hydrates restart state from policy_session_state before evaluating" do
    test_name = :"policy_engine_restart_#{System.unique_integer([:positive])}"
    client = PostgRESTClient.new(%{endpoint: "https://test.supabase.co", api_key: "secret"}, plug: {Req.Test, test_name})
    parent = self()

    Req.Test.stub(test_name, fn conn ->
      send(parent, {:request, conn.method, conn.request_path, URI.decode_query(conn.query_string)})

      case conn.method do
        "GET" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([%{"key" => "tool_call_count", "value_numeric" => 2, "value_json" => nil}]))

        "POST" ->
          Plug.Conn.send_resp(conn, 201, "")
      end
    end)

    Req.Test.allow(test_name, self(), self())
    assert %{"tool_call_count" => 2} = StateStore.hydrate(client, "thread-1")

    server = :"policy_engine_#{System.unique_integer([:positive])}"
    server_pid = start_supervised!({Engine, name: server})
    Req.Test.allow(test_name, self(), server_pid)

    event =
      tool_event([policy("max_tool_calls_per_session", %{"limit" => 3})])
      |> put_in([:session, :session_thread_id], "thread-1")
      |> put_in([:session, :workspace_id], "workspace-1")

    assert :allow = Engine.evaluate(event, server: server, postgrest_client: client)
    assert {:deny, reason} = Engine.evaluate(event, server: server, postgrest_client: client)
    assert reason =~ "limit of 3"

    assert_received {:request, "GET", "/rest/v1/policy_session_state", %{"session_thread_id" => "eq.thread-1"}}
    assert_received {:request, "POST", "/rest/v1/policy_session_state", %{"on_conflict" => "session_thread_id,key"}}
  end

  test "uses session_id as policy state key when session_thread_id is absent" do
    test_name = :"policy_engine_session_id_#{System.unique_integer([:positive])}"
    client = PostgRESTClient.new(%{endpoint: "https://test.supabase.co", api_key: "secret"}, plug: {Req.Test, test_name})
    parent = self()

    Req.Test.stub(test_name, fn conn ->
      send(parent, {:request, conn.method, conn.request_path, URI.decode_query(conn.query_string), conn.body_params})

      case conn.method do
        "GET" ->
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, Jason.encode!([]))

        "POST" ->
          Plug.Conn.send_resp(conn, 201, "")
      end
    end)

    server = :"policy_engine_#{System.unique_integer([:positive])}"
    server_pid = start_supervised!({Engine, name: server})
    Req.Test.allow(test_name, self(), server_pid)

    event =
      tool_event([policy("max_tool_calls_per_session", %{"limit" => 2})])
      |> put_in([:session, :session_thread_id], nil)
      |> put_in([:session, :session_id], "runner-session-1")
      |> put_in([:session, :workspace_id], "workspace-1")

    assert :allow = Engine.evaluate(event, server: server, postgrest_client: client)

    assert_received {:request, "GET", "/rest/v1/policy_session_state", %{"session_thread_id" => "eq.runner-session-1"}, _body}

    assert_received {:request, "POST", "/rest/v1/policy_session_state", %{"on_conflict" => "session_thread_id,key"}, %{"session_thread_id" => "runner-session-1", "key" => "tool_call_count"}}
  end

  defp tool_event(policies) do
    %{
      type: :tool_call,
      target: "shell.exec",
      data: %{},
      session: %{workspace_id: "workspace-1", session_thread_id: "thread-1", policies: policies}
    }
  end

  defp policy(kind, params, opts \\ []) do
    %{
      "id" => "#{kind}-#{System.unique_integer([:positive])}",
      "scope" => Keyword.get(opts, :scope, "session"),
      "kind" => kind,
      "params" => params,
      "priority" => Keyword.get(opts, :priority, 0),
      "enabled" => Keyword.get(opts, :enabled, true)
    }
  end
end
