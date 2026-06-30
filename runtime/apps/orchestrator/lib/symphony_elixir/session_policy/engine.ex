defmodule SymphonyElixir.SessionPolicy.Engine do
  @moduledoc """
  Evaluates mutable per-session policy rules.

  This module is intentionally side-effect free: callers pass the active policy
  rows and current durable state, then persist the returned state through the
  `policy_session_state` table.
  """

  @type policy :: map()
  @type event :: map()
  @type state :: %{optional(String.t()) => term()}
  @type verdict :: :allow | :ask | :deny
  @type evaluation :: %{
          verdict: verdict(),
          reasons: [map()],
          state: state()
        }

  @spec evaluate([policy()], event(), state()) :: evaluation()
  def evaluate(policies, event, state \\ %{}) when is_list(policies) and is_map(event) and is_map(state) do
    enabled_policies = Enum.filter(policies, &enabled?/1)
    event_type = event_type(event)
    state = apply_event_counters(event_type, event, state)

    {verdict, reasons, state} =
      Enum.reduce(enabled_policies, {:allow, [], state}, fn policy, {verdict, reasons, state} ->
        {policy_verdict, policy_reasons, state} = evaluate_policy(policy, event_type, event, state)
        {stronger_verdict(verdict, policy_verdict), reasons ++ policy_reasons, state}
      end)

    %{verdict: verdict, reasons: reasons, state: state}
  end

  defp enabled?(%{"enabled" => false}), do: false
  defp enabled?(%{enabled: false}), do: false
  defp enabled?(_policy), do: true

  defp event_type(event), do: string_value(event, ["type", :type])

  defp apply_event_counters("llm_usage", event, state) do
    increment_numeric(state, "accrued_cost_usd", numeric_value(event, ["cost_usd", :cost_usd, "costUsd", :costUsd]))
  end

  defp apply_event_counters("llm_request", event, state) do
    increment_numeric(state, "accrued_cost_usd", numeric_value(event, ["cost_usd", :cost_usd, "costUsd", :costUsd]))
  end

  defp apply_event_counters("tool_call", _event, state) do
    increment_numeric(state, "tool_call_count", 1)
  end

  defp apply_event_counters(_type, _event, state), do: state

  defp evaluate_policy(policy, event_type, _event, state) when event_type in ["llm_usage", "llm_request"] do
    case policy_kind(policy) do
      "cost_budget" -> evaluate_cost_budget(policy_params(policy), state)
      _kind -> {:allow, [], state}
    end
  end

  defp evaluate_policy(policy, "tool_call", event, state) do
    case policy_kind(policy) do
      "risk_score" -> evaluate_risk_score(policy_params(policy), event, state)
      _kind -> {:allow, [], state}
    end
  end

  defp evaluate_policy(_policy, _event_type, _event, state), do: {:allow, [], state}

  defp evaluate_cost_budget(params, state) do
    accrued = numeric_state(state, "accrued_cost_usd")
    max_cost = numeric_value(params, ["max_cost_usd", :max_cost_usd, "maxCostUsd", :maxCostUsd])

    cond do
      is_number(max_cost) and accrued > max_cost ->
        {:deny, [reason("cost_budget", "max_cost_exceeded", %{accrued_cost_usd: accrued, max_cost_usd: max_cost})], state}

      threshold = first_unasked_threshold(params, state, accrued) ->
        state = remember_asked_threshold(state, threshold)

        {:ask,
         [
           reason("cost_budget", "ask_threshold_crossed", %{
             accrued_cost_usd: accrued,
             ask_threshold_usd: threshold
           })
         ], state}

      true ->
        {:allow, [], state}
    end
  end

  defp evaluate_risk_score(params, event, state) do
    tool_name = string_value(event, ["target", :target, "tool_name", :tool_name, "name", :name])
    guarded_tools = string_list(params, ["guarded_tools", :guarded_tools, "guardedTools", :guardedTools])

    if tool_name in guarded_tools do
      weight = risk_weight(params, tool_name)
      state = increment_numeric(state, "risk_points", weight)
      risk_points = numeric_state(state, "risk_points")
      threshold = numeric_value(params, ["threshold", :threshold])

      if is_number(threshold) and risk_points >= threshold do
        verdict = verdict_value(params)

        {verdict,
         [
           reason("risk_score", "threshold_reached", %{
             tool_name: tool_name,
             risk_points: risk_points,
             threshold: threshold
           })
         ], state}
      else
        {:allow, [], state}
      end
    else
      {:allow, [], state}
    end
  end

  defp first_unasked_threshold(params, state, accrued) do
    asked = MapSet.new(number_list(state, "cost_budget_asked_thresholds"))

    params
    |> number_list(["ask_thresholds_usd", :ask_thresholds_usd, "askThresholdsUsd", :askThresholdsUsd])
    |> Enum.sort()
    |> Enum.find(&(accrued >= &1 and not MapSet.member?(asked, &1)))
  end

  defp remember_asked_threshold(state, threshold) do
    thresholds =
      state
      |> number_list("cost_budget_asked_thresholds")
      |> Kernel.++([threshold])
      |> Enum.uniq()
      |> Enum.sort()

    Map.put(state, "cost_budget_asked_thresholds", thresholds)
  end

  defp risk_weight(params, tool_name) do
    weights = map_value(params, ["weights", :weights]) || %{}
    numeric_value(weights, [tool_name, String.to_atom(tool_name), "default", :default]) || 1
  end

  defp verdict_value(params) do
    case string_value(params, ["verdict", :verdict]) do
      "deny" -> :deny
      _value -> :ask
    end
  end

  defp policy_kind(policy), do: string_value(policy, ["kind", :kind])
  defp policy_params(policy), do: map_value(policy, ["params", :params]) || %{}

  defp stronger_verdict(:deny, _verdict), do: :deny
  defp stronger_verdict(_verdict, :deny), do: :deny
  defp stronger_verdict(:ask, _verdict), do: :ask
  defp stronger_verdict(_verdict, :ask), do: :ask
  defp stronger_verdict(_left, _right), do: :allow

  defp increment_numeric(state, _key, nil), do: state

  defp increment_numeric(state, key, amount) when is_number(amount) do
    Map.put(state, key, numeric_state(state, key) + amount)
  end

  defp numeric_state(state, key), do: numeric_value(state, [key, String.to_atom(key)]) || 0

  defp reason(kind, code, details), do: %{kind: kind, code: code, details: details}

  defp string_value(map, keys) do
    case value_at(map, keys) do
      value when is_binary(value) -> value
      value when is_atom(value) -> Atom.to_string(value)
      _value -> nil
    end
  end

  defp numeric_value(map, keys) do
    case value_at(map, keys) do
      value when is_number(value) ->
        value

      value when is_binary(value) ->
        case Float.parse(value) do
          {number, ""} -> number
          _other -> nil
        end

      _value ->
        nil
    end
  end

  defp map_value(map, keys) do
    case value_at(map, keys) do
      value when is_map(value) -> value
      _value -> nil
    end
  end

  defp string_list(map, keys) do
    case value_at(map, keys) do
      values when is_list(values) -> Enum.filter(values, &is_binary/1)
      _value -> []
    end
  end

  defp number_list(map, key) when is_binary(key), do: number_list(map, [key, String.to_atom(key)])

  defp number_list(map, keys) do
    case value_at(map, keys) do
      values when is_list(values) -> Enum.flat_map(values, &number_from_value/1)
      _value -> []
    end
  end

  defp number_from_value(value) when is_number(value), do: [value]

  defp number_from_value(value) when is_binary(value) do
    case Float.parse(value) do
      {number, ""} -> [number]
      _other -> []
    end
  end

  defp number_from_value(_value), do: []

  defp value_at(map, keys) when is_map(map) and is_list(keys) do
    Enum.find_value(keys, fn key ->
      case Map.fetch(map, key) do
        {:ok, value} -> value
        :error -> nil
      end
    end)
  end

  defp value_at(_map, _keys), do: nil
end
