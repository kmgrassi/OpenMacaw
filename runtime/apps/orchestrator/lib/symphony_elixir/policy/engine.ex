defmodule SymphonyElixir.Policy.Engine do
  @moduledoc """
  Stateful evaluator for per-session runtime policies.
  """

  use GenServer

  alias SymphonyElixir.Policy.{Policy, StateStore}

  @type verdict :: :allow | {:deny, String.t()} | {:ask, String.t()}
  @type event :: map()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, Keyword.put_new(opts, :name, __MODULE__))
  end

  @spec evaluate(event(), keyword()) :: verdict()
  def evaluate(event, opts \\ []) when is_map(event) and is_list(opts) do
    server = Keyword.get(opts, :server, __MODULE__)

    if Process.whereis(server) do
      GenServer.call(server, {:evaluate, event, opts})
    else
      evaluate_stateless(event, opts)
    end
  end

  @spec reset!(keyword()) :: :ok
  def reset!(opts \\ []) do
    server = Keyword.get(opts, :server, __MODULE__)

    if Process.whereis(server) do
      GenServer.call(server, :reset)
    else
      :ok
    end
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:reset, _from, _state), do: {:reply, :ok, %{}}

  def handle_call({:evaluate, event, opts}, _from, state) do
    session_thread_id = session_thread_id(event)
    workspace_id = workspace_id(event)
    state_key = state_key(session_thread_id)
    client = postgrest_client(event, opts)

    {session_state, state} =
      Map.get_and_update(state, state_key, fn
        nil ->
          hydrated = StateStore.hydrate(client, session_thread_id)
          {hydrated, hydrated}

        existing ->
          {existing, existing}
      end)

    {verdict, next_session_state, writes} = evaluate_with_state(event, session_state || %{})

    Enum.each(writes, fn {key, value} ->
      StateStore.write(client, workspace_id, session_thread_id, key, value)
    end)

    {:reply, verdict, Map.put(state, state_key, next_session_state)}
  end

  @spec evaluate_stateless(event(), keyword()) :: verdict()
  def evaluate_stateless(event, opts \\ []) when is_map(event) and is_list(opts) do
    client = postgrest_client(event, opts)
    session_thread_id = session_thread_id(event)
    session_state = StateStore.hydrate(client, session_thread_id)
    workspace_id = workspace_id(event)

    {verdict, _next_session_state, writes} = evaluate_with_state(event, session_state)

    Enum.each(writes, fn {key, value} ->
      StateStore.write(client, workspace_id, session_thread_id, key, value)
    end)

    verdict
  end

  @spec evaluate_with_state(event(), map()) :: {verdict(), map(), [{String.t(), term()}]}
  def evaluate_with_state(event, session_state) when is_map(event) and is_map(session_state) do
    policies = event |> policies() |> Policy.normalize_many()

    if policies == [] do
      {:allow, session_state, []}
    else
      case reduce_policies(policies, event, session_state, :allow) do
        {:deny, reason} ->
          {{:deny, reason}, session_state, []}

        {:ask, reason} ->
          {{:ask, reason}, session_state, []}

        :allow ->
          apply_tool_call_increment(event, session_state)
      end
    end
  end

  defp reduce_policies(policies, event, session_state, verdict) do
    Enum.reduce_while(policies, verdict, fn policy, acc ->
      case evaluate_policy(policy, event, session_state) do
        {:deny, reason} -> {:halt, {:deny, reason}}
        {:ask, reason} -> {:cont, ask_verdict(acc, reason)}
        :abstain -> {:cont, acc}
      end
    end)
  end

  defp evaluate_policy(%{kind: "block_tools", params: params}, %{type: :tool_call} = event, _state) do
    tools = params |> map_value(:tools) |> List.wrap()
    target = tool_target(event)

    if target in tools do
      {:deny, "Tool #{inspect(target)} is blocked by policy."}
    else
      :abstain
    end
  end

  defp evaluate_policy(%{kind: "max_tool_calls_per_session", params: params}, %{type: :tool_call}, state) do
    limit = positive_integer(map_value(params, :limit))
    count = numeric(Map.get(state, StateStore.tool_call_count_key()), 0)

    cond do
      is_nil(limit) -> :abstain
      count >= limit -> {:deny, "Session tool-call limit of #{limit} has been reached."}
      true -> :abstain
    end
  end

  defp evaluate_policy(%{kind: "ask_on_tool", params: params}, %{type: :tool_call} = event, _state) do
    tools = params |> map_value(:tools) |> List.wrap()
    target = tool_target(event)

    if target in tools do
      {:ask, "Tool #{inspect(target)} requires approval by policy."}
    else
      :abstain
    end
  end

  defp evaluate_policy(_policy, _event, _state), do: :abstain

  defp apply_tool_call_increment(%{type: :tool_call}, state) do
    key = StateStore.tool_call_count_key()
    next_count = numeric(Map.get(state, key), 0) + 1
    next_state = Map.put(state, key, next_count)

    {:allow, next_state, [{key, next_count}]}
  end

  defp apply_tool_call_increment(_event, state), do: {:allow, state, []}

  defp ask_verdict(:allow, reason), do: {:ask, reason}
  defp ask_verdict({:ask, _existing_reason} = verdict, _new_reason), do: verdict

  defp policies(event) do
    session = map_value(event, :session) || %{}

    map_value(event, :policies) ||
      map_value(session, :policies) ||
      map_value(session, :session_policies) ||
      get_in(map_value(session, :metadata) || %{}, [:policies]) ||
      get_in(map_value(session, :metadata) || %{}, ["policies"]) ||
      get_in(map_value(session, :dispatch_frame) || %{}, ["policies"]) ||
      []
  end

  defp postgrest_client(event, opts) do
    Keyword.get(opts, :postgrest_client) || map_value(event, :postgrest_client) || session_postgrest_client(event)
  end

  defp session_postgrest_client(event) do
    event
    |> map_value(:session)
    |> case do
      session when is_map(session) -> map_value(session, :postgrest_client)
      _ -> nil
    end
  end

  defp session_thread_id(event) do
    session = map_value(event, :session) || %{}
    metadata = map_value(session, :metadata) || %{}
    frame = map_value(session, :dispatch_frame) || %{}

    map_value(event, :session_thread_id) ||
      map_value(session, :session_thread_id) ||
      map_value(metadata, :session_thread_id) ||
      map_value(frame, :session_thread_id)
  end

  defp workspace_id(event) do
    session = map_value(event, :session) || %{}
    metadata = map_value(session, :metadata) || %{}
    frame = map_value(session, :dispatch_frame) || %{}

    map_value(event, :workspace_id) ||
      map_value(session, :workspace_id) ||
      map_value(metadata, :workspace_id) ||
      map_value(frame, :workspace_id)
  end

  defp tool_target(event), do: map_value(event, :target) || map_value(event, :tool_name)
  defp state_key(nil), do: {:process, self()}
  defp state_key(""), do: {:process, self()}
  defp state_key(session_thread_id), do: {:session_thread_id, session_thread_id}

  defp positive_integer(value) when is_integer(value) and value > 0, do: value

  defp positive_integer(value) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> nil
    end
  end

  defp positive_integer(_value), do: nil

  defp numeric(value, _default) when is_integer(value) or is_float(value), do: value

  defp numeric(value, default) when is_binary(value) do
    case Float.parse(value) do
      {number, ""} -> number
      _ -> default
    end
  end

  defp numeric(_value, default), do: default

  defp map_value(map, key) when is_map(map) do
    cond do
      Map.has_key?(map, key) -> Map.get(map, key)
      Map.has_key?(map, to_string(key)) -> Map.get(map, to_string(key))
      true -> nil
    end
  end

  defp map_value(_map, _key), do: nil
end
