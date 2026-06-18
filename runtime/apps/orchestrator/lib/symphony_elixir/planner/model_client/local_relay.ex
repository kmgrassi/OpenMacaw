defmodule SymphonyElixir.Planner.ModelClient.LocalRelay do
  @moduledoc """
  Planner model client for local models reached through the relay helper.

  The helper owns model inference only. Runtime owns planner tool execution so
  local planner agents create the same plan/work-item records as the cloud
  Responses client.
  """

  @behaviour SymphonyElixir.Planner.ModelClient

  alias SymphonyElixir.{
    Codex.ToolPolicy,
    Config,
    MapUtils,
    PlanningProfile,
    Planner.PlannerToolExecutor,
    Planner.ToolNameMapping,
    ToolRegistry,
    ToolSpec,
    WorkItem
  }

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Readiness, Registry}
  alias SymphonyElixir.Planner.ModelClient.OpenAIResponses
  alias SymphonyElixir.Runner.ToolCallingLoop

  @default_model "qwen2.5-coder:latest"
  @default_target_runner_kind "openai_compatible"
  @default_timeout_ms 300_000
  @default_max_tool_iterations 8

  @impl true
  def start_session(config, _workspace) when is_map(config) do
    settings = Config.settings!()
    settings_agent = settings.stored_agent || %{}
    agent = config_value(config, "agent") || config_value(config, "stored_agent") || settings_agent
    workspace_id = config_value(config, "workspace_id") || config_value(agent, "workspace_id")
    tool_policy = agent_tool_policy(agent) || settings.stored_agent.tool_policy || %{}
    planning_profile = config_value(config, "planning_profile") || PlanningProfile.resolve(agent)

    runtime_policy =
      ToolPolicy.resolve("planning", tool_policy, %{
        thread_sandbox: "read-only",
        turn_sandbox_policy: %{"type" => "readOnly", "networkAccess" => false}
      })

    tool_specs = ToolRegistry.effective_definitions(config, runtime_policy.dynamic_tool_names)
    tool_names = ToolRegistry.definition_names(tool_specs)

    with {:ok, state} <- Agent.start_link(fn -> %{author_task_ids: %{}} end) do
      {:ok,
       %{
         provider: "local",
         model: config_value(config, "model") || agent_model(agent) || @default_model,
         target_runner_kind: config_value(config, "target_runner_kind") || config_value(config, "targetRunnerKind") || @default_target_runner_kind,
         timeout_ms: config_integer(config, "timeout_ms", @default_timeout_ms),
         instructions:
           config_value(config, "instructions") ||
             OpenAIResponses.default_instructions(settings, agent, planning_profile, tool_names),
         state: state,
         tool_specs: tool_specs,
         tool_names: tool_names,
         provider_tool_name_map: ToolNameMapping.provider_to_runtime(tool_names),
         workspace_id: workspace_id,
         agent_id: config_value(config, "agent_id") || config_value(agent, "id"),
         user_id: config_value(config, "user_id"),
         session_id: config_value(config, "session_id"),
         max_tool_iterations: config_integer(config, "max_tool_iterations", @default_max_tool_iterations),
         trace_id: config_value(config, "trace_id") || Process.get(:symphony_trace_id),
         on_message: config_value(config, "on_message")
       }}
    end
  end

  @impl true
  def run_turn(session, prompt, %WorkItem{} = work_item)
      when is_map(session) and is_binary(prompt) do
    correlation_id = Ecto.UUID.generate()

    with :ok <- require_field(session.workspace_id, :workspace_id),
         :ok <- require_field(session.target_runner_kind, :target_runner_kind),
         {:ok, _helper} <- Readiness.lookup(session.workspace_id, session.target_runner_kind),
         {:ok, frame} <- dispatch_frame(session, prompt, work_item, correlation_id) do
      ToolCallingLoop.run(
        Map.merge(session, %{
          correlation_id: correlation_id,
          dispatch_frame: frame,
          tool_definitions: session.tool_specs,
          tool_executor: &execute_planner_tool/3
        }),
        %{
          max_iterations: session.max_tool_iterations,
          timeout_per_tool_ms: 30_000,
          total_timeout_ms: session.timeout_ms
        }
      )
    else
      {:error, :local_runtime_offline} -> {:error, {:retryable, :local_runtime_offline}}
      {:error, reason} -> {:error, {:fatal, reason}}
    end
  end

  @impl true
  def stop_session(%{active_correlation_id: correlation_id}) when is_binary(correlation_id) do
    Registry.cancel(correlation_id)
    :ok
  end

  def stop_session(%{state: state}) when is_pid(state) do
    Agent.stop(state, :normal)
  catch
    :exit, _reason -> :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) when is_map(config) do
    workspace_id = config_value(config, "workspace_id")
    target_runner_kind = config_value(config, "target_runner_kind") || @default_target_runner_kind

    with :ok <- require_field(workspace_id, :workspace_id),
         :ok <- require_field(target_runner_kind, :target_runner_kind),
         {:ok, _helper} <- Readiness.lookup(workspace_id, target_runner_kind) do
      :ok
    end
  end

  @impl true
  def requires_workspace?, do: false

  defp dispatch_frame(session, prompt, work_item, correlation_id) do
    tool_specs = provider_tool_specs(session.tool_specs, session.provider_tool_name_map)

    {:ok,
     %{
       "type" => "dispatch",
       "protocol" => ProtocolExtensions.protocol_version(),
       "correlation_id" => correlation_id,
       "workspace_id" => session.workspace_id,
       "agent_id" => session.agent_id,
       "run_id" => work_item.id || correlation_id,
       "session_id" => session.session_id,
       "runner_kind" => "planner",
       "target_runner_kind" => session.target_runner_kind,
       "provider" => "local",
       "model" => session.model,
       "prompt" => prompt,
       "messages" => initial_messages(session, prompt, work_item),
       "work_item" => work_item_context(work_item),
       "tool_definitions" => session.tool_specs,
       "provider_tool_specs" => tool_specs,
       "tool_frame_types" => ProtocolExtensions.tool_frame_types(),
       "tool_calling_mode" => "cloud_managed",
       "tool_calling_config" => %{
         "max_iterations" => session.max_tool_iterations,
         "timeout_per_tool_ms" => 30_000,
         "total_timeout_ms" => session.timeout_ms
       }
     }
     |> reject_nil_values()}
  rescue
    error in ArgumentError -> {:error, {:invalid_tool_definition, Exception.message(error)}}
  end

  defp provider_tool_specs(tool_specs, provider_tool_name_map) do
    runtime_to_provider =
      Map.new(provider_tool_name_map, fn {provider_name, runtime_name} -> {runtime_name, provider_name} end)

    tool_specs
    |> ToolSpec.to_provider_format(:openai_compatible)
    |> Enum.map(&ToolNameMapping.put_provider_tool_name(&1, runtime_to_provider))
  end

  defp execute_planner_tool(tool, arguments, session) do
    arguments = PlannerToolExecutor.maybe_put_workspace_id(arguments, tool, session)
    PlannerToolExecutor.execute(session, tool, arguments)
  end

  defp initial_messages(session, prompt, work_item) do
    [
      %{"role" => "system", "content" => session.instructions},
      %{"role" => "user", "content" => prompt, "metadata" => work_item_context(work_item)}
    ]
  end

  defp work_item_context(%WorkItem{} = work_item) do
    %{
      "id" => work_item.id,
      "identifier" => work_item.identifier,
      "title" => work_item.title
    }
    |> reject_nil_values()
  end

  defp work_item_context(_work_item), do: %{}

  defp require_field(value, _field) when is_binary(value) and value != "", do: :ok
  defp require_field(_value, field), do: {:error, :"missing_#{field}"}

  defp agent_model(agent) do
    case get_field(agent, "model_settings") do
      model_settings when is_map(model_settings) ->
        MapUtils.atom_or_string_get(model_settings, "model")

      _ ->
        nil
    end
  end

  defp agent_tool_policy(agent) do
    case get_field(agent, "tool_policy") do
      tool_policy when is_map(tool_policy) -> tool_policy
      _ -> nil
    end
  end

  defp config_value(config, key) when is_map(config), do: get_field(config, key)
  defp get_field(map, key) when is_map(map), do: MapUtils.atom_or_string_get(map, key)
  defp get_field(_map, _key), do: nil

  defp config_integer(config, key, default) do
    case config_value(config, key) do
      value when is_integer(value) and value > 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer > 0 -> integer
          _ -> default
        end

      _ ->
        default
    end
  end

  defp reject_nil_values(map) do
    MapUtils.drop_nil_values(map)
  end
end
