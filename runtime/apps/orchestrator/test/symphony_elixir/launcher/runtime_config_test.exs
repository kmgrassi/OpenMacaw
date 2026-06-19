defmodule SymphonyElixir.Launcher.RuntimeConfigTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Launcher.RuntimeConfig

  test "equivalent?/2 ignores trace ids in top-level and runtime config" do
    left = %{
      trace_id: "trace-left",
      runtime: %{trace_id: "runtime-left"},
      credentials: %{"OPENAI_API_KEY" => "secret"}
    }

    right = %{
      "trace_id" => "trace-right",
      "runtime" => %{"trace_id" => "runtime-right"},
      "credentials" => %{"OPENAI_API_KEY" => "secret"}
    }

    assert RuntimeConfig.equivalent?(left, right)
  end

  test "resolved_credentials?/1 recognizes credentials and tracker api keys" do
    assert RuntimeConfig.resolved_credentials?(%{"credentials" => %{"OPENAI_API_KEY" => "secret"}})
    assert RuntimeConfig.resolved_credentials?(%{"tracker" => %{"api_key" => "lin_api_key"}})
    refute RuntimeConfig.resolved_credentials?(%{"credentials" => %{}})
    refute RuntimeConfig.resolved_credentials?(%{"tracker" => %{}})
  end

  test "format_error/1 returns invalid agent config messages directly" do
    assert RuntimeConfig.format_error({:invalid_agent_config, "bad config", %{}}) == "bad config"
    assert RuntimeConfig.format_error(:timeout) == ":timeout"
  end
end
