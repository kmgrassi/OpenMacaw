defmodule SymphonyElixir.Runner.LocalModelCoding do
  @moduledoc """
  Runtime-owned coding loop for local OpenAI-compatible models.

  The model selects tools through provider-native function calls. Runtime owns
  the loop, tool validation, tool-result message construction, and normalized
  runner events. The concrete shell/patch executor is injectable so the runner
  can use the local executor now and a remote executor later without changing
  the provider-facing loop.
  """

  @behaviour SymphonyElixir.Runner

  require Logger

  alias SymphonyElixir.MessageHistory
  alias SymphonyElixir.Planner.ToolNameMapping
  alias SymphonyElixir.ToolRegistry
  alias SymphonyElixir.Runner.AgentConfig
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Runner.ToolCallingLoop
  alias SymphonyElixir.ToolSpec

  @runner_kind "local_model_coding"
  @default_max_iterations 10

  @doc """
  Resolves a per-agent coding runtime knob from gateway config.

  Reads `runners.local_model_coding.<agent_id>.<key>` first, falling
  back to `runners.local_model_coding.<key>`, then `default`.

  Scaffolding for non-tool runtime knobs (cadence overrides,
  timeouts, custom instructions, rate limits, ...). Tool policy is
  owned by the agent tool data model, not this helper. Add knobs
  incrementally as the platform UI exposes them. See
  `docs/local-model-readiness-runtime-prs.md` (PR2).
  """
  @spec agent_config(String.t(), String.t() | nil, String.t() | atom(), term()) :: term()
  def agent_config(workspace_id, agent_id, key, default \\ nil) do
    AgentConfig.lookup(@runner_kind, workspace_id, agent_id, key, default)
  end

  @provider_profile_keys ~w(
    api_key
    base_url
    bearer_token
    credential
    credential_ref
    endpoint
    frequency_penalty
    max_completion_tokens
    max_tokens
    model
    parallel_tool_calls
    presence_penalty
    provider
    response_format
    stop
    temperature
    tool_choice
    top_p
  )

  @impl true
  def start_session(config, workspace) when is_map(config) do
    if probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "local_model_coding"}}
      end
    else
      profile = execution_profile(config)

      session =
        %{
          runner: "local_model_coding",
          workspace: workspace || map_value(config, :workspace),
          provider: resolved_profile_value(profile, config, :provider) || "openai_compatible",
          model: resolved_profile_value(profile, config, :model),
          profile: provider_profile(config, profile),
          provider_module: provider_module(config),
          provider_opts: map_value(config, :provider_opts) || [],
          tool_definitions: tool_definitions(config),
          provider_tool_definitions: provider_tool_definitions(config),
          provider_tool_name_map: provider_tool_name_map(config),
          tool_executor: map_value(config, :tool_executor),
          max_iterations: positive_integer(map_value(config, :max_iterations), @default_max_iterations),
          history_window: non_negative_integer(map_value(config, :history_window), MessageHistory.default_limit()),
          on_message: map_value(config, :on_message),
          message_recorder_scope: map_value(config, :message_recorder_scope),
          agent_context: agent_context(config),
          metadata: map_value(config, :metadata) || %{}
        }
        |> reject_nil_values()

      # The workspace is optional at session-start time: chat-only turns
      # without tool calls don't need one. Workspace-requiring tools are
      # rejected in the tool calling loop with a structured error so the
      # model can relay the requirement back to the user.
      with :ok <- require_model(session) do
        {:ok, session}
      end
    end
  end

  @impl true
  def run_turn(session, prompt, work_item) when is_map(session) and is_binary(prompt) do
    session = put_work_item_runtime_context(session, work_item)

    emit_event(session, %{
      event: :turn_started,
      payload: %{"runner" => "local_model_coding", "model" => Map.get(session, :model)}
    })

    initial_messages = initial_messages(prompt, work_item, session)

    ToolCallingLoop.run_direct(session, %{
      initial_messages: initial_messages,
      max_iterations: session.max_iterations
    })
  end

  @impl true
  def stop_session(_session), do: :ok

  @impl true
  def ping(config) when is_map(config) do
    profile = execution_profile(config)

    if present?(map_value(profile, :model) || map_value(config, :model)) do
      :ok
    else
      {:error, :missing_model}
    end
  end

  @impl true
  def requires_workspace?, do: true

  defp initial_messages(prompt, work_item, session) do
    history = fetch_chat_history(session, work_item)

    prompt_messages = [
      %{
        "role" => "user",
        "content" => prompt,
        "metadata" => work_item_metadata(work_item)
      }
    ]

    base =
      if prompt_based?(session) do
        [
          %{
            "role" => "system",
            "content" => ToolSpec.prompt_based_system_message(session.tool_definitions)
          }
          | history ++ prompt_messages
        ]
      else
        history ++ prompt_messages
      end

    # Prepend a system message that names the workspace path so the model
    # can answer "where am I?" with the actual directory and reason about
    # absolute paths in shell.exec. repo.list / repo.read_file / repo.search
    # return paths relative to this directory; the model needs to know what
    # they're relative to.
    case system_message(session, work_item) do
      nil -> base
      content -> [%{"role" => "system", "content" => content} | base]
    end
  end

  defp fetch_chat_history(session, work_item) do
    MessageHistory.fetch(
      Map.get(session, :message_recorder_scope),
      limit: Map.get(session, :history_window, MessageHistory.default_limit()),
      exclude_run_id: work_item_run_id(work_item)
    )
    |> rewrite_history_tool_calls(session)
  end

  defp work_item_run_id(%{metadata: metadata}) when is_map(metadata) do
    case map_value(metadata, :run_id) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp work_item_run_id(_work_item), do: nil

  defp rewrite_history_tool_calls(history, session) when is_list(history) do
    provider_tool_name_map = Map.get(session, :provider_tool_name_map, %{})

    Enum.map(history, fn
      %{"role" => "assistant", "tool_calls" => tool_calls} = message when is_list(tool_calls) ->
        Map.put(message, "tool_calls", Enum.map(tool_calls, &rewrite_history_tool_call(&1, provider_tool_name_map)))

      message ->
        message
    end)
  end

  defp rewrite_history_tool_calls(_history, _session), do: []

  defp rewrite_history_tool_call(%{"function" => %{"name" => runtime_name}} = call, provider_tool_name_map)
       when is_binary(runtime_name) do
    put_in(call, ["function", "name"], ToolNameMapping.provider_name(runtime_name, provider_tool_name_map))
  end

  defp rewrite_history_tool_call(call, _provider_tool_name_map), do: call

  defp system_message(session, work_item) do
    [
      agent_context_section(session, work_item),
      workspace_system_message(session)
    ]
    |> Enum.reject(&is_nil/1)
    |> case do
      [] -> nil
      sections -> Enum.join(sections, "\n\n")
    end
  end

  defp agent_context_section(session, _work_item) do
    case normalize_agent_context(Map.get(session, :agent_context)) do
      nil -> nil
      context -> "Agent instructions:\n#{context}"
    end
  end

  defp workspace_system_message(session) do
    case Map.get(session, :workspace) do
      path when is_binary(path) and path != "" ->
        """
        You are operating in workspace directory: #{path}

        Paths returned by repo.list, repo.read_file, and repo.search are
        relative to this directory. shell.exec runs commands inside it.
        When the user asks which directory or workspace you are in, answer
        with this absolute path.
        """
        |> String.trim_trailing()

      _ ->
        nil
    end
  end

  defp work_item_metadata(%{id: id, title: title}) do
    %{"work_item_id" => id, "title" => title}
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp work_item_metadata(_work_item), do: %{}

  defp agent_context(config) do
    map_value(config, :agent_context) ||
      map_value(config, :agentContext) ||
      map_value(config, :context)
  end

  defp normalize_agent_context(context) when is_binary(context) do
    case String.trim(context) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_agent_context(_context), do: nil

  defp put_work_item_runtime_context(session, work_item) do
    work_item_context = work_item_runtime_context(work_item)
    metadata = Map.merge(work_item_context, Map.get(session, :metadata, %{}))

    session
    |> Map.put(:metadata, metadata)
    |> put_new_present(:workspace_id, map_value(metadata, :workspace_id))
    |> put_new_present(:agent_id, map_value(metadata, :agent_id))
  end

  defp work_item_runtime_context(%{metadata: metadata} = work_item) when is_map(metadata) do
    %{
      "agent_id" => map_value(metadata, :agent_id),
      "workspace_id" => map_value(metadata, :workspace_id),
      "work_item_id" => Map.get(work_item, :id),
      "title" => Map.get(work_item, :title)
    }
    |> reject_nil_values()
  end

  defp work_item_runtime_context(_work_item), do: %{}

  defp put_new_present(map, _key, value) when is_nil(value) or value == "", do: map
  defp put_new_present(map, key, value), do: Map.put_new(map, key, value)

  defp emit_event(%{on_message: on_message}, event) when is_function(on_message, 1) do
    case Contract.normalize_event(event) do
      {:ok, normalized} -> on_message.(normalized)
      {:error, reason} -> Logger.warning("local_model_coding_dropped_event reason=#{inspect(reason)} event=#{inspect(event)}")
    end
  end

  defp emit_event(_session, _event), do: :ok

  defp execution_profile(config) do
    map_value(config, :execution_profile) ||
      map_value(config, :profile) ||
      config
  end

  defp provider_profile(config, profile) do
    runtime_profile =
      config
      |> stringify_keys()
      |> Map.take(@provider_profile_keys)
      |> Enum.reject(fn {_key, value} -> blank?(value) end)
      |> Map.new()
      |> normalize_provider_endpoint()

    profile
    |> stringify_keys()
    |> normalize_provider_endpoint()
    |> Map.merge(runtime_profile, fn _key, profile_value, runtime_value ->
      if redacted?(profile_value) or blank?(profile_value), do: runtime_value, else: profile_value
    end)
    |> put_local_provider_defaults()
  end

  defp normalize_provider_endpoint(profile) when is_map(profile) do
    case Map.get(profile, "base_url") || Map.get(profile, "endpoint") do
      value when is_binary(value) and value != "" -> Map.put(profile, "base_url", value)
      _ -> profile
    end
  end

  defp put_local_provider_defaults(profile) when is_map(profile) do
    profile
    |> Map.put_new("base_url", local_openai_compatible_base_url())
    |> Map.put_new("api_key", local_openai_compatible_api_key())
  end

  defp local_openai_compatible_base_url do
    System.get_env("LOCAL_MODEL_BASE_URL") ||
      System.get_env("OPENAI_COMPATIBLE_BASE_URL") ||
      "http://127.0.0.1:11434/v1"
  end

  defp local_openai_compatible_api_key do
    System.get_env("LOCAL_MODEL_API_KEY") ||
      System.get_env("OPENAI_COMPATIBLE_API_KEY") ||
      "ollama"
  end

  defp resolved_profile_value(profile, config, key) do
    profile_value = map_value(profile, key)
    runtime_value = map_value(config, key)

    if redacted?(profile_value) or blank?(profile_value), do: runtime_value, else: profile_value
  end

  defp provider_module(config),
    do: map_value(config, :provider_module) || SymphonyElixir.Provider.OpenAICompatible

  defp tool_definitions(config) do
    case map_value(config, :tool_definitions) do
      tools when is_list(tools) -> tools
      _ -> default_tool_definitions()
    end
  end

  defp provider_tool_definitions(config) do
    tools = tool_definitions(config)
    provider = config |> execution_profile() |> map_value(:provider) |> ToolSpec.normalize_provider()

    case provider do
      :prompt_based -> []
      :openai -> openai_compatible_tool_definitions(tools)
      :openai_compatible -> openai_compatible_tool_definitions(tools)
      :anthropic -> tools
    end
  end

  defp openai_compatible_tool_definitions(tools) do
    Enum.map(tools, fn tool ->
      provider_name = provider_tool_name(map_value(tool, :name) || map_value(tool, :slug))

      tool
      |> stringify_keys()
      |> Map.put("name", provider_name)
      |> Map.put("slug", map_value(tool, :name) || map_value(tool, :slug))
      |> Map.put("description", description_with_examples(tool))
    end)
  end

  defp description_with_examples(tool) do
    description = map_value(tool, :description) || ""

    case map_value(tool, :examples) do
      examples when is_list(examples) and examples != [] ->
        description <> "\n\nExamples / usage guidance:\n" <> Jason.encode!(Enum.take(examples, 5))

      _ ->
        description
    end
  end

  defp provider_tool_name_map(config) do
    config
    |> tool_definitions()
    |> Enum.reduce(%{}, fn tool, acc ->
      canonical = map_value(tool, :name) || map_value(tool, :slug)
      Map.put(acc, provider_tool_name(canonical), canonical)
    end)
  end

  defp provider_tool_name(name) when is_binary(name) do
    name
    |> String.replace(~r/[^A-Za-z0-9_-]/, "_")
    |> String.replace(~r/^[^A-Za-z_]+/, "tool_")
    |> String.slice(0, 64)
  end

  defp provider_tool_name(name), do: name

  defp prompt_based?(session), do: ToolSpec.normalize_provider(Map.get(session, :provider)) == :prompt_based

  defp default_tool_definitions do
    :coding
    |> ToolRegistry.bundle()
    |> ToolRegistry.definitions()
    |> Enum.map(&local_coding_tool_definition/1)
  end

  defp local_coding_tool_definition(%{"name" => name} = definition)
       when name in ["repo.list", "repo.read_file", "repo.search"] do
    definition
    |> Map.update("inputSchema", %{}, &strip_repository_scope/1)
    |> Map.update("parameters", %{}, &strip_repository_scope/1)
    |> Map.update("parameters_schema", %{}, &strip_repository_scope/1)
  end

  defp local_coding_tool_definition(definition), do: definition

  defp strip_repository_scope(%{"properties" => properties} = schema) do
    required =
      schema
      |> Map.get("required", [])
      |> Enum.reject(&(&1 in ["workspace_id", "repo_id", "repository_id"]))

    schema
    |> Map.put("properties", Map.drop(properties, ["workspace_id", "repo_id", "repository_id"]))
    |> maybe_put_required(required)
  end

  defp strip_repository_scope(schema), do: schema

  defp maybe_put_required(schema, []), do: Map.delete(schema, "required")
  defp maybe_put_required(schema, required), do: Map.put(schema, "required", required)

  defp require_model(%{model: model}) when is_binary(model) and model != "", do: :ok
  defp require_model(_session), do: {:error, :missing_model}

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false

  defp blank?(value) when value in [nil, ""], do: true
  defp blank?(value) when is_binary(value), do: String.trim(value) == ""
  defp blank?(_value), do: false

  defp redacted?("[REDACTED]"), do: true
  defp redacted?(value) when is_map(value), do: Enum.any?(value, fn {_key, nested} -> redacted?(nested) end)
  defp redacted?(value) when is_list(value), do: Enum.any?(value, &redacted?/1)
  defp redacted?(_value), do: false

  defp positive_integer(value, _default) when is_integer(value) and value > 0, do: value
  defp positive_integer(_value, default), do: default
  defp non_negative_integer(value, _default) when is_integer(value) and value >= 0, do: value
  defp non_negative_integer(_value, default), do: default

  defp map_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, to_string(key))
  defp map_value(_map, _key), do: nil

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false

  defp stringify_keys(map) when is_map(map),
    do: Map.new(map, fn {key, value} -> {to_string(key), value} end)

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end
end
