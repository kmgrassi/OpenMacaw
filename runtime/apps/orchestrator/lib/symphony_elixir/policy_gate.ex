defmodule SymphonyElixir.PolicyGate do
  @moduledoc """
  Runtime policy gate for per-session tool-call decisions.

  The gate consumes resolved policy rows supplied on the session map. It is a
  no-op when no policies are present, which keeps the runtime behavior unchanged
  until the platform resolver threads policy configuration into a turn.
  """

  require Logger

  alias SymphonyElixir.PostgRESTClient

  @escalation_table "escalation"
  @shell_tools MapSet.new(["shell.exec", "shell", "bash", "terminal.exec"])

  @type decision :: :allow | {:deny, map()} | {:ask, map()}

  @spec evaluate(map()) :: decision()
  def evaluate(%{type: :tool_call, target: target, session: session} = event)
      when is_binary(target) and is_map(session) do
    event = Map.put_new(event, :data, %{})

    session
    |> policies()
    |> Enum.reduce_while(:allow, fn policy, verdict ->
      case policy_verdict(policy, event) do
        :abstain ->
          {:cont, verdict}

        {:ask, reason} ->
          {:cont, ask_verdict(verdict, policy, reason, event)}

        {:deny, reason} ->
          {:halt, {:deny, deny_payload(policy, reason, event)}}
      end
    end)
    |> resolve_ask(event)
  end

  def evaluate(_event), do: :allow

  defp policies(session) do
    session
    |> first_present([:policies, "policies", :policy_set, "policy_set", :resolved_policies, "resolved_policies"])
    |> case do
      policies when is_list(policies) ->
        policies
        |> Enum.filter(&enabled?/1)
        |> Enum.sort_by(&{scope_rank(map_value(&1, :scope)), priority(&1)})

      _ ->
        []
    end
  end

  defp enabled?(policy) when is_map(policy), do: map_value(policy, :enabled) != false
  defp enabled?(_policy), do: false

  defp scope_rank("session"), do: 0
  defp scope_rank(:session), do: 0
  defp scope_rank("agent"), do: 1
  defp scope_rank(:agent), do: 1
  defp scope_rank("workspace"), do: 2
  defp scope_rank(:workspace), do: 2
  defp scope_rank(_scope), do: 3

  defp priority(policy) do
    case map_value(policy, :priority) do
      value when is_integer(value) -> value
      value when is_binary(value) -> String.to_integer(value)
      _ -> 0
    end
  rescue
    ArgumentError -> 0
  end

  defp policy_verdict(policy, %{target: target}) do
    params = map_value(policy, :params) || %{}

    case map_value(policy, :kind) do
      "ask_on_tool" ->
        if target in string_list(map_value(params, :tools)), do: {:ask, "Tool requires approval"}, else: :abstain

      :ask_on_tool ->
        if target in string_list(map_value(params, :tools)), do: {:ask, "Tool requires approval"}, else: :abstain

      "ask_on_shell" ->
        if shell_tool?(target), do: {:ask, "Shell tool requires approval"}, else: :abstain

      :ask_on_shell ->
        if shell_tool?(target), do: {:ask, "Shell tool requires approval"}, else: :abstain

      "block_tools" ->
        if target in string_list(map_value(params, :tools)), do: {:deny, "Tool is blocked by policy"}, else: :abstain

      :block_tools ->
        if target in string_list(map_value(params, :tools)), do: {:deny, "Tool is blocked by policy"}, else: :abstain

      _other ->
        :abstain
    end
  end

  defp ask_verdict(:allow, policy, reason, event), do: {:ask, ask_payload(policy, reason, event)}
  defp ask_verdict({:ask, _payload} = verdict, _policy, _reason, _event), do: verdict

  defp resolve_ask({:ask, payload}, event) do
    escalation = write_escalation(event.session, payload)
    request = Map.put(payload, "escalation", escalation)

    emit(event.session, :approval_requested, %{
      "reason" => "policy_ask",
      "tool_name" => event.target,
      "approval_state" => "requested",
      "escalation" => escalation
    })

    case approval_response(event.session, request) do
      :approved ->
        emit(event.session, :approval_resolved, %{
          "reason" => "policy_ask",
          "tool_name" => event.target,
          "decision" => "approved",
          "approval_state" => "approved",
          "escalation" => escalation
        })

        :allow

      :denied ->
        emit(event.session, :approval_resolved, %{
          "reason" => "policy_ask",
          "tool_name" => event.target,
          "decision" => "denied",
          "approval_state" => "denied",
          "escalation" => escalation
        })

        {:deny, Map.merge(payload, %{"approval_state" => "denied", "escalation" => escalation})}

      :pending ->
        {:ask, Map.merge(payload, %{"approval_state" => "requested", "escalation" => escalation})}
    end
  end

  defp resolve_ask(verdict, _event), do: verdict

  defp approval_response(session, request) do
    case first_present(session, [:policy_approval_callback, "policy_approval_callback"]) do
      callback when is_function(callback, 1) ->
        case callback.(request) do
          :approved -> :approved
          {:ok, :approved} -> :approved
          "approved" -> :approved
          :allow -> :approved
          "allow" -> :approved
          :denied -> :denied
          {:ok, :denied} -> :denied
          {:error, :denied} -> :denied
          "denied" -> :denied
          :deny -> :denied
          "deny" -> :denied
          _other -> :pending
        end

      _ ->
        :pending
    end
  end

  defp write_escalation(session, payload) do
    cond do
      writer = first_present(session, [:policy_escalation_writer, "policy_escalation_writer"]) ->
        writer.(payload)

      client = first_present(session, [:postgrest_client, "postgrest_client"]) ->
        insert_escalation(client, payload)

      true ->
        payload
    end
  rescue
    error ->
      Logger.warning("policy_escalation_write_failed reason=#{Exception.message(error)}")
      payload
  catch
    kind, reason ->
      Logger.warning("policy_escalation_write_failed reason=#{inspect({kind, reason})}")
      payload
  end

  defp insert_escalation(%PostgRESTClient{} = client, payload) do
    case PostgRESTClient.post(client, @escalation_table, escalation_row(payload),
           prefer: "return=representation",
           query: %{"select" => "*"},
           log_metadata: %{caller: "policy_gate.write_escalation"}
         ) do
      {:ok, [row | _]} when is_map(row) -> row
      {:ok, row} when is_map(row) -> row
      {:ok, _body} -> payload
      {:error, reason} -> Map.put(payload, "escalation_error", inspect(reason))
    end
  end

  defp insert_escalation(_client, payload), do: payload

  defp escalation_row(payload) do
    %{
      "workspace_id" => payload["workspace_id"],
      "work_item_id" => payload["work_item_id"],
      "triggered_by" => "system",
      "trigger_kind" => "gate_failure",
      "reason_kind" => "policy_ask",
      "payload" => payload
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp ask_payload(policy, reason, event) do
    base_payload(policy, reason, event)
    |> Map.put("verdict", "ask")
    |> Map.put("approval_state", "requested")
  end

  defp deny_payload(policy, reason, event) do
    base_payload(policy, reason, event)
    |> Map.put("verdict", "deny")
  end

  defp base_payload(policy, reason, event) do
    %{
      "reason" => reason,
      "policy_id" => map_value(policy, :id),
      "policy_kind" => string_value(map_value(policy, :kind)),
      "policy_scope" => string_value(map_value(policy, :scope)),
      "tool_name" => event.target,
      "arguments" => event.data,
      "workspace_id" => session_value(event.session, :workspace_id),
      "agent_id" => session_value(event.session, :agent_id),
      "session_thread_id" => session_value(event.session, :session_id),
      "run_id" => session_value(event.session, :run_id),
      "work_item_id" => session_value(event.session, :work_item_id),
      "question" => "Approve policy-gated tool call #{event.target}?",
      "context_summary" => reason,
      "candidate_options" => [
        %{"id" => "approve", "label" => "Approve"},
        %{"id" => "deny", "label" => "Deny"}
      ]
    }
    |> Enum.reject(fn {_key, value} -> value in [nil, ""] end)
    |> Map.new()
  end

  defp shell_tool?(target) when is_binary(target) do
    MapSet.member?(@shell_tools, target) or String.ends_with?(target, ".shell")
  end

  defp string_list(values) when is_list(values), do: Enum.filter(values, &is_binary/1)
  defp string_list(_values), do: []

  defp emit(%{on_message: on_message}, event, payload) when is_function(on_message, 1) do
    on_message.(%{event: event, payload: payload})
  end

  defp emit(_session, _event, _payload), do: :ok

  defp session_value(session, key) do
    metadata = map_value(session, :metadata) || %{}
    map_value(session, key) || map_value(metadata, key)
  end

  defp first_present(map, keys) when is_map(map) do
    Enum.find_value(keys, fn key ->
      case Map.fetch(map, key) do
        {:ok, value} when value not in [nil, ""] -> value
        _ -> nil
      end
    end)
  end

  defp first_present(_map, _keys), do: nil

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(_map, _key), do: nil

  defp string_value(value) when is_atom(value), do: Atom.to_string(value)
  defp string_value(value) when is_binary(value), do: value
  defp string_value(_value), do: nil
end
