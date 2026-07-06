defmodule SymphonyElixir.Policy.EvaluatorRegistry do
  @moduledoc """
  Registry stub for session policy evaluator kinds.

  PR-2 only establishes the runtime-owned kind list so platform contracts and
  runtime evaluators cannot drift. Evaluation is implemented in the policy
  engine PR.
  """

  @policy_kinds ~w(
    max_tool_calls_per_session
    cost_budget
    ask_on_shell
    ask_on_tool
    block_tools
    risk_score
  )

  @spec policy_kinds() :: [String.t()]
  def policy_kinds, do: @policy_kinds

  @spec known?(String.t()) :: boolean()
  def known?(kind) when is_binary(kind), do: kind in @policy_kinds
  def known?(_kind), do: false
end
