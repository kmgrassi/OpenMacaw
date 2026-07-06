defmodule SymphonyElixir.Runner.LlmToolRunner.SessionConfig do
  @moduledoc false

  alias SymphonyElixir.{MessageHistory, ToolRegistry}
  alias SymphonyElixir.Learning.Prompt, as: LearningPrompt
  alias SymphonyElixir.Manager.ModelClient
  alias SymphonyElixir.Manager.Prompt, as: ManagerPrompt
  alias SymphonyElixir.Planner.ToolNameMapping

  @responses_url "https://api.openai.com/v1/responses"
  @openai_compatible_base_url "http://127.0.0.1:11434/v1"
  @default_model "gpt-5.1"
  @local_relay_fallback_excluded_tools ["git.run"]

  def build_session(config, workspace, credential, model_client, state) do
    tool_specs = config |> tool_specs(model_client) |> mark_helper_cli_tools(model_client)
    allowed_tools = ToolRegistry.definition_names(tool_specs)

    %{
      api_key: credential.api_key,
      agent_id: config_value(config, "agent_id"),
      credential_id: credential.credential_id,
      credential_ref: credential_ref(config),
      credential_scope: Map.get(credential, :credential_scope),
      workspace: workspace,
      workspace_root: workspace,
      workspace_id: config_value(config, "workspace_id"),
      model: provider_model(config_value(config, "model")) || @default_model,
      model_tier_floor: model_tier_floor(config),
      fallbacks: fallback_links(config),
      prompt: runtime_prompt(config),
      agent_context: config_value(config, "agent_context"),
      state: state,
      tool_specs: tool_specs,
      allowed_tools: allowed_tools,
      provider_tool_name_map: ToolNameMapping.runtime_to_provider(allowed_tools),
      model_client: model_client,
      provider: provider(config),
      target_runner_kind: config_value(config, "target_runner_kind") || "openai_compatible",
      capability_requirements: capability_requirements(config),
      timeout_ms: config_integer(config, "timeout_ms", 300_000),
      max_tool_iterations: config_integer(config, "max_tool_iterations", 8),
      base_url: config_value(config, "base_url") || default_base_url(model_client),
      req_options: req_options(config, model_client),
      credentials: credentials(config),
      history_window:
        config_non_negative_integer(config, "history_window", MessageHistory.default_limit()),
      user_id: config_value(config, "user_id"),
      trace_id: config_value(config, "trace_id") || Process.get(:symphony_trace_id),
      on_message: Map.get(config, :on_message),
      message_recorder_scope: Map.get(config, :message_recorder_scope)
    }
  end

  def probe_only?(config) when is_map(config),
    do: config[:probe_only] == true or config["probe_only"] == true

  def probe_only?(_config), do: false

  def resolve_credential(config, ModelClient.LocalRelay) do
    credential_id = config_value(config, "credential_id")

    {:ok,
     %{api_key: config_value(config, "api_key") || "local-runtime", credential_id: credential_id}}
  end

  def resolve_credential(config, ModelClient.OpenAICompatibleChat) do
    credential_id = config_value(config, "credential_id")
    {:ok, %{api_key: config_value(config, "api_key"), credential_id: credential_id}}
  end

  def resolve_credential(config, _model_client) do
    credential_id = config_value(config, "credential_id")

    case config_value(config, "api_key") || credentials_api_key(config) ||
           System.get_env("OPENAI_API_KEY") do
      value when is_binary(value) and value != "" ->
        {:ok, %{api_key: value, credential_id: credential_id}}

      _ ->
        {:error, :no_credential}
    end
  end

  def tool_specs(config, model_client) do
    ToolRegistry.effective_definitions(config, fallback_tool_names(config, model_client))
  end

  def mark_helper_cli_tools(tool_specs, ModelClient.LocalRelay) when is_list(tool_specs) do
    Enum.map(tool_specs, fn spec ->
      if is_map(spec) and tool_spec_name(spec) in local_helper_tools() do
        Map.put(spec, "execution_kind", "helper")
      else
        spec
      end
    end)
  end

  def mark_helper_cli_tools(tool_specs, _model_client), do: tool_specs

  def model_client(config) do
    case config_value(config, "model_client") || config_value(config, "manager_model_client") ||
           provider(config) do
      "local_relay" -> ModelClient.LocalRelay
      "local" -> ModelClient.LocalRelay
      "openai_compatible_chat" -> ModelClient.OpenAICompatibleChat
      "openai_compatible" -> ModelClient.OpenAICompatibleChat
      _ -> ModelClient.OpenAIResponses
    end
  end

  def provider(config),
    do: config_value(config, "provider") || config_value(config, "model_provider") || "openai"

  def provider_model(model) when is_binary(model) do
    model
    |> String.trim()
    |> String.split("/", parts: 2)
    |> List.last()
    |> case do
      "" -> nil
      value -> value
    end
  end

  def provider_model(_model), do: nil

  def default_base_url(ModelClient.OpenAICompatibleChat), do: @openai_compatible_base_url
  def default_base_url(_model_client), do: @responses_url

  def req_options(config, ModelClient.OpenAICompatibleChat) do
    configured = config_value(config, "req_options") || []

    env_options =
      Application.get_env(:symphony_elixir, :manager_openai_compatible_req_options, [])

    defaults = [receive_timeout: 120_000]

    defaults
    |> Keyword.merge(List.wrap(configured))
    |> Keyword.merge(env_options)
  end

  def req_options(config, _model_client) do
    configured = config_value(config, "req_options") || []
    env_options = Application.get_env(:symphony_elixir, :manager_responses_req_options, [])
    defaults = [receive_timeout: 120_000]

    defaults
    |> Keyword.merge(List.wrap(configured))
    |> Keyword.merge(env_options)
  end

  def cutover_enabled?(session) do
    Map.get(session, :fallbacks, []) != [] or Map.get(session, :model_tier_floor, "any") != "any"
  end

  def credential_ref(config) do
    cond do
      ref = config_value(config, "credential_ref") ->
        ref

      id = config_value(config, "credential_id") ->
        %{"type" => "credential_id", "value" => id}

      true ->
        nil
    end
  end

  def config_value(config, key) when is_map(config) do
    Map.get(config, key) || Map.get(config, String.to_atom(key))
  end

  def config_integer(config, key, default) do
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

  def config_non_negative_integer(config, key, default) do
    case config_value(config, key) do
      value when is_integer(value) and value >= 0 ->
        value

      value when is_binary(value) ->
        case Integer.parse(value) do
          {integer, ""} when integer >= 0 -> integer
          _ -> default
        end

      _ ->
        default
    end
  end

  def runtime_prompt(config) do
    base =
      case agent_type(config) do
        "manager" ->
          ManagerPrompt.load!() <>
            "\n\nCurrent time: #{DateTime.utc_now() |> DateTime.to_iso8601()}. Workspace timezone: Etc/UTC. When a user asks to pause or defer a work_item to a specific time, call snooze with until set to the resolved absolute ISO timestamp."

        "learning" ->
          LearningPrompt.load!() <>
            "\n\nCurrent time: #{DateTime.utc_now() |> DateTime.to_iso8601()}. Workspace timezone: Etc/UTC."

        _other ->
          config_value(config, "prompt") ||
            "You are a helpful agent. Use the available tools when needed."
      end

    append_agent_context(base, config)
  end

  defp append_agent_context(prompt, config) do
    case config_value(config, "agent_context") do
      context when is_binary(context) ->
        case String.trim(context) do
          "" -> prompt
          trimmed -> prompt <> "\n\nAgent instructions:\n" <> trimmed
        end

      _ ->
        prompt
    end
  end

  defp fallback_tool_names(config, ModelClient.LocalRelay) do
    tool_bundle(config)
    |> ToolRegistry.bundle()
    |> Enum.reject(&(&1 in @local_relay_fallback_excluded_tools))
  end

  defp fallback_tool_names(config, _model_client) do
    ToolRegistry.bundle(tool_bundle(config))
  end

  defp agent_type(config),
    do: config_value(config, "agent_type") || config_value(config, "type") || "manager"

  defp tool_bundle(config) do
    case config_value(config, "tool_bundle") || agent_type(config) do
      "manager" -> :manager
      "learning" -> :learning
      "router" -> :router
      "coding" -> :coding
      "planning" -> :planner
      "planner" -> :planner
      value when is_atom(value) -> value
      _other -> :manager
    end
  end

  defp capability_requirements(config) do
    case config_value(config, "capability_requirements") ||
           config_value(config, "capabilityRequirements") do
      requirements when is_map(requirements) -> requirements
      _ -> %{}
    end
  end

  defp model_tier_floor(config) do
    case config_value(config, "model_tier_floor") || config_value(config, "modelTierFloor") do
      floor when floor in ["frontier", "mid", "local"] -> floor
      _ -> "any"
    end
  end

  defp fallback_links(config) do
    config
    |> config_value("fallbacks")
    |> List.wrap()
    |> Enum.filter(&is_map/1)
    |> Enum.map(&normalize_fallback_link/1)
  end

  defp normalize_fallback_link(link) do
    credential_ref = credential_ref(link)

    %{
      "provider" => config_value(link, "provider"),
      "model" => provider_model(config_value(link, "model")),
      "credential_ref" => credential_ref
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp credentials_api_key(config) do
    case config_value(config, "credentials") do
      %{} = credentials ->
        Map.get(credentials, "OPENAI_API_KEY") || Map.get(credentials, :OPENAI_API_KEY)

      _ ->
        nil
    end
  end

  defp credentials(config) do
    case config_value(config, "credentials") do
      %{} = credentials -> credentials
      _ -> %{}
    end
  end

  defp tool_spec_name(definition) do
    Map.get(definition, "name") || Map.get(definition, :name) ||
      Map.get(definition, "slug") || Map.get(definition, :slug)
  end

  defp local_helper_tools do
    ["git.run", "shell.exec", "repo.list", "repo.read_file", "repo.search"]
  end
end
