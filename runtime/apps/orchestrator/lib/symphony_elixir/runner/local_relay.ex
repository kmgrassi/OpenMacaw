defmodule SymphonyElixir.Runner.LocalRelay do
  @moduledoc """
  Runner adapter that dispatches work to an online local runtime helper.

  The adapter does not connect to local model endpoints directly. It builds a
  protocol frame, sends it through `SymphonyElixir.LocalRelay.Registry`, and
  normalizes helper progress/completion/error frames into the runner contract.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.LocalRelay.{ProtocolExtensions, Registry, Session}
  alias SymphonyElixir.LocalRelay.Handlers.HelperManaged
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.Runner.ToolCallingLoop
  alias SymphonyElixir.ToolExecutionContext
  alias SymphonyElixir.ToolSpec

  @default_target_runner_kind "openai_compatible"
  @default_timeout_ms 300_000
  @error_codes %{
    "local_runtime_offline" => :local_runtime_offline,
    "local_runner_busy" => :local_runner_busy,
    "local_runner_timeout" => :local_runner_timeout,
    "endpoint_unreachable" => :endpoint_unreachable,
    "model_not_found" => :model_not_found,
    "capability_missing" => :capability_missing,
    "context_overflow" => :context_overflow,
    "generation_timeout" => :generation_timeout,
    "local_runner_protocol_error" => :local_runner_protocol_error,
    "provider_rate_limited" => :provider_rate_limited,
    "provider_timeout" => :provider_timeout,
    "provider_overloaded" => :provider_overloaded,
    "provider_stream_interrupted" => :provider_stream_interrupted,
    "provider_content_refused" => :provider_content_refused,
    "provider_unknown" => :provider_unknown,
    "provider_invalid_request" => :provider_invalid_request,
    "provider_auth_failed" => :provider_auth_failed
  }

  @impl true
  def start_session(config, _workspace) when is_map(config) do
    if probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "local_relay"}}
      end
    else
      session = %{
        runner: "local_relay",
        workspace_id: workspace_id(config),
        agent_id: agent_id(config),
        user_id: user_id(config),
        session_id: session_id(config),
        workspace_root: workspace_root(config),
        target_runner_kind: target_runner_kind(config),
        provider: provider(config),
        model: model(config),
        timeout_ms: timeout_ms(config),
        trace_id: Map.get(config, "trace_id") || Map.get(config, :trace_id) || Process.get(:symphony_trace_id),
        on_message: Map.get(config, :on_message) || Map.get(config, "on_message"),
        metadata: %{
          capability_requirements: capability_requirements(config),
          credential_ref: credential_ref(config),
          tool_definitions: tool_definitions(config),
          tool_calling_mode: tool_calling_mode(config),
          tool_calling_config: tool_calling_config(config)
        }
      }

      with :ok <- require_field(session.workspace_id, :workspace_id),
           :ok <- require_field(session.target_runner_kind, :target_runner_kind) do
        {:ok, session}
      end
    end
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    correlation_id = Ecto.UUID.generate()
    started_at = System.monotonic_time(:millisecond)
    context = provider_context(session, work_item, correlation_id)
    Observability.log_model_call_started(context)

    result =
      with {:ok, frame} <- dispatch_frame(session, prompt, work_item, correlation_id),
           {:ok, helper} <- Registry.lookup(session.workspace_id, session.target_runner_kind),
           :ok <- ensure_model_available(session, helper),
           :ok <- ensure_capabilities(session, helper) do
        if session.metadata.tool_calling_mode == "cloud_managed" do
          ToolCallingLoop.run(
            Map.merge(session, %{
              correlation_id: correlation_id,
              dispatch_frame: frame,
              tool_definitions: session.metadata.tool_definitions,
              tool_calling_config: session.metadata.tool_calling_config
            }),
            tool_loop_config(session)
          )
        else
          run_helper_managed_session(session, frame, correlation_id, work_item)
        end
      else
        {:error, :local_runtime_offline} -> {:error, {:retryable, :local_runtime_offline}}
        {:error, :model_not_found} -> {:error, {:fatal, :model_not_found}}
        {:error, :capability_missing} -> {:error, {:fatal, :capability_missing}}
        {:error, {:invalid_tool_definition, message}} -> {:error, {:fatal, {:invalid_tool_definition, message}}}
      end

    log_provider_result(result, context, started_at)
  end

  @impl true
  def stop_session(%{active_correlation_id: correlation_id}) when is_binary(correlation_id) do
    Registry.cancel(correlation_id)
    :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    workspace_id = workspace_id(config)
    runner_kind = target_runner_kind(config)

    with :ok <- require_field(workspace_id, :workspace_id),
         :ok <- require_field(runner_kind, :target_runner_kind),
         {:ok, _helper} <- Registry.lookup(workspace_id, runner_kind) do
      :ok
    else
      {:error, :missing_workspace_id} -> {:error, :missing_workspace_id}
      {:error, :missing_target_runner_kind} -> {:error, :missing_target_runner_kind}
      {:error, :local_runtime_offline} -> {:error, :local_runtime_offline}
    end
  end

  @impl true
  def requires_workspace?, do: false

  @spec typed_error?(term()) :: boolean()
  def typed_error?(error) do
    error in Map.values(@error_codes)
  end

  defp run_helper_managed_session(session, frame, correlation_id, work_item) do
    Session.run_turn(
      %{
        workspace_id: session.workspace_id,
        target_runner_kind: session.target_runner_kind,
        frame: frame,
        correlation_id: correlation_id,
        timeout_ms: session.timeout_ms,
        on_message: session.on_message,
        tool_definitions: session.metadata.tool_definitions,
        tool_execution_context: runtime_context(session, work_item)
      },
      HelperManaged
    )
  end

  defp ensure_model_available(%{model: model}, _helper) when model in [nil, ""], do: :ok

  defp ensure_model_available(%{model: model, target_runner_kind: target_runner_kind}, helper) do
    case registered_runner_for_model(helper, target_runner_kind, model) do
      %{model: registered_model} when registered_model in [nil, "", model] -> :ok
      %{"model" => registered_model} when registered_model in [nil, "", model] -> :ok
      _runner -> {:error, :model_not_found}
    end
  end

  defp ensure_capabilities(%{metadata: %{capability_requirements: requirements}}, _helper) when requirements in [%{}, nil], do: :ok

  defp ensure_capabilities(%{metadata: %{capability_requirements: requirements}, target_runner_kind: target_runner_kind} = session, helper) do
    capabilities =
      helper
      |> registered_runner_for_model(target_runner_kind, Map.get(session, :model))
      |> map_value(:capabilities)
      |> normalize_capability_map()

    missing? =
      Enum.any?(requirements, fn {key, required} ->
        not capability_satisfies?(map_value(capabilities, key), required)
      end)

    if missing?, do: {:error, :capability_missing}, else: :ok
  end

  defp registered_runner(%{runners: runners}, target_runner_kind) when is_list(runners) do
    Enum.find(runners, %{}, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runner(%{"runners" => runners}, target_runner_kind) when is_list(runners) do
    Enum.find(runners, %{}, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runner(_helper, _target_runner_kind), do: %{}

  defp registered_runners(%{runners: runners}, target_runner_kind) when is_list(runners) do
    Enum.filter(runners, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runners(%{"runners" => runners}, target_runner_kind) when is_list(runners) do
    Enum.filter(runners, fn runner -> map_value(runner, :runner_kind) == target_runner_kind end)
  end

  defp registered_runners(_helper, _target_runner_kind), do: []

  defp registered_runner_for_model(helper, target_runner_kind, model) do
    helper
    |> registered_runners(target_runner_kind)
    |> Enum.find(registered_runner(helper, target_runner_kind), fn runner ->
      registered_model = map_value(runner, :model)
      registered_model in [nil, "", model]
    end)
  end

  defp capability_satisfies?(_capability, false), do: true
  defp capability_satisfies?(capability, true), do: capability == true
  defp capability_satisfies?(capability, required), do: capability == required

  defp normalize_capability_map(capabilities) when is_map(capabilities), do: capabilities
  defp normalize_capability_map(_capabilities), do: %{}

  defp dispatch_frame(session, prompt, work_item, correlation_id) do
    frame =
      %{
        "type" => "dispatch",
        "protocol" => ProtocolExtensions.protocol_version(),
        "correlation_id" => correlation_id,
        "workspace_id" => session.workspace_id,
        "agent_id" => session.agent_id || work_item_agent_id(work_item),
        "run_id" => work_item_run_id(work_item) || correlation_id,
        "session_id" => work_item_session_id(work_item),
        "runner_kind" => "local_relay",
        "target_runner_kind" => session.target_runner_kind,
        "provider" => session.provider,
        "model" => session.model,
        "prompt" => prompt,
        "messages" => initial_messages(session, prompt, work_item),
        "work_item" => work_item_context(work_item),
        "capability_requirements" => session.metadata.capability_requirements,
        "credential_ref" => session.metadata.credential_ref
      }
      |> put_tool_fields(session)

    with {:ok, frame} <- frame do
      {:ok, reject_nil_values(frame)}
    end
  end

  defp put_tool_fields(frame, %{metadata: %{tool_definitions: []}}), do: {:ok, frame}

  defp put_tool_fields(frame, session) do
    tools = session.metadata.tool_definitions
    provider = tool_provider(session)

    {:ok,
     frame
     |> Map.put("tool_definitions", tools)
     |> Map.put("provider_tool_specs", ToolSpec.to_provider_format(tools, provider))
     |> Map.put("tool_frame_types", ProtocolExtensions.tool_frame_types())
     |> Map.put("tool_calling_mode", session.metadata.tool_calling_mode)
     |> Map.put("tool_calling_config", session.metadata.tool_calling_config)}
  rescue
    error in ArgumentError -> {:error, {:invalid_tool_definition, Exception.message(error)}}
  end

  defp tool_provider(%{provider: provider}) do
    case ToolSpec.normalize_provider(provider) do
      :openai_compatible -> :openai_compatible
      other -> other
    end
  end

  defp require_field(value, field) when is_binary(value) do
    if String.trim(value) == "", do: {:error, missing_field(field)}, else: :ok
  end

  defp require_field(_value, field), do: {:error, missing_field(field)}

  defp missing_field(:workspace_id), do: :missing_workspace_id
  defp missing_field(:target_runner_kind), do: :missing_target_runner_kind

  defp workspace_id(config), do: get_config(config, ["workspace_id"]) || get_config(config, ["routing", "workspaceId"])
  defp agent_id(config), do: get_config(config, ["agent_id"]) || get_config(config, ["routing", "agentId"])
  defp user_id(config), do: get_config(config, ["user_id"]) || get_config(config, ["routing", "userId"])
  defp session_id(config), do: get_config(config, ["session_id"]) || get_config(config, ["routing", "sessionId"])
  defp workspace_root(config), do: get_config(config, ["workspace_root"]) || get_config(config, ["workspaceRoot"]) || get_config(config, ["routing", "workspaceRoot"])
  defp model(config), do: get_config(config, ["model"]) || get_config(config, ["routing", "model"])
  defp provider(config), do: get_config(config, ["provider"]) || get_config(config, ["routing", "provider"]) || "local"

  defp target_runner_kind(config) do
    get_config(config, ["target_runner_kind"]) ||
      get_config(config, ["targetRunnerKind"]) ||
      get_config(config, ["routing", "targetRunnerKind"]) ||
      get_config(config, ["routing", "target_runner_kind"]) ||
      @default_target_runner_kind
  end

  defp timeout_ms(config) do
    case get_config(config, ["timeout_ms"]) || get_config(config, ["timeoutMs"]) do
      value when is_integer(value) and value > 0 -> value
      _ -> @default_timeout_ms
    end
  end

  defp capability_requirements(config) do
    requirements =
      case get_config(config, ["capability_requirements"]) || get_config(config, ["capabilityRequirements"]) || %{} do
        requirements when is_map(requirements) -> requirements
        _requirements -> %{}
      end

    if tool_definitions(config) == [] do
      requirements
    else
      Map.put_new(requirements, "tool_calls", true)
    end
  end

  defp credential_ref(config), do: get_config(config, ["credential_ref"]) || get_config(config, ["credentialRef"])

  defp tool_definitions(config) do
    config
    |> get_config(["tool_definitions"])
    |> Kernel.||(get_config(config, ["toolDefinitions"]))
    |> normalize_tool_definitions()
  end

  defp tool_calling_mode(config) do
    case get_config(config, ["tool_calling_mode"]) || get_config(config, ["toolCallingMode"]) do
      mode when mode in ["helper_managed", "cloud_managed"] -> mode
      _ -> "helper_managed"
    end
  end

  defp tool_calling_config(config) do
    defaults = %{
      "max_iterations" => 10,
      "timeout_per_tool_ms" => 30_000,
      "total_timeout_ms" => 300_000
    }

    config =
      get_config(config, ["tool_calling_config"]) ||
        get_config(config, ["toolCallingConfig"]) ||
        %{}

    Map.merge(defaults, normalize_tool_calling_config(config))
  end

  defp tool_loop_config(session) do
    Map.update(session.metadata.tool_calling_config, "total_timeout_ms", session.timeout_ms, fn total_timeout_ms ->
      min(total_timeout_ms, session.timeout_ms)
    end)
  end

  defp get_config(config, path) do
    Enum.reduce_while(path, config, fn key, acc ->
      cond do
        is_map(acc) -> {:cont, map_value(acc, key)}
        true -> {:halt, nil}
      end
    end)
  end

  defp work_item_context(work_item) do
    %{
      "id" => Map.get(work_item, :id),
      "identifier" => Map.get(work_item, :identifier),
      "title" => Map.get(work_item, :title),
      "description" => Map.get(work_item, :description),
      "metadata" => Map.get(work_item, :metadata) || %{}
    }
    |> reject_nil_values()
  end

  defp work_item_agent_id(work_item), do: metadata_value(work_item, "agent_id")
  defp work_item_run_id(work_item), do: metadata_value(work_item, "run_id")
  defp work_item_session_id(work_item), do: metadata_value(work_item, "session_id")

  defp initial_messages(session, prompt, work_item) do
    [
      %{
        "role" => "system",
        "content" => runtime_context_message(session, work_item)
      },
      %{"role" => "user", "content" => prompt}
    ]
  end

  defp runtime_context_message(session, work_item) do
    context = runtime_context(session, work_item)

    [
      "Runtime context for this coding session is already available. Use these IDs when a tool schema asks for them; do not ask the user to provide them.",
      "agent_id: #{Map.get(context, "agent_id") || ""}",
      "workspace_id: #{Map.get(context, "workspace_id") || ""}",
      "user_id: #{Map.get(context, "user_id") || ""}",
      "session_id: #{Map.get(context, "session_id") || ""}",
      local_workspace_context_line(context)
    ]
    |> Enum.reject(&(&1 in [nil, ""]))
    |> Enum.join("\n")
  end

  defp local_workspace_context_line(%{"workspace_root" => workspace_root}) when is_binary(workspace_root) and workspace_root != "" do
    "local_workspace_root: #{workspace_root}"
  end

  defp local_workspace_context_line(_context), do: nil

  defp runtime_context(session, work_item) do
    ToolExecutionContext.from_session(session, %{
      agent_id: session.agent_id || work_item_agent_id(work_item),
      workspace_id: session.workspace_id,
      user_id: Map.get(session, :user_id),
      session_id: Map.get(session, :session_id) || work_item_session_id(work_item),
      workspace_root: Map.get(session, :workspace_root)
    })
  end

  defp normalize_tool_definitions(tools) when is_list(tools) do
    tools
    |> Enum.filter(&is_map/1)
    |> Enum.map(&normalize_tool_definition/1)
  end

  defp normalize_tool_definitions(_tools), do: []

  defp normalize_tool_definition(tool) do
    %{
      "name" => map_value(tool, :name) || map_value(tool, :slug),
      "description" => map_value(tool, :description) || "",
      "parameters_schema" => map_value(tool, :parameters_schema) || map_value(tool, :parameters) || %{"type" => "object", "properties" => %{}},
      "execution_kind" => map_value(tool, :execution_kind),
      "execution_config" => map_value(tool, :execution_config) || %{},
      "runner_kind" => map_value(tool, :runner_kind)
    }
    |> reject_nil_values()
  end

  defp normalize_tool_calling_config(config) when is_map(config) do
    %{}
    |> put_positive_integer(config, "max_iterations", ["max_iterations", "maxIterations"])
    |> put_positive_integer(config, "timeout_per_tool_ms", ["timeout_per_tool_ms", "timeoutPerToolMs"])
    |> put_positive_integer(config, "total_timeout_ms", ["total_timeout_ms", "totalTimeoutMs"])
  end

  defp normalize_tool_calling_config(_config), do: %{}

  defp put_positive_integer(result, source, output_key, source_keys) do
    value = Enum.find_value(source_keys, &map_value(source, &1))

    if is_integer(value) and value > 0 do
      Map.put(result, output_key, value)
    else
      result
    end
  end

  defp metadata_value(work_item, key) do
    metadata = Map.get(work_item, :metadata) || %{}
    map_value(metadata, key)
  end

  defp map_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        value

      :error ->
        string_key = to_string(key)

        Enum.find_value(map, fn {candidate_key, value} ->
          if to_string(candidate_key) == string_key, do: value
        end)
    end
  end

  defp map_value(_map, _key), do: nil

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp provider_context(session, work_item, correlation_id) do
    %{
      provider: Map.get(session, :provider) || "local",
      model: Map.get(session, :model),
      runner_kind: "local_relay",
      credential_scope: get_in(session, [:metadata, :credential_ref, "scope"]) || get_in(session, [:metadata, :credential_ref, :scope]),
      credential_id: get_in(session, [:metadata, :credential_ref, "credential_id"]) || get_in(session, [:metadata, :credential_ref, :credential_id]),
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      session_key: Map.get(session, :session_id),
      run_id: Map.get(work_item, :id) || correlation_id,
      trace_id: Map.get(session, :trace_id),
      attempt: 1
    }
  end

  defp log_provider_result({:ok, response} = result, context, started_at) do
    Observability.log_model_call_completed(context, elapsed_ms(started_at), provider_request_id: Map.get(response, "correlation_id"))

    result
  end

  defp log_provider_result({:error, {_kind, reason}} = result, context, started_at) do
    reason
    |> Observability.provider_error_failure(context, elapsed_ms(started_at))
    |> Observability.log_provider_failure()

    result
  end

  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
