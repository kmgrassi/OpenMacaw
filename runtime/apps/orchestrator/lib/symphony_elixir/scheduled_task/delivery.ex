defmodule SymphonyElixir.ScheduledTask.Delivery do
  @moduledoc """
  Delivers claimed scheduled-task occurrences. Dispatches by
  `delivery.kind`:

    * `scheduled_agent_message` — the existing path: post the row's
      `instructions` through `ChatGateway` to drive an agent run.
    * `learning_reflection`, `learning_distillation` — learning sidecar
      jobs. The runtime is *transport* for these; the platform owns
      execution. We POST the task payload to the platform's learning
      handler and let it run the LLM call / clustering / writes.

  Unknown kinds return `{:error, :unsupported_delivery_kind}` so the
  scheduler marks the run as failed and logs the warning rather than
  silently dropping the row (matches the existing `validate_delivery/1`
  failure idiom; failing the run is the loud-failure signal in this
  codebase, since the scheduler's `finish_failure/6` path logs at warn
  level and persists the error string).
  """

  alias SymphonyElixir.{MapUtils, PlatformLearningClient}

  @agent_message_kind "scheduled_agent_message"
  @learning_reflection_kind "learning_reflection"
  @learning_distillation_kind "learning_distillation"

  @known_kinds [
    @agent_message_kind,
    @learning_reflection_kind,
    @learning_distillation_kind
  ]

  @learning_kinds [@learning_reflection_kind, @learning_distillation_kind]

  @spec deliver(map(), map(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def deliver(task, run, opts \\ []) when is_map(task) and is_map(run) do
    case delivery_kind(task) do
      kind when kind == @agent_message_kind ->
        deliver_agent_message(task, run, opts)

      kind when kind in @learning_kinds ->
        deliver_learning_job(task, run, kind, opts)

      _ ->
        {:error, :unsupported_delivery_kind}
    end
  end

  def delivery_kind, do: @agent_message_kind
  def learning_reflection_kind, do: @learning_reflection_kind
  def learning_distillation_kind, do: @learning_distillation_kind
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
         {:ok, instructions} <- required_string(task, "instructions"),
         {:ok, scheduled_task_id} <- required_string(task, "id"),
         {:ok, scheduled_task_run_id} <- required_string(run, "id") do
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
        %{
          "source" => "scheduled_task",
          "kind" => @agent_message_kind,
          "scheduled_task_id" => scheduled_task_id,
          "scheduled_task_run_id" => scheduled_task_run_id,
          "scheduled_for" => scheduled_for
        }
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

  defp deliver_learning_job(task, run, kind, opts) do
    # Workspace id is required so the platform handler knows which
    # workspace's memory store / settings apply. Agent id is required
    # for reflection (the source agent run); distillation rows are
    # workspace-scoped but we still carry agent_id when present for
    # symmetry with the existing payload shape.
    with {:ok, workspace_id} <- workspace_id(task, opts),
         {:ok, scheduled_task_id} <- required_string(task, "id"),
         {:ok, scheduled_task_run_id} <- required_string(run, "id") do
      run_id = scheduled_task_run_id
      delivery = delivery_map(task)

      payload =
        %{
          "kind" => kind,
          "scheduled_task_id" => scheduled_task_id,
          "scheduled_task_run_id" => scheduled_task_run_id,
          "scheduled_run_id" => run_id,
          "workspace_id" => workspace_id,
          "agent_id" => string_value(task, "agent_id"),
          "source_work_item_id" => string_value(task, "source_work_item_id"),
          "scheduled_for" => string_value(run, "scheduled_for") || string_value(task, "next_run_at"),
          "delivery" => delivery,
          "trace_id" => Keyword.get(opts, :trace_id)
        }
        |> MapUtils.drop_nil_values()

      client = Keyword.get(opts, :platform_learning_client, PlatformLearningClient)

      case client.post_job(kind, payload, opts) do
        {:ok, _response} -> {:ok, run_id}
        {:error, reason} -> {:error, {:platform_learning_handler_failed, reason}}
      end
    end
  end

  defp delivery_kind(task) do
    case Map.get(task, "delivery") || Map.get(task, :delivery) do
      %{"kind" => kind} when is_binary(kind) -> kind
      %{kind: kind} when is_binary(kind) -> kind
      _ -> nil
    end
  end

  defp delivery_map(task) do
    case Map.get(task, "delivery") || Map.get(task, :delivery) do
      delivery when is_map(delivery) -> delivery
      _ -> %{}
    end
  end

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
