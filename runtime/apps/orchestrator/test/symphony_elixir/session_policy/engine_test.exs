defmodule SymphonyElixir.SessionPolicy.EngineTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.SessionPolicy.Engine

  test "cost_budget asks once when accrued cost crosses a configured threshold" do
    policy = %{
      "kind" => "cost_budget",
      "params" => %{"max_cost_usd" => 1.0, "ask_thresholds_usd" => [0.05]}
    }

    result = Engine.evaluate([policy], %{"type" => "llm_usage", "cost_usd" => 0.06}, %{})

    assert result.verdict == :ask
    assert result.state["accrued_cost_usd"] == 0.06
    assert result.state["cost_budget_asked_thresholds"] == [0.05]
    assert [%{kind: "cost_budget", code: "ask_threshold_crossed"}] = result.reasons

    second = Engine.evaluate([policy], %{"type" => "llm_usage", "cost_usd" => 0.01}, result.state)

    assert second.verdict == :allow
    assert_in_delta second.state["accrued_cost_usd"], 0.07, 0.000_001
    assert second.state["cost_budget_asked_thresholds"] == [0.05]
  end

  test "cost_budget denies once accrued cost exceeds max" do
    policy = %{
      "kind" => "cost_budget",
      "params" => %{"max_cost_usd" => 0.1, "ask_thresholds_usd" => [0.05]}
    }

    result = Engine.evaluate([policy], %{"type" => "llm_usage", "cost_usd" => 0.11}, %{})

    assert result.verdict == :deny
    assert [%{kind: "cost_budget", code: "max_cost_exceeded"}] = result.reasons
  end

  test "risk_score accrues guarded tool weights and asks when threshold is reached" do
    policy = %{
      "kind" => "risk_score",
      "params" => %{
        "guarded_tools" => ["shell.exec", "git.run"],
        "threshold" => 3,
        "weights" => %{"shell.exec" => 2, "git.run" => 1}
      }
    }

    first = Engine.evaluate([policy], %{"type" => "tool_call", "target" => "shell.exec"}, %{})

    assert first.verdict == :allow
    assert first.state["tool_call_count"] == 1
    assert first.state["risk_points"] == 2

    second = Engine.evaluate([policy], %{"type" => "tool_call", "target" => "git.run"}, first.state)

    assert second.verdict == :ask
    assert second.state["tool_call_count"] == 2
    assert second.state["risk_points"] == 3
    assert [%{kind: "risk_score", code: "threshold_reached"}] = second.reasons
  end

  test "risk_score can deny at threshold and ignores unguarded tools" do
    policy = %{
      "kind" => "risk_score",
      "params" => %{
        "guarded_tools" => ["shell.exec"],
        "threshold" => 1,
        "verdict" => "deny"
      }
    }

    ignored = Engine.evaluate([policy], %{"type" => "tool_call", "target" => "scheduled_task.list"}, %{})

    assert ignored.verdict == :allow
    assert ignored.state["risk_points"] == nil
    assert ignored.state["tool_call_count"] == 1

    denied = Engine.evaluate([policy], %{"type" => "tool_call", "target" => "shell.exec"}, ignored.state)

    assert denied.verdict == :deny
    assert denied.state["risk_points"] == 1
  end

  test "risk_score does not create atoms for custom tool names or state keys" do
    tool_name = "custom.tool.#{System.unique_integer([:positive])}"

    policy = %{
      "kind" => "risk_score",
      "params" => %{
        "guarded_tools" => [tool_name],
        "threshold" => 10,
        "weights" => %{tool_name => 4}
      }
    }

    before_atoms = :erlang.system_info(:atom_count)
    result = Engine.evaluate([policy], %{"type" => "tool_call", "target" => tool_name}, %{})
    after_atoms = :erlang.system_info(:atom_count)

    assert result.verdict == :allow
    assert result.state["risk_points"] == 4
    assert after_atoms == before_atoms
  end
end
