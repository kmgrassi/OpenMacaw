defmodule SymphonyElixir.AgentRunner do
  @moduledoc """
  Executes a single work item using the resolved runner backend.

  Routes work items to the appropriate runner (Codex, OpenClaw, ComputerUse, etc.)
  based on labels or config defaults, then manages the multi-turn session lifecycle.

  Execution history is persisted to Supabase via `SymphonyElixir.BrokerLog` when
  Supabase credentials and the `stored_agent` identity are configured. Without
  them, the broker writes no-op silently so local development is unaffected.
  """

  require Logger

  alias SymphonyElixir.{
    BrokerLogAdapter,
    AgentInventory,
    Config,
    ExecutionProfile,
    PromptBuilder,
    RuntimeLog,
    Tracker,
    WorkItem,
    Workspace
  }

  alias SymphonyElixir.UsageExtraction.Accumulator

  @type worker_host :: String.t() | nil

  @spec run(map(), pid() | nil, keyword()) :: :ok | no_return()
  def run(issue, codex_update_recipient \\ nil, opts \\ []) do
    worker_host =
      selected_worker_host(Keyword.get(opts, :worker_host), Config.settings!().worker.ssh_hosts)

    trace_id = trace_id_for(issue, opts)
    opts = Keyword.put(opts, :trace_id, trace_id)

    Logger.info("Starting agent run for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)}")

    RuntimeLog.log(
      :info,
      :run_started,
      issue_log_fields(issue, %{trace_id: trace_id, worker_host: worker_host_for_log(worker_host)})
    )

    case run_on_worker_host(issue, codex_update_recipient, opts, worker_host) do
      :ok ->
        RuntimeLog.log(
          :info,
          :run_completed,
          issue_log_fields(issue, %{
            trace_id: trace_id,
            worker_host: worker_host_for_log(worker_host)
          })
        )

        :ok

      {:error, reason} ->
        Logger.error("Agent run failed for #{issue_context(issue)}: #{inspect(reason)}")

        RuntimeLog.log(
          :error,
          :run_failed,
          issue_log_fields(issue, %{
            trace_id: trace_id,
            worker_host: worker_host_for_log(worker_host),
            reason: inspect(reason)
          })
        )

        raise RuntimeError, "Agent run failed for #{issue_context(issue)}: #{inspect(reason)}"
    end
  end

  defp run_on_worker_host(issue, codex_update_recipient, opts, worker_host) do
    Logger.info("Starting worker attempt for #{issue_context(issue)} worker_host=#{worker_host_for_log(worker_host)}")

    with {:ok, profile} <- resolve_execution_profile(issue, opts),
         {:ok, runner} <- ExecutionProfile.runner_module(profile) do
      runner_config = build_runner_config(runner, worker_host, opts, profile)
      log_execution_profile(profile, issue, opts, worker_host)

      run_turns(runner, runner_config, issue, codex_update_recipient, opts, worker_host)
    end
  end

  defp run_turns(runner, runner_config, issue, codex_update_recipient, opts, worker_host) do
    run_ref = BrokerLogAdapter.begin_run(issue, opts, worker_host: worker_host)

    result =
      if runner.requires_workspace?() do
        with {:ok, workspace} <- Workspace.create_for_issue(issue, worker_host) do
          run_turns_with_workspace(
            runner,
            runner_config,
            workspace,
            issue,
            codex_update_recipient,
            opts,
            worker_host,
            run_ref
          )
        end
      else
        run_runner_turns(
          runner,
          runner_config,
          nil,
          issue,
          codex_update_recipient,
          opts,
          worker_host,
          run_ref
        )
      end

    BrokerLogAdapter.finalize(run_ref, result)
    result
  end

  defp run_turns_with_workspace(
         runner,
         runner_config,
         workspace,
         issue,
         codex_update_recipient,
         opts,
         worker_host,
         run_ref
       ) do
    send_worker_runtime_info(codex_update_recipient, issue, worker_host, workspace)
    BrokerLogAdapter.update_workspace(run_ref, workspace)

    try do
      with :ok <- Workspace.run_before_run_hook(workspace, issue, worker_host) do
        run_runner_turns(
          runner,
          runner_config,
          workspace,
          issue,
          codex_update_recipient,
          opts,
          worker_host,
          run_ref
        )
      end
    after
      Workspace.run_after_run_hook(workspace, issue, worker_host)
    end
  end

  defp resolve_execution_profile(issue, opts) do
    runner_config = runner_config_from_settings()

    if SymphonyElixir.Codex.ToolPolicy.planning?(Config.settings!().stored_agent.type) do
      {:ok,
       %{
         "role" => "planning",
         "runner_kind" => "planner",
         "provider" => nil,
         "model" => nil,
         "credential_ref" => nil,
         "tool_profile" => "planning",
         "source_metadata" => %{"source" => "stored_agent_type"}
       }}
    else
      ExecutionProfile.resolve_coding(issue, runner_config, opts)
    end
  end

  defp runner_config_from_settings do
    Config.runner_config()
  end

  @doc false
  @spec build_runner_config_for_test(module(), String.t() | nil, keyword()) :: map()
  def build_runner_config_for_test(runner, worker_host, opts \\ []) do
    build_runner_config(runner, worker_host, opts, Keyword.get(opts, :execution_profile))
  end

  defp build_runner_config(runner, worker_host, opts, profile) do
    runner_settings = runner_specific_settings(runner)
    runner_override = Keyword.get(opts, :runner_config_override, %{})

    runner_settings
    |> Map.merge(normalize_runner_config_override(runner_override))
    |> maybe_merge_execution_profile(profile)
    |> maybe_put_agent_context(runner, profile)
    |> Map.put(:worker_host, worker_host)
  end

  defp maybe_merge_execution_profile(config, profile) when is_map(profile) do
    config
    |> then(&ExecutionProfile.runner_config(profile, &1))
    |> Map.put("execution_profile", ExecutionProfile.sanitize(profile))
  end

  defp maybe_merge_execution_profile(config, _profile), do: config

  defp maybe_put_agent_context(config, runner, profile)
       when runner in [
              SymphonyElixir.Runner.LocalRelay,
              SymphonyElixir.Runner.LocalModelCoding,
              SymphonyElixir.Runner.LlmToolRunner
            ] and is_map(profile) do
    if has_agent_context?(config) do
      config
    else
      case agent_context(profile) do
        nil -> config
        context -> Map.put(config, "agent_context", context)
      end
    end
  end

  defp maybe_put_agent_context(config, _runner, _profile), do: config

  defp has_agent_context?(config) do
    Enum.any?(["agent_context", :agent_context, "agentContext", :agentContext], fn key ->
      case Map.get(config, key) do
        value when is_binary(value) -> String.trim(value) != ""
        _ -> false
      end
    end)
  end

  defp agent_context(profile) do
    with agent_id when is_binary(agent_id) and agent_id != "" <- Map.get(profile, "agent_id") || Map.get(profile, :agent_id),
         {:ok, agent} <- agent_inventory().get_agent(agent_id),
         context when is_binary(context) <- Map.get(agent, :context) || Map.get(agent, "context"),
         trimmed when trimmed != "" <- String.trim(context) do
      trimmed
    else
      _ -> nil
    end
  end

  defp agent_inventory do
    Application.get_env(:symphony_elixir, :agent_inventory_adapter, AgentInventory)
  end

  defp log_execution_profile(profile, issue, opts, worker_host) do
    profile_fields = ExecutionProfile.log_fields(profile)

    fields =
      issue_log_fields(
        issue,
        %{
          trace_id: trace_id_for(issue, opts),
          worker_host: worker_host_for_log(worker_host),
          profile_source: get_in(profile, ["source_metadata", "source"]),
          profile_fallback_used: get_in(profile, ["source_metadata", "fallback_used"])
        }
        |> Map.merge(profile_fields)
      )

    Logger.info(
      "Resolved execution profile for #{issue_context(issue)} runner=#{Map.get(profile_fields, :runner) || "n/a"} provider=#{Map.get(profile_fields, :provider) || "n/a"} model=#{Map.get(profile_fields, :model) || "n/a"}"
    )

    RuntimeLog.log(:info, :execution_profile_resolved, fields)
  end

  defp normalize_runner_config_override(override) when is_map(override), do: override
  defp normalize_runner_config_override(_override), do: %{}

  defp runner_specific_settings(SymphonyElixir.Runner.Codex) do
    %{}
  end

  defp runner_specific_settings(SymphonyElixir.Runner.Planner) do
    Config.runner_config() |> Map.get("planner", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.LlmToolRunner) do
    Config.runner_config() |> Map.get("manager", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.OpenClaw) do
    Config.runner_config() |> Map.get("openclaw", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.OpenClawWS) do
    Config.runner_config() |> Map.get("openclaw_ws", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.ComputerUse) do
    Config.runner_config() |> Map.get("computer_use", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.LocalRelay) do
    Config.runner_config() |> Map.get("local_relay", %{})
  end

  defp runner_specific_settings(SymphonyElixir.Runner.LocalModelCoding) do
    Config.runner_config() |> Map.get("local_model_coding", %{})
  end

  defp runner_specific_settings(_runner), do: %{}

  defp runner_message_handler(recipient, issue, accumulator) do
    fn message ->
      Accumulator.record_snapshot(accumulator, message)
      send_runner_update(recipient, issue, message)
    end
  end

  defp send_runner_update(recipient, issue, message) when is_pid(recipient) do
    issue_id = issue_id(issue)

    if is_binary(issue_id) do
      send(recipient, {:codex_worker_update, issue_id, message})
    end

    :ok
  end

  defp send_runner_update(_recipient, _issue, _message), do: :ok

  defp send_worker_runtime_info(recipient, issue, worker_host, workspace)
       when is_pid(recipient) and is_binary(workspace) do
    issue_id = issue_id(issue)

    if is_binary(issue_id) do
      send(
        recipient,
        {:worker_runtime_info, issue_id,
         %{
           worker_host: worker_host,
           workspace_path: workspace
         }}
      )
    end

    :ok
  end

  defp send_worker_runtime_info(_recipient, _issue, _worker_host, _workspace), do: :ok

  defp run_runner_turns(
         runner,
         runner_config,
         workspace,
         issue,
         codex_update_recipient,
         opts,
         _worker_host,
         run_ref
       ) do
    max_turns = Keyword.get(opts, :max_turns, Config.settings!().agent.max_turns)

    issue_state_fetcher =
      Keyword.get(opts, :issue_state_fetcher, &Tracker.fetch_issue_states_by_ids/1)

    accumulator = Accumulator.start()

    trace_id = trace_id_for(issue, opts)

    session_config =
      runner_config
      |> Map.put(:on_message, runner_message_handler(codex_update_recipient, issue, accumulator))
      |> Map.put(:trace_id, trace_id)

    try do
      with {:ok, session} <- runner.start_session(session_config, workspace) do
        session =
          session
          |> Map.put(
            :on_message,
            runner_message_handler(codex_update_recipient, issue, accumulator)
          )
          |> Map.put(:trace_id, trace_id)
          |> Map.put(:execution_profile, Map.get(runner_config, "execution_profile"))

        try do
          do_run_turns(
            runner,
            session,
            workspace,
            issue,
            codex_update_recipient,
            opts,
            issue_state_fetcher,
            1,
            max_turns,
            run_ref,
            accumulator
          )
        after
          runner.stop_session(session)
        end
      end
    after
      Accumulator.stop(accumulator)
    end
  end

  defp do_run_turns(
         runner,
         session,
         workspace,
         issue,
         codex_update_recipient,
         opts,
         issue_state_fetcher,
         turn_number,
         max_turns,
         run_ref,
         accumulator
       ) do
    prompt = build_turn_prompt(issue, opts, turn_number, max_turns)
    trace_id = Map.get(session, :trace_id) || trace_id_for(issue, opts)
    turn_id = turn_log_id(run_ref, issue, turn_number)

    turn_fields =
      issue_log_fields(issue, %{
        trace_id: trace_id,
        run_id: run_log_id(run_ref, issue),
        turn_id: turn_id,
        turn_number: turn_number,
        max_turns: max_turns,
        runner: inspect(runner)
      })
      |> Map.merge(ExecutionProfile.log_fields(Map.get(session, :execution_profile) || Map.get(session, "execution_profile")))

    RuntimeLog.log(:info, :turn_started, turn_fields)

    with {:ok, _turn_result} <- runner.run_turn(session, prompt, issue) do
      Logger.info("Completed agent run for #{issue_context(issue)} workspace=#{workspace} turn=#{turn_number}/#{max_turns}")

      RuntimeLog.log(:info, :turn_completed, turn_fields)

      BrokerLogAdapter.record_turn(run_ref, accumulator, turn_number)

      case continue_with_issue?(issue, issue_state_fetcher) do
        {:continue, refreshed_issue} when turn_number < max_turns ->
          Logger.info("Continuing agent run for #{issue_context(refreshed_issue)} after normal turn completion turn=#{turn_number}/#{max_turns}")

          do_run_turns(
            runner,
            session,
            workspace,
            refreshed_issue,
            codex_update_recipient,
            opts,
            issue_state_fetcher,
            turn_number + 1,
            max_turns,
            run_ref,
            accumulator
          )

        {:continue, refreshed_issue} ->
          Logger.info("Reached agent.max_turns for #{issue_context(refreshed_issue)} with issue still active; returning control to orchestrator")

          :ok

        {:done, _refreshed_issue} ->
          :ok

        {:error, reason} ->
          RuntimeLog.log(:error, :turn_failed, Map.put(turn_fields, :reason, inspect(reason)))
          {:error, reason}
      end
    else
      {:error, reason} = error ->
        RuntimeLog.log(:error, :turn_failed, Map.put(turn_fields, :reason, inspect(reason)))
        error
    end
  end

  defp build_turn_prompt(issue, opts, 1, _max_turns), do: PromptBuilder.build_prompt(issue, opts)

  defp build_turn_prompt(_issue, _opts, turn_number, max_turns) do
    """
    Continuation guidance:

    - The previous Codex turn completed normally, but the Linear issue is still in an active state.
    - This is continuation turn ##{turn_number} of #{max_turns} for the current agent run.
    - Resume from the current workspace and workpad state instead of restarting from scratch.
    - The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
    - Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
    """
  end

  defp continue_with_issue?(issue, issue_state_fetcher) do
    id = issue_id(issue)

    if is_binary(id) do
      case issue_state_fetcher.([id]) do
        {:ok, [refreshed | _]} ->
          if active_issue_state?(issue_state(refreshed)) do
            {:continue, refreshed}
          else
            {:done, refreshed}
          end

        {:ok, []} ->
          {:done, issue}

        {:error, reason} ->
          {:error, {:issue_state_refresh_failed, reason}}
      end
    else
      {:done, issue}
    end
  end

  defp active_issue_state?(state_name) when is_binary(state_name) do
    normalized_state = normalize_issue_state(state_name)

    Config.settings!().tracker.active_states
    |> Enum.any?(fn active_state -> normalize_issue_state(active_state) == normalized_state end)
  end

  defp active_issue_state?(_state_name), do: false

  defp selected_worker_host(nil, []), do: nil

  defp selected_worker_host(preferred_host, configured_hosts) when is_list(configured_hosts) do
    hosts =
      configured_hosts
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()

    case preferred_host do
      host when is_binary(host) and host != "" -> host
      _ when hosts == [] -> nil
      _ -> List.first(hosts)
    end
  end

  defp worker_host_for_log(nil), do: "local"
  defp worker_host_for_log(worker_host), do: worker_host

  defp normalize_issue_state(state_name) when is_binary(state_name) do
    state_name
    |> String.trim()
    |> String.downcase()
  end

  defp issue_id(%WorkItem{id: id}), do: id
  defp issue_id(%{id: id}), do: id
  defp issue_id(_), do: nil

  defp issue_state(%WorkItem{state: state}), do: state
  defp issue_state(%{state: state}), do: state
  defp issue_state(_), do: nil

  defp issue_context(%WorkItem{id: issue_id, identifier: identifier}) do
    "issue_id=#{issue_id} issue_identifier=#{identifier}"
  end

  defp issue_context(%{id: id}) do
    "issue_id=#{id}"
  end

  defp trace_id_for(issue, opts) do
    RuntimeLog.ensure_trace_id(
      Keyword.get(opts, :trace_id) ||
        issue_metadata_value(issue, "trace_id") ||
        issue_metadata_value(issue, :trace_id)
    )
  end

  defp issue_log_fields(issue, extra) do
    %{
      trace_id: Map.get(extra, :trace_id),
      run_id: Map.get(extra, :run_id) || issue_id(issue),
      agent_id: issue_metadata_value(issue, "agent_id") || issue_metadata_value(issue, :agent_id),
      workspace_id: issue_metadata_value(issue, "workspace_id") || issue_metadata_value(issue, :workspace_id),
      issue_id: issue_id(issue),
      issue_identifier: issue_identifier(issue)
    }
    |> Map.merge(extra)
  end

  defp issue_identifier(%WorkItem{identifier: identifier}), do: identifier
  defp issue_identifier(%{identifier: identifier}), do: identifier
  defp issue_identifier(_), do: nil

  defp issue_metadata_value(%WorkItem{metadata: metadata}, key), do: metadata_value(metadata, key)
  defp issue_metadata_value(%{metadata: metadata}, key), do: metadata_value(metadata, key)
  defp issue_metadata_value(issue, key) when is_map(issue), do: metadata_value(issue, key)
  defp issue_metadata_value(_issue, _key), do: nil

  defp metadata_value(metadata, key) when is_map(metadata), do: Map.get(metadata, key)
  defp metadata_value(_metadata, _key), do: nil

  defp run_log_id(run_ref, _issue) when is_binary(run_ref), do: run_ref
  defp run_log_id(_run_ref, issue), do: issue_id(issue)

  defp turn_log_id(run_ref, issue, turn_number),
    do: "#{run_log_id(run_ref, issue) || "run"}:turn:#{turn_number}"
end
