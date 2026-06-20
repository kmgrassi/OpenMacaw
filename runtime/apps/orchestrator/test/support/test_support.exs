defmodule SymphonyElixir.TestSupport do
  @workflow_prompt "You are an agent for this repository."

  defmacro __using__(opts) do
    quote do
      use ExUnit.Case, unquote(opts)
      import ExUnit.CaptureLog

      alias SymphonyElixir.AgentRunner
      alias SymphonyElixir.CLI
      alias SymphonyElixir.Codex.AppServer
      alias SymphonyElixir.Config
      alias SymphonyElixir.HttpServer
      alias SymphonyElixir.Linear.Client
      alias SymphonyElixir.WorkItem
      alias SymphonyElixir.Orchestrator
      alias SymphonyElixir.PromptBuilder
      alias SymphonyElixir.StatusDashboard
      alias SymphonyElixir.Tracker
      alias SymphonyElixir.Workflow
      alias SymphonyElixir.WorkflowStore
      alias SymphonyElixir.Workspace

      import SymphonyElixir.TestSupport,
        only: [
          write_workflow_file!: 1,
          write_workflow_file!: 2,
          restore_env: 2,
          put_system_env: 2,
          put_system_envs: 1,
          delete_system_env: 1,
          delete_system_envs: 1,
          put_app_env: 3,
          put_app_envs: 2,
          delete_app_env: 2,
          delete_app_envs: 2,
          tmp_dir!: 1,
          stop_default_http_server: 0
        ]

      setup do
        {:ok, _started} = Application.ensure_all_started(:symphony_elixir)

        workflow_root = tmp_dir!("symphony-elixir-workflow")
        workflow_file = Path.join(workflow_root, "WORKFLOW.md")
        write_workflow_file!(workflow_file)
        Workflow.set_workflow_file_path(workflow_file)
        if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()
        stop_default_http_server()

        on_exit(fn ->
          Application.delete_env(:symphony_elixir, :workflow_file_path)
          Application.delete_env(:symphony_elixir, :server_port_override)
          Application.delete_env(:symphony_elixir, :memory_tracker_issues)
          Application.delete_env(:symphony_elixir, :memory_tracker_recipient)
        end)

        :ok
      end
    end
  end

  def write_workflow_file!(path, overrides \\ []) do
    workflow = workflow_content(overrides)
    File.write!(path, workflow)

    if Process.whereis(SymphonyElixir.WorkflowStore) do
      try do
        SymphonyElixir.WorkflowStore.force_reload()
      catch
        :exit, _reason -> :ok
      end
    end

    :ok
  end

  def restore_env(key, nil), do: System.delete_env(key)
  def restore_env(key, value), do: System.put_env(key, value)

  def put_system_env(key, value) when is_binary(key) do
    previous = System.get_env(key)
    ExUnit.Callbacks.on_exit(fn -> restore_env(key, previous) end)

    case value do
      nil -> System.delete_env(key)
      _ -> System.put_env(key, value)
    end

    :ok
  end

  def delete_system_env(key) when is_binary(key), do: put_system_env(key, nil)

  def delete_system_envs(keys) when is_list(keys) do
    Enum.each(keys, &delete_system_env/1)
    :ok
  end

  def put_system_envs(entries) when is_list(entries) or is_map(entries) do
    Enum.each(entries, fn {key, value} -> put_system_env(key, value) end)
    :ok
  end

  def put_app_env(app, key, value) do
    previous = Application.fetch_env(app, key)
    ExUnit.Callbacks.on_exit(fn -> restore_app_env(app, key, previous) end)

    case value do
      nil -> Application.delete_env(app, key)
      _ -> Application.put_env(app, key, value)
    end

    :ok
  end

  def delete_app_env(app, key), do: put_app_env(app, key, nil)

  def delete_app_envs(app, keys) when is_list(keys) do
    Enum.each(keys, &delete_app_env(app, &1))
    :ok
  end

  def put_app_envs(app, entries) when is_list(entries) or is_map(entries) do
    Enum.each(entries, fn {key, value} -> put_app_env(app, key, value) end)
    :ok
  end

  def tmp_dir!(prefix) when is_binary(prefix) do
    root = Path.join(System.tmp_dir!(), "#{prefix}-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf(root) end)
    root
  end

  def stop_default_http_server do
    case Process.whereis(SymphonyElixir.Supervisor) do
      pid when is_pid(pid) ->
        case Enum.find(Supervisor.which_children(SymphonyElixir.Supervisor), fn
               {SymphonyElixir.HttpServer, _child_pid, _type, _modules} -> true
               _child -> false
             end) do
          {SymphonyElixir.HttpServer, child_pid, _type, _modules} when is_pid(child_pid) ->
            :ok = Supervisor.terminate_child(SymphonyElixir.Supervisor, SymphonyElixir.HttpServer)

            if Process.alive?(child_pid) do
              Process.exit(child_pid, :normal)
            end

            :ok

          _ ->
            :ok
        end

      _ ->
        :ok
    end
  end

  defp restore_app_env(app, key, {:ok, value}), do: Application.put_env(app, key, value)
  defp restore_app_env(app, key, :error), do: Application.delete_env(app, key)

  defp workflow_content(overrides) do
    config =
      Keyword.merge(
        [
          tracker_kind: "linear",
          tracker_endpoint: "https://api.linear.app/graphql",
          tracker_api_token: "token",
          tracker_project_slug: "project",
          tracker_assignee: nil,
          tracker_table: nil,
          tracker_workspace_id: nil,
          tracker_plan_id: nil,
          tracker_runner_type: nil,
          tracker_comments_table: nil,
          tracker_comment_author: nil,
          tracker_writeback_table: nil,
          tracker_writeback_id_field: nil,
          tracker_repository: nil,
          tracker_webhook_secret: nil,
          tracker_active_states: ["Todo", "In Progress"],
          tracker_terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
          poll_interval_ms: 30_000,
          workspace_root: Path.join(System.tmp_dir!(), "symphony_workspaces"),
          session_workspace_root: nil,
          repo_cache_root: Path.join(System.tmp_dir!(), "symphony_repo_cache"),
          artifact_sink: Path.join(System.tmp_dir!(), "symphony_artifacts"),
          workspace_repository: nil,
          worker_ssh_hosts: [],
          worker_max_concurrent_agents_per_host: nil,
          max_concurrent_agents: 10,
          max_turns: 20,
          max_retry_backoff_ms: 300_000,
          max_concurrent_agents_by_state: %{},
          codex_command: "codex app-server",
          codex_model: nil,
          codex_model_provider: nil,
          codex_approval_policy: "on-request",
          codex_thread_sandbox: "workspace-write",
          codex_turn_sandbox_policy: nil,
          codex_turn_timeout_ms: 3_600_000,
          codex_read_timeout_ms: 60_000,
          codex_stall_timeout_ms: 300_000,
          hook_after_create: nil,
          hook_before_run: nil,
          hook_after_run: nil,
          hook_before_remove: nil,
          hook_timeout_ms: 60_000,
          observability_enabled: true,
          observability_refresh_ms: 1_000,
          observability_render_interval_ms: 16,
          server_port: nil,
          server_host: nil,
          prompt: @workflow_prompt
        ],
        overrides
      )

    tracker_kind = Keyword.get(config, :tracker_kind)
    tracker_endpoint = Keyword.get(config, :tracker_endpoint)
    tracker_api_token = Keyword.get(config, :tracker_api_token)
    tracker_project_slug = Keyword.get(config, :tracker_project_slug)
    tracker_assignee = Keyword.get(config, :tracker_assignee)
    tracker_table = Keyword.get(config, :tracker_table)
    tracker_workspace_id = Keyword.get(config, :tracker_workspace_id)
    tracker_plan_id = Keyword.get(config, :tracker_plan_id)
    tracker_runner_type = Keyword.get(config, :tracker_runner_type)
    tracker_comments_table = Keyword.get(config, :tracker_comments_table)
    tracker_comment_author = Keyword.get(config, :tracker_comment_author)
    tracker_writeback_table = Keyword.get(config, :tracker_writeback_table)
    tracker_writeback_id_field = Keyword.get(config, :tracker_writeback_id_field)
    tracker_repository = Keyword.get(config, :tracker_repository)
    tracker_webhook_secret = Keyword.get(config, :tracker_webhook_secret)
    tracker_active_states = Keyword.get(config, :tracker_active_states)
    tracker_terminal_states = Keyword.get(config, :tracker_terminal_states)
    poll_interval_ms = Keyword.get(config, :poll_interval_ms)
    workspace_root = Keyword.get(config, :workspace_root)
    session_workspace_root = Keyword.get(config, :session_workspace_root)
    repo_cache_root = Keyword.get(config, :repo_cache_root)
    artifact_sink = Keyword.get(config, :artifact_sink)
    workspace_repository = Keyword.get(config, :workspace_repository)
    worker_ssh_hosts = Keyword.get(config, :worker_ssh_hosts)
    worker_max_concurrent_agents_per_host = Keyword.get(config, :worker_max_concurrent_agents_per_host)
    max_concurrent_agents = Keyword.get(config, :max_concurrent_agents)
    max_turns = Keyword.get(config, :max_turns)
    max_retry_backoff_ms = Keyword.get(config, :max_retry_backoff_ms)
    max_concurrent_agents_by_state = Keyword.get(config, :max_concurrent_agents_by_state)
    codex_command = Keyword.get(config, :codex_command)
    codex_approval_policy = Keyword.get(config, :codex_approval_policy)
    codex_thread_sandbox = Keyword.get(config, :codex_thread_sandbox)
    codex_turn_sandbox_policy = Keyword.get(config, :codex_turn_sandbox_policy)
    codex_turn_timeout_ms = Keyword.get(config, :codex_turn_timeout_ms)
    codex_read_timeout_ms = Keyword.get(config, :codex_read_timeout_ms)
    codex_stall_timeout_ms = Keyword.get(config, :codex_stall_timeout_ms)
    hook_after_create = Keyword.get(config, :hook_after_create)
    hook_before_run = Keyword.get(config, :hook_before_run)
    hook_after_run = Keyword.get(config, :hook_after_run)
    hook_before_remove = Keyword.get(config, :hook_before_remove)
    hook_timeout_ms = Keyword.get(config, :hook_timeout_ms)
    observability_enabled = Keyword.get(config, :observability_enabled)
    observability_refresh_ms = Keyword.get(config, :observability_refresh_ms)
    observability_render_interval_ms = Keyword.get(config, :observability_render_interval_ms)
    server_port = Keyword.get(config, :server_port)
    server_host = Keyword.get(config, :server_host)
    prompt = Keyword.get(config, :prompt)

    sections =
      [
        "---",
        "tracker:",
        "  kind: #{yaml_value(tracker_kind)}",
        "  endpoint: #{yaml_value(tracker_endpoint)}",
        "  api_key: #{yaml_value(tracker_api_token)}",
        "  project_slug: #{yaml_value(tracker_project_slug)}",
        "  assignee: #{yaml_value(tracker_assignee)}",
        tracker_table && "  table: #{yaml_value(tracker_table)}",
        tracker_workspace_id && "  workspace_id: #{yaml_value(tracker_workspace_id)}",
        tracker_plan_id && "  plan_id: #{yaml_value(tracker_plan_id)}",
        tracker_runner_type && "  runner_type: #{yaml_value(tracker_runner_type)}",
        tracker_comments_table && "  comments_table: #{yaml_value(tracker_comments_table)}",
        tracker_comment_author && "  comment_author: #{yaml_value(tracker_comment_author)}",
        tracker_repository && "  repository: #{yaml_value(tracker_repository)}",
        tracker_webhook_secret && "  webhook_secret: #{yaml_value(tracker_webhook_secret)}",
        "  active_states: #{yaml_value(tracker_active_states)}",
        "  terminal_states: #{yaml_value(tracker_terminal_states)}",
        tracker_writeback_yaml(tracker_writeback_table, tracker_writeback_id_field),
        "polling:",
        "  interval_ms: #{yaml_value(poll_interval_ms)}",
        "workspace:",
        "  root: #{yaml_value(workspace_root)}",
        session_workspace_root && "  session_workspace_root: #{yaml_value(session_workspace_root)}",
        repo_cache_root && "  repo_cache_root: #{yaml_value(repo_cache_root)}",
        artifact_sink && "  artifact_sink: #{yaml_value(artifact_sink)}",
        workspace_repository && "  repository: #{yaml_value(workspace_repository)}",
        worker_yaml(worker_ssh_hosts, worker_max_concurrent_agents_per_host),
        "agent:",
        "  max_concurrent_agents: #{yaml_value(max_concurrent_agents)}",
        "  max_turns: #{yaml_value(max_turns)}",
        "  max_retry_backoff_ms: #{yaml_value(max_retry_backoff_ms)}",
        "  max_concurrent_agents_by_state: #{yaml_value(max_concurrent_agents_by_state)}",
        "codex:",
        "  command: #{yaml_value(codex_command)}",
        "  model: #{yaml_value(Keyword.get(config, :codex_model))}",
        "  model_provider: #{yaml_value(Keyword.get(config, :codex_model_provider))}",
        "  approval_policy: #{yaml_value(codex_approval_policy)}",
        "  thread_sandbox: #{yaml_value(codex_thread_sandbox)}",
        "  turn_sandbox_policy: #{yaml_value(codex_turn_sandbox_policy)}",
        "  turn_timeout_ms: #{yaml_value(codex_turn_timeout_ms)}",
        "  read_timeout_ms: #{yaml_value(codex_read_timeout_ms)}",
        "  stall_timeout_ms: #{yaml_value(codex_stall_timeout_ms)}",
        hooks_yaml(hook_after_create, hook_before_run, hook_after_run, hook_before_remove, hook_timeout_ms),
        observability_yaml(observability_enabled, observability_refresh_ms, observability_render_interval_ms),
        server_yaml(server_port, server_host),
        "---",
        prompt
      ]
      |> Enum.reject(&(&1 in [nil, ""]))

    Enum.join(sections, "\n") <> "\n"
  end

  defp yaml_value(value) when is_binary(value) do
    "\"" <> String.replace(value, "\"", "\\\"") <> "\""
  end

  defp yaml_value(value) when is_integer(value), do: to_string(value)
  defp yaml_value(true), do: "true"
  defp yaml_value(false), do: "false"
  defp yaml_value(nil), do: "null"

  defp yaml_value(values) when is_list(values) do
    "[" <> Enum.map_join(values, ", ", &yaml_value/1) <> "]"
  end

  defp yaml_value(values) when is_map(values) do
    "{" <>
      Enum.map_join(values, ", ", fn {key, value} ->
        "#{yaml_value(to_string(key))}: #{yaml_value(value)}"
      end) <> "}"
  end

  defp yaml_value(value), do: yaml_value(to_string(value))

  defp hooks_yaml(nil, nil, nil, nil, timeout_ms), do: "hooks:\n  timeout_ms: #{yaml_value(timeout_ms)}"

  defp hooks_yaml(hook_after_create, hook_before_run, hook_after_run, hook_before_remove, timeout_ms) do
    [
      "hooks:",
      "  timeout_ms: #{yaml_value(timeout_ms)}",
      hook_entry("after_create", hook_after_create),
      hook_entry("before_run", hook_before_run),
      hook_entry("after_run", hook_after_run),
      hook_entry("before_remove", hook_before_remove)
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp worker_yaml(ssh_hosts, max_concurrent_agents_per_host)
       when ssh_hosts in [nil, []] and is_nil(max_concurrent_agents_per_host),
       do: nil

  defp worker_yaml(ssh_hosts, max_concurrent_agents_per_host) do
    [
      "worker:",
      ssh_hosts not in [nil, []] && "  ssh_hosts: #{yaml_value(ssh_hosts)}",
      !is_nil(max_concurrent_agents_per_host) &&
        "  max_concurrent_agents_per_host: #{yaml_value(max_concurrent_agents_per_host)}"
    ]
    |> Enum.reject(&(&1 in [nil, false]))
    |> Enum.join("\n")
  end

  defp observability_yaml(enabled, refresh_ms, render_interval_ms) do
    [
      "observability:",
      "  dashboard_enabled: #{yaml_value(enabled)}",
      "  refresh_ms: #{yaml_value(refresh_ms)}",
      "  render_interval_ms: #{yaml_value(render_interval_ms)}"
    ]
    |> Enum.join("\n")
  end

  defp tracker_writeback_yaml(nil, nil), do: nil

  defp tracker_writeback_yaml(table, id_field) do
    [
      "  writeback:",
      table && "    table: #{yaml_value(table)}",
      id_field && "    id_field: #{yaml_value(id_field)}"
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp server_yaml(nil, nil), do: nil

  defp server_yaml(port, host) do
    [
      "server:",
      port && "  port: #{yaml_value(port)}",
      host && "  host: #{yaml_value(host)}"
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp hook_entry(_name, nil), do: nil

  defp hook_entry(name, command) when is_binary(command) do
    indented =
      command
      |> String.split("\n")
      |> Enum.map_join("\n", &("    " <> &1))

    "  #{name}: |\n#{indented}"
  end
end

defmodule SymphonyElixir.Runner.PlannerTestSupport do
  use ExUnit.CaseTemplate

  alias SymphonyElixir.LocalRelay.Registry

  using opts do
    quote do
      use SymphonyElixir.TestSupport, unquote(opts)

      alias SymphonyElixir.LocalRelay.Registry
      alias SymphonyElixir.Runner.Planner
      alias SymphonyElixir.ToolRegistry
      alias SymphonyElixir.WorkItem

      import SymphonyElixir.Runner.PlannerTestSupport

      @planner_tool_names ~w(repo.list repo.search repo.read_file repo.read_symbols plan.create plan.update plan.delete delegate task.create task.update task.schedule agent_tool_grant.create agent_tool_grant.update skill.create scheduled_task.create scheduled_task.read scheduled_task.update scheduled_task.list scheduled_task.delete plan.read task.read task.status planning_profile.create_update planning_profile.delete workspace_settings.manage workspace_settings.update_tracker_kind snooze_work_item)
      @provider_tool_names ~w(repo_list repo_search repo_read_file repo_read_symbols plan_create plan_update plan_delete delegate task_create task_update task_schedule agent_tool_grant_create agent_tool_grant_update skill_create scheduled_task_create scheduled_task_read scheduled_task_update scheduled_task_list scheduled_task_delete plan_read task_read task_status planning_profile_create_update planning_profile_delete workspace_settings_manage workspace_settings_update_tracker_kind snooze_work_item)
    end
  end

  setup context do
    Application.put_env(:symphony_elixir, :planner_responses_req_options, plug: {Req.Test, context.module})

    Application.put_env(:symphony_elixir, :planner_database_tools,
      endpoint: "https://test.supabase.co",
      api_key: "secret"
    )

    Application.put_env(:symphony_elixir, :planner_database_tools_req_options, plug: {Req.Test, context.module})

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :planner_responses_req_options)
      Application.delete_env(:symphony_elixir, :planner_database_tools)
      Application.delete_env(:symphony_elixir, :planner_database_tools_req_options)
      Registry.reset!()
    end)

    Registry.reset!()

    :ok
  end

  def start_local_planner_helper(parent) do
    spawn_link(fn ->
      receive do
        {:local_relay_dispatch, %{"correlation_id" => correlation_id} = frame} ->
          send(parent, {:local_dispatch, frame})

          Registry.tool_call_request(correlation_id, %{
            "type" => "tool_call_request",
            "tool_calls" => [
              %{
                "id" => "call-task",
                "name" => "task_create",
                "arguments" => %{
                  "plan_id" => "plan-1",
                  "name" => "Local relay task"
                }
              }
            ]
          })

          receive do
            {:local_relay_frame, frame} ->
              send(parent, {:local_continuation, frame})
              Registry.complete(correlation_id, %{"output_text" => "Created the task locally."})
          end
      end
    end)
  end
end
