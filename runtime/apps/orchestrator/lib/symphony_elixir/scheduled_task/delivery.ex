defmodule SymphonyElixir.ScheduledTask.Delivery do
  @moduledoc """
  Delivers claimed scheduled-task occurrences. Dispatches by
  `delivery.kind`:

    * `scheduled_agent_message` — the existing path: post the row's
      `instructions` through `ChatGateway` to drive an agent run.
  Unknown kinds return `{:error, :unsupported_delivery_kind}` so the
  scheduler marks the run as failed and logs the warning rather than
  silently dropping the row (matches the existing `validate_delivery/1`
  failure idiom; failing the run is the loud-failure signal in this
  codebase, since the scheduler's `finish_failure/6` path logs at warn
  level and persists the error string).
  """

  alias SymphonyElixir.MapUtils

  @agent_message_kind "scheduled_agent_message"

  @known_kinds [@agent_message_kind]

  @spec deliver(map(), map(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def deliver(task, run, opts \\ []) when is_map(task) and is_map(run) do
    case delivery_kind(task) do
      kind when kind == @agent_message_kind ->
        deliver_agent_message(task, run, opts)

      _ ->
        {:error, :unsupported_delivery_kind}
    end
  end

  def delivery_kind, do: @agent_message_kind
  def known_kinds, do: @known_kinds

  def validate_delivery(task) do
    case delivery_kind(task) do
      kind when kind in @known_kinds -> :ok
      _ -> {:error, :unsupported_delivery_kind}
    end
  end

  defp deliver_agent_message(task, run, opts) do
    alias SymphonyElixir.ChatGateway

    with {:ok, workspace_id} <- workspace_id(task, opts),
         {:ok, agent_id} <- required_string(task, "agent_id"),
         {:ok, base_instructions} <- required_string(task, "instructions"),
         {:ok, scheduled_task_id} <- required_string(task, "id"),
         {:ok, scheduled_task_run_id} <- required_string(run, "id"),
         {:ok, instructions, delivery_metadata} <-
           instructions_with_delivery_context(base_instructions, task, workspace_id, opts) do
      run_id = scheduled_task_run_id
      scheduled_for = string_value(run, "scheduled_for") || string_value(task, "next_run_at")
      source_work_item_id = string_value(task, "source_work_item_id")

      scope = %{
        agent_id: agent_id,
        workspace_id: workspace_id,
        user_id: string_value(task, "created_by_user_id"),
        session_key: "agent:#{agent_id}:scheduled",
        history_window: 0
      }

      metadata =
        delivery_metadata
        |> Map.merge(%{
          "source" => "scheduled_task",
          "kind" => @agent_message_kind,
          "scheduled_task_id" => scheduled_task_id,
          "scheduled_task_run_id" => scheduled_task_run_id,
          "scheduled_for" => scheduled_for
        })
        |> MapUtils.put_present("source_work_item_id", source_work_item_id)

      chat_gateway = Keyword.get(opts, :chat_gateway, ChatGateway)

      chat_gateway.post_message(scope, instructions,
        await?: Keyword.get(opts, :await?, true),
        run_id: run_id,
        metadata: metadata,
        trace_id: Keyword.get(opts, :trace_id)
      )
    end
  end

  defp delivery_kind(task) do
    case Map.get(task, "delivery") || Map.get(task, :delivery) do
      %{"kind" => kind} when is_binary(kind) -> kind
      %{kind: kind} when is_binary(kind) -> kind
      _ -> nil
    end
  end

  defp instructions_with_delivery_context(instructions, task, workspace_id, opts) do
    delivery_metadata = delivery_metadata(task)

    case get_in(delivery_metadata, ["sampling", "strategy"]) do
      "random_recent_run" ->
        append_learning_sample(
          instructions,
          workspace_id,
          delivery_metadata["sampling"],
          delivery_metadata,
          opts
        )

      _ ->
        {:ok, instructions, delivery_metadata}
    end
  end

  defp append_learning_sample(instructions, workspace_id, sampling, delivery_metadata, opts) do
    sampler = Keyword.get(opts, :learning_sampler, SymphonyElixir.ScheduledTask.LearningSampler)

    case sampler.sample(workspace_id, sampling || %{}, opts) do
      {:ok, nil} ->
        {:ok,
         instructions <>
           "\n\nNo recent transcript sample was available. Report that no sample was available and take no further action.",
         Map.put(delivery_metadata, "sample", %{"status" => "unavailable"})}

      {:ok, sample} when is_map(sample) ->
        {:ok,
         instructions <>
           "\n\nTranscript sample for this scheduled learning review:\n```json\n" <>
           Jason.encode!(sample) <> "\n```",
         Map.put(delivery_metadata, "sample", %{
           "status" => "attached",
           "group" => Map.get(sample, "group")
         })}

      {:error, reason} ->
        {:error, {:learning_sample_failed, reason}}
    end
  end

  defp delivery_metadata(task) do
    case Map.get(task, "delivery") || Map.get(task, :delivery) do
      %{"metadata" => metadata} when is_map(metadata) -> metadata
      %{metadata: metadata} when is_map(metadata) -> stringify_keys(metadata)
      _ -> %{}
    end
  end

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), stringify_value(value)}
      {key, value} -> {key, stringify_value(value)}
    end)
  end

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value), do: value

  defp workspace_id(task, opts) do
    case string_value(task, "workspace_id") do
      value when is_binary(value) and value != "" ->
        {:ok, value}

      _ ->
        repository = Keyword.fetch!(opts, :repository)

        with {:ok, agent_id} <- required_string(task, "agent_id") do
          repository.agent_workspace_id(agent_id, opts)
        end
    end
  end

  defp required_string(map, key) do
    case string_value(map, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, {:missing_field, key}}
    end
  end

  defp string_value(map, key), do: MapUtils.atom_or_string_get(map, key)
end
