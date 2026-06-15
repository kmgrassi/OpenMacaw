defmodule SymphonyElixir.Learning.ReflectionDispatcher do
  @moduledoc """
  After every completed agent run, enqueue a `learning_reflection`
  scheduled-task row so the platform-side reflector can summarise the
  transcript into `memory_items` rows.

  Implements PR B1 of the learning sidecar — see
  `docs/learning-sidecar-runtime-scope.md` and the canonical plan in
  `parallel-agent-platform/docs/active/learning-sidecar-pr-plan.md`.

  ## Design

  Called from the two session-completion sites after
  `record_assistant_message` returns:

    * `SymphonyElixir.ChatGateway.complete_run/5` (private; server-
      initiated runs)
    * `SymphonyElixir.OrchestratorWeb.GatewaySocket.handle_runner_complete/3`
      (WebSocket-driven sessions)

  Both have `scope` (workspace_id + agent_id), `run_id`, and have just
  finished persisting the assistant message to the platform's message
  store. The dispatcher's job is to insert one `scheduled_task` row
  with `delivery.kind = "learning_reflection"` so the existing
  scheduler picks it up on the next tick and `Delivery.deliver/3`
  routes it to the platform handler.

  ## Payload shape

  The row is intentionally one-shot: `schedule: %{"kind" => "at", "runAt" => <now>}`
  produces `{:ok, nil}` from `NextRun.next_after/3`, so the scheduler
  marks `next_run_at = nil` after the first dispatch and the row stops
  firing. The delivery sub-object carries only identifiers — the
  platform reflector reads the transcript from the persisted
  message-history (the same one any other platform-side transcript
  consumer uses) rather than receiving it inline.

  ## Best-effort semantics

  This must never fail the run. Both the workspace-flag read and the
  insert are wrapped: an exception during enqueue is caught, logged,
  and swallowed. A failed insert returns `{:error, _}` from the
  repository and is logged but not re-raised. The agent's
  run-completion path proceeds regardless.

  ## Gating: per-workspace `learning_enabled` (no env flag)

  Gated solely on `workspace_settings.learning_enabled` for the
  workspace. The platform exposes the toggle in Settings → Workspace.

  Default-off, opt-in: when no `workspace_settings` row exists for a
  workspace, the repository falls back to `false` (matching the DB
  column default and the platform service's `projectSettings`
  fallback). Memory persistence is dark-launched and must be enabled
  explicitly per workspace.

  Fail-open on transient errors: when the repository returns
  `{:error, _}` (Supabase unreachable, schema not yet ready, etc.),
  the dispatcher logs a warning and proceeds with the enqueue. The
  scheduled-task scheduler picks the row up on the next tick; if the
  workspace had actually opted out, the platform-side handler will
  re-check the flag and discard. Fail-open prevents a brief Supabase
  blip from silently disabling memory for already-enabled workspaces.

  No `LEARNING_REFLECTION_ENABLED` env flag any more — single
  source-of-truth gate in the DB. To roll back globally in an
  emergency, set `workspace_settings.learning_enabled = false` for the
  affected workspaces (or all of them with one UPDATE).
  """

  require Logger

  alias SymphonyElixir.ScheduledTask.Repository
  alias SymphonyElixir.WorkspaceSettings.Repository, as: WorkspaceSettings

  @delivery_kind "learning_reflection"

  @doc """
  Best-effort enqueue of a `learning_reflection` row for the given run.

  Returns `:ok` in every case — failures are logged but never
  propagated. Callers should treat this as fire-and-forget.

  ## Opts

    * `:source_work_item_id` — UUID of the originating work_item, if
      the run came from one (carried through to the reflector for
      audit + future cross-task memory linking).
    * `:repository` — `ScheduledTask.Repository` module override for
      tests. Defaults to `SymphonyElixir.ScheduledTask.Repository`.
    * `:repository_opts` — passed through to the repository call.
    * `:workspace_settings` — `WorkspaceSettings.Repository` module
      override for tests. Defaults to
      `SymphonyElixir.WorkspaceSettings.Repository`.
    * `:workspace_settings_opts` — passed through to the workspace-
      settings read.
    * `:now` — `DateTime.t()` override for tests. Defaults to
      `DateTime.utc_now/0`.
  """
  @spec maybe_enqueue(map(), String.t(), keyword()) :: :ok
  def maybe_enqueue(scope, run_id, opts \\ []) when is_map(scope) and is_binary(run_id) do
    workspace_id = scope_value(scope, :workspace_id)

    cond do
      not is_binary(workspace_id) or workspace_id == "" ->
        Logger.warning("learning_reflection_enqueue_skipped",
          reason: ":missing_workspace_id",
          run_id: run_id,
          agent_id: Map.get(scope, :agent_id)
        )

        :ok

      workspace_learning_enabled?(workspace_id, scope, run_id, opts) ->
        try_enqueue(scope, run_id, opts)

      true ->
        :ok
    end
  rescue
    error ->
      Logger.warning("learning_reflection_enqueue_raised",
        error: inspect(error),
        run_id: run_id,
        agent_id: Map.get(scope, :agent_id),
        workspace_id: Map.get(scope, :workspace_id)
      )

      :ok
  end

  # Workspace gate. Returns true when:
  #   - the row says `learning_enabled = true`
  #   - OR the read fails entirely (fail-open with a warning log)
  # Returns false only when the row explicitly says `learning_enabled = false`.
  defp workspace_learning_enabled?(workspace_id, scope, run_id, opts) do
    repository = Keyword.get(opts, :workspace_settings, WorkspaceSettings)
    repository_opts = Keyword.get(opts, :workspace_settings_opts, [])

    case repository.learning_enabled?(workspace_id, repository_opts) do
      {:ok, value} when is_boolean(value) ->
        value

      {:error, reason} ->
        Logger.warning("learning_reflection_workspace_setting_read_failed",
          reason: inspect(reason),
          run_id: run_id,
          agent_id: Map.get(scope, :agent_id),
          workspace_id: workspace_id,
          fail_open: true
        )

        true
    end
  end

  defp try_enqueue(scope, run_id, opts) do
    case build_payload(scope, run_id, opts) do
      {:ok, payload} ->
        repository = Keyword.get(opts, :repository, Repository)
        repository_opts = Keyword.get(opts, :repository_opts, [])

        case repository.create_task(payload, repository_opts) do
          {:ok, _row} ->
            :ok

          {:error, reason} ->
            Logger.warning("learning_reflection_enqueue_failed",
              reason: inspect(reason),
              run_id: run_id,
              agent_id: Map.get(scope, :agent_id),
              workspace_id: Map.get(scope, :workspace_id)
            )

            :ok
        end

      {:error, reason} ->
        Logger.warning("learning_reflection_enqueue_skipped",
          reason: inspect(reason),
          run_id: run_id,
          agent_id: Map.get(scope, :agent_id),
          workspace_id: Map.get(scope, :workspace_id)
        )

        :ok
    end
  end

  defp build_payload(scope, run_id, opts) do
    workspace_id = scope_value(scope, :workspace_id)
    agent_id = scope_value(scope, :agent_id)

    cond do
      not is_binary(workspace_id) or workspace_id == "" ->
        {:error, :missing_workspace_id}

      not is_binary(agent_id) or agent_id == "" ->
        {:error, :missing_agent_id}

      true ->
        now = Keyword.get(opts, :now, DateTime.utc_now())
        now_iso = DateTime.to_iso8601(now)
        source_work_item_id = Keyword.get(opts, :source_work_item_id)

        delivery =
          %{
            "kind" => @delivery_kind,
            "sourceRunId" => run_id
          }
          |> maybe_put("sourceTaskId", source_work_item_id)

        {:ok,
         %{
           "workspace_id" => workspace_id,
           "agent_id" => agent_id,
           "title" => "Learning reflection",
           "instructions" =>
             "Reflect on the completed agent run and extract durable workspace memory.",
           "enabled" => true,
           "schedule" => %{"kind" => "at", "runAt" => now_iso},
           "timezone" => "Etc/UTC",
           "next_run_at" => now_iso,
           "delivery" => delivery,
           "metadata" => %{},
           "source_work_item_id" => source_work_item_id
         }
         |> drop_nil_values()}
    end
  end

  defp scope_value(scope, key) do
    Map.get(scope, key) || Map.get(scope, Atom.to_string(key))
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp drop_nil_values(map) do
    Enum.reduce(map, %{}, fn
      {_k, nil}, acc -> acc
      {k, v}, acc -> Map.put(acc, k, v)
    end)
  end
end
