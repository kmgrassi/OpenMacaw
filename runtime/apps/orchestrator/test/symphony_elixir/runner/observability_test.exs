defmodule SymphonyElixir.Runner.ObservabilityTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.Runner.Observability

  setup do
    previous_url = System.get_env("SUPABASE_URL")
    previous_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
    previous_req_options = Application.get_env(:symphony_elixir, :provider_failure_persistence_req_options)

    on_exit(fn ->
      restore_env("SUPABASE_URL", previous_url)
      restore_env("SUPABASE_SERVICE_ROLE_KEY", previous_key)
      restore_app_env(:provider_failure_persistence_req_options, previous_req_options)
    end)

    :ok
  end

  test "classifies provider status failures with request ids" do
    response = %Req.Response{
      status: 429,
      headers: [{"x-request-id", "req-123"}],
      body: %{"error" => %{"message" => "slow down"}}
    }

    assert %{
             event: "model_call_failed",
             provider: "openai",
             model: "gpt-test",
             status: 429,
             status_code: 429,
             provider_status: 429,
             provider_request_id: "req-123",
             error_code: "provider_rate_limited",
             retryable: true,
             duration_ms: 42,
             attempt: 2,
             retry_count: 1,
             runner_kind: "manager",
             credential_id_suffix: "12345678",
             reason: "slow down"
           } =
             Observability.provider_status_failure(
               429,
               response.body,
               response,
               %{
                 provider: "openai",
                 model: "gpt-test",
                 attempt: 2,
                 runner_kind: "manager",
                 credential_id: "cred-12345678"
               },
               42
             )
  end

  test "persists provider failures as typed best-effort rows" do
    System.put_env("SUPABASE_URL", "https://test.supabase.co")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    Application.put_env(:symphony_elixir, :provider_failure_persistence_req_options, plug: {Req.Test, __MODULE__})

    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/provider_failure"
      assert {"prefer", "return=minimal"} in conn.req_headers

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(parent, {:provider_failure_payload, Jason.decode!(body)})

      Plug.Conn.send_resp(conn, 201, "{}")
    end)

    classification =
      Observability.provider_status_failure(
        429,
        %{"error" => %{"message" => "slow down"}},
        nil,
        %{
          workspace_id: "workspace-1",
          agent_id: "agent-1",
          work_item_id: nil,
          run_id: "run-1",
          runner_kind: "manager",
          provider: "openai",
          model: "gpt-5",
          attempt: 2
        },
        15
      )

    assert ^classification = Observability.log_provider_failure(classification)

    assert_receive {:provider_failure_payload,
                    %{
                      "workspace_id" => "workspace-1",
                      "agent_id" => "agent-1",
                      "run_id" => "run-1",
                      "runner_kind" => "manager",
                      "provider" => "openai",
                      "model" => "gpt-5",
                      "error_code" => "provider_rate_limited",
                      "status_code" => 429,
                      "attempt" => 2
                    }}
  end

  test "does not fail provider logging when provider_failure persistence fails" do
    System.put_env("SUPABASE_URL", "https://test.supabase.co")
    System.put_env("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    Application.put_env(:symphony_elixir, :provider_failure_persistence_req_options, plug: {Req.Test, __MODULE__})

    Req.Test.stub(__MODULE__, fn conn ->
      Plug.Conn.send_resp(conn, 503, Jason.encode!(%{"message" => "nope"}))
    end)

    classification = %{
      event: "model_call_failed",
      workspace_id: "workspace-1",
      runner_kind: "manager",
      provider: "openai",
      model: "gpt-5",
      error_code: "provider_rate_limited",
      attempt: 1
    }

    assert ^classification = Observability.log_provider_failure(classification)
  end

  test "classifies provider request timeouts" do
    assert %{
             event: "model_call_failed",
             error_code: "provider_timeout",
             retryable: true,
             duration_ms: 100
           } =
             Observability.provider_request_failure(
               %Mint.TransportError{reason: :timeout},
               %{provider: "openai", model: "gpt-test"},
               100
             )
  end

  test "classifies Anthropic refusal blocks as retryable content refusals" do
    body = %{
      "type" => "message",
      "content" => [
        %{"type" => "refusal", "refusal" => "I cannot help with that request."}
      ],
      "stop_reason" => "end_turn"
    }

    assert Observability.provider_content_refusal?(body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "anthropic",
             model: "claude-test"
           } =
             Observability.provider_content_refusal_failure(
               body,
               %{provider: "anthropic", model: "claude-test"},
               17
             )
  end

  test "classifies Anthropic top-level refusal stop reasons as content refusals" do
    body = %{
      "type" => "message",
      "content" => [%{"type" => "text", "text" => ""}],
      "stop_reason" => "refusal"
    }

    assert Observability.provider_content_refusal?(body)
  end

  test "classifies OpenAI content_filter finish reasons as retryable content refusals" do
    body = %{
      "choices" => [
        %{"finish_reason" => "content_filter", "message" => %{"content" => ""}}
      ]
    }

    assert Observability.provider_content_refusal?(body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openai",
             model: "gpt-test"
           } =
             Observability.provider_content_refusal_failure(
               body,
               %{provider: "openai", model: "gpt-test"},
               23
             )
  end

  test "classifies OpenClaw content-policy 4xx responses as retryable content refusals" do
    body = %{"error" => %{"code" => "content_policy_violation", "message" => "blocked by content policy"}}

    assert Observability.content_policy_status_failure?(403, body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openclaw",
             runner_kind: "openclaw"
           } =
             Observability.provider_status_failure(
               403,
               body,
               nil,
               %{provider: "openclaw", runner_kind: "openclaw"},
               31
             )
  end

  test "classifies ComputerUse content-policy 4xx responses as retryable content refusals" do
    body = %{"message" => "request refused by safety policy"}

    assert Observability.content_policy_status_failure?(422, body)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "computer_use",
             runner_kind: "computer_use"
           } =
             Observability.provider_status_failure(
               422,
               body,
               nil,
               %{provider: "computer_use", runner_kind: "computer_use"},
               31
             )
  end

  test "classifies Codex AppServer refusal-shaped RPC errors as retryable content refusals" do
    reason =
      {:response_error,
       %{
         "code" => "content_filter",
         "message" => "model refused the prompt",
         "data" => %{"type" => "content_policy"}
       }}

    assert Observability.codex_content_refusal_error?(reason)

    assert %{
             error_code: "provider_content_refused",
             retryable: true,
             provider: "openai_codex",
             runner_kind: "codex"
           } =
             Observability.provider_error_failure(
               reason,
               %{provider: "openai_codex", runner_kind: "codex"},
               44
             )
  end

  test "emits redacted structured model call lifecycle logs" do
    log =
      capture_log(fn ->
        context = %{
          provider: "openai",
          model: "gpt-test",
          runner_kind: "planner",
          credential_id: "cred-secret-abcdef12",
          credential_scope: "workspace",
          trace_id: "trace-1",
          workspace_id: "workspace-1",
          agent_id: "agent-1",
          attempt: 3
        }

        Observability.log_model_call_started(context)
        Observability.log_model_call_completed(context, 25, status_code: 200, provider_request_id: "req-1")
      end)

    entries =
      Regex.scan(~r/\{.*\}/, log)
      |> Enum.map(fn [line] -> Jason.decode!(line) end)

    assert Enum.any?(entries, &(&1["event"] == "model_call_started"))

    assert Enum.any?(entries, fn entry ->
             entry["event"] == "model_call_completed" and
               entry["provider"] == "openai" and
               entry["runner_kind"] == "planner" and
               entry["credential_id_suffix"] == "abcdef12" and
               entry["credential_scope"] == "workspace" and
               entry["retry_count"] == 2 and
               entry["status_code"] == 200 and
               entry["provider_request_id"] == "req-1"
           end)
  end

  test "emits model request context summaries without raw message text by default" do
    log =
      capture_log(fn ->
        Observability.log_model_request_context_prepared(
          %{
            provider: "local",
            model: "qwen",
            runner_kind: "local_relay",
            trace_id: "trace-1",
            workspace_id: "workspace-1",
            agent_id: "agent-1",
            run_id: "run-1"
          },
          %{
            "type" => "dispatch",
            "correlation_id" => "corr-1",
            "target_runner_kind" => "openai_compatible",
            "messages" => [
              %{"role" => "system", "content" => "Base prompt\n\nAgent instructions:\nUse git."},
              %{"role" => "user", "content" => "list PRs"}
            ],
            "tool_definitions" => [%{"name" => "git.run"}],
            "provider_tool_specs" => [%{"function" => %{"name" => "git_run"}}]
          }
        )
      end)

    [entry] =
      Regex.scan(~r/\{.*\}/, log)
      |> Enum.map(fn [line] -> Jason.decode!(line) end)
      |> Enum.filter(&(&1["event"] == "model_request_context_prepared"))

    assert entry["provider"] == "local"
    assert entry["model"] == "qwen"
    assert entry["target_runner_kind"] == "openai_compatible"
    assert entry["message_count"] == 2
    assert entry["message_roles"] == ["system", "user"]
    assert [%{"has_agent_instructions" => true}, %{"has_agent_instructions" => false}] = entry["message_context"]
    assert entry["tool_definition_names"] == ["git.run"]
    assert entry["provider_tool_names"] == ["git_run"]
    refute Map.has_key?(entry, "raw_messages")
    refute log =~ "Use git."
    refute log =~ "list PRs"
  end

  test "classifies tool policy denials and preserves execution metadata" do
    result = %{
      "success" => false,
      "output" =>
        Jason.encode!(%{
          "error" => %{
            "message" => "Dynamic tool \"linear_graphql\" is not allowed by this agent's tool policy."
          }
        })
    }

    assert %{
             "success" => false,
             "tool_name" => "linear_graphql",
             "tool_call_id" => "call-1",
             "error_code" => "tool_denied",
             "retryable" => false,
             "duration_ms" => 7,
             "attempt" => 1
           } =
             Observability.classify_tool_result(
               result,
               %{tool_name: "linear_graphql", tool_call_id: "call-1"},
               7
             )
  end

  test "classifies manager invalid argument tool failures" do
    result = %{
      "success" => false,
      "error" => "invalid_arguments",
      "output" => Jason.encode!(%{"error" => "invalid_arguments", "reason" => "missing work_item_id"})
    }

    assert %{"error_code" => "tool_invalid_args", "retryable" => false} =
             Observability.classify_tool_result(result, %{tool_name: "snooze"}, 3)
  end

  test "classifies an empty-args git.run helper failure as invalid args, not unknown" do
    result = %{
      "success" => false,
      "error" => "helper_tool_failed",
      "output" => Jason.encode!(%{"error" => "invalid_arguments", "message" => "missing command"})
    }

    assert %{"error_code" => "tool_invalid_args"} =
             Observability.classify_tool_result(result, %{tool_name: "git.run"}, 5)
  end

  test "classifies a relay-level helper failure by its reason and keeps it retryable" do
    result = %{
      "success" => false,
      "error" => "tool_execution_timeout",
      "output" =>
        Jason.encode!(%{
          "error" => "helper_tool_failed",
          "tool" => "git.run",
          "reason" => ":tool_execution_timeout"
        })
    }

    assert %{"error_code" => "tool_timeout", "retryable" => true} =
             Observability.classify_tool_result(result, %{tool_name: "git.run"}, 5)
  end

  test "classifies an unsupported local tool as tool_unknown" do
    result = %{
      "success" => false,
      "error" => "helper_tool_failed",
      "output" => Jason.encode!(%{"error" => "unsupported_local_tool", "name" => "bogus.tool"})
    }

    assert %{"error_code" => "tool_unknown"} =
             Observability.classify_tool_result(result, %{tool_name: "bogus.tool"}, 5)
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)

  defp restore_app_env(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app_env(key, value), do: Application.put_env(:symphony_elixir, key, value)
end
