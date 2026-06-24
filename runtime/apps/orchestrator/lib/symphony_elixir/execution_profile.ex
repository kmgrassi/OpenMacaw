defmodule SymphonyElixir.ExecutionProfile do
  @moduledoc """
  Resolves and normalizes provider-neutral execution metadata for runtime
  launches.

  Two complementary entry points:

    * `resolve_coding/3` — used by the agent runner. Picks up a profile from
      opts, work-item metadata, or the runner config; otherwise derives a
      legacy Codex fallback from the existing runner config.
    * `normalize_from_config/1` — used by the launcher and the orchestrator
      starter. Reads a (possibly empty) profile from a workflow config map and
      returns a sanitized representation suitable for logging or persisting
      back into a generated workflow file.

  The profile is routing metadata, not a credential container. Secret-shaped
  values are redacted before they are written to workflow files, logs, or
  runtime responses.
  """

  alias SymphonyElixir.{Config, Runner, WorkItem}
  alias SymphonyElixir.Schema.ExecutionProfile, as: ExecutionProfileSchema

  @type t :: %{optional(String.t()) => term()}

  @secret_key_fragments ~w(api_key access_token refresh_token secret password private_key bearer token key_value value)

  # ---------------------------------------------------------------------------
  # resolve_coding flow (consumed by AgentRunner)
  # ---------------------------------------------------------------------------

  @spec resolve_coding(WorkItem.t(), map(), keyword()) :: {:ok, t()} | {:error, term()}
  def resolve_coding(%WorkItem{} = work_item, runner_config, opts \\ [])
      when is_map(runner_config) do
    profile =
      supplied_profile(work_item, runner_config, opts) ||
        legacy_coding_profile(work_item, runner_config)

    with {:ok, profile} <- normalize_profile(profile),
         :ok <- validate_profile(profile, role: "coding") do
      {:ok, profile}
    end
  end

  @spec runner_module(t()) :: {:ok, module()} | {:error, term()}
  def runner_module(profile) when is_map(profile) do
    case Map.get(profile, "runner_kind") do
      "codex" -> {:ok, SymphonyElixir.Runner.Codex}
      "claude_code" -> {:ok, SymphonyElixir.Runner.ClaudeCode}
      "llm_tool_runner" -> {:ok, SymphonyElixir.Runner.LlmToolRunner}
      "manager" -> {:ok, SymphonyElixir.Runner.LlmToolRunner}
      "router" -> {:ok, SymphonyElixir.Runner.LlmToolRunner}
      "planner" -> {:ok, SymphonyElixir.Runner.Planner}
      "openclaw" -> {:ok, SymphonyElixir.Runner.OpenClaw}
      "openclaw_ws" -> {:ok, SymphonyElixir.Runner.OpenClawWS}
      "computer_use" -> {:ok, SymphonyElixir.Runner.ComputerUse}
      "local_relay" -> {:ok, SymphonyElixir.Runner.LocalRelay}
      "local_model_coding" -> {:ok, SymphonyElixir.Runner.LocalModelCoding}
      runner_kind -> {:error, {:unsupported_runner_kind, runner_kind}}
    end
  end

  @spec runner_config(t(), map()) :: map()
  def runner_config(profile, base_config \\ %{}) when is_map(profile) and is_map(base_config) do
    profile_config =
      profile
      |> Map.get("adapter_config", %{})
      |> normalize_map()
      |> maybe_put("model", Map.get(profile, "model"))
      |> maybe_put("model_provider", Map.get(profile, "provider"))
      |> maybe_put("provider", Map.get(profile, "provider"))
      |> maybe_put("agent_type", Map.get(profile, "role"))
      |> maybe_put("tool_bundle", Map.get(profile, "tool_profile"))
      |> maybe_put("credential_ref", Map.get(profile, "credential_ref"))
      |> maybe_put_target_runner_kind(profile)

    Map.merge(base_config, profile_config)
  end

  # Thread the routing rule's `provider` value into LocalRelay's
  # `target_runner_kind` config key when the provider names a helper-advertisable
  # runtime. Explicit `adapter_config.target_runner_kind` from the platform
  # always wins; `provider = "local"` or unset falls back to LocalRelay's own
  # default (`"openai_compatible"`).
  defp maybe_put_target_runner_kind(config, %{"runner_kind" => "local_relay"} = profile) do
    case local_relay_target_runner_kind(Map.get(profile, "provider")) do
      nil -> config
      target_runner_kind -> Map.put_new(config, "target_runner_kind", target_runner_kind)
    end
  end

  defp maybe_put_target_runner_kind(config, _profile), do: config

  @doc """
  The helper runner kind a `local_relay` profile's provider targets.

  Providers that name a helper-advertisable runtime map to themselves;
  `"local"`, `"openai_compatible"`, or unset return `nil` so callers fall
  back to `Runner.LocalRelay`'s default (`"openai_compatible"`).
  """
  @spec local_relay_target_runner_kind(String.t() | nil) :: String.t() | nil
  def local_relay_target_runner_kind(provider) when provider in ~w(openclaw codex computer_use),
    do: provider

  def local_relay_target_runner_kind(_provider), do: nil

  defp supplied_profile(%WorkItem{} = work_item, runner_config, opts) do
    Keyword.get(opts, :execution_profile) ||
      metadata_value(work_item.metadata, "execution_profile") ||
      metadata_value(work_item.metadata, :execution_profile) ||
      explicit_runner_config_profile(runner_config)
  end

  defp explicit_runner_config_profile(runner_config) when is_map(runner_config) do
    case Map.get(runner_config, "execution_profile") do
      %{} = profile when map_size(profile) > 0 -> profile
      _ -> nil
    end
  end

  defp explicit_runner_config_profile(_runner_config), do: nil

  defp legacy_coding_profile(%WorkItem{} = work_item, runner_config) do
    runner = Runner.resolve(work_item, runner_config)
    runner_kind = runner_kind_for(runner)
    codex = Config.settings!().codex

    %{
      "role" => "coding",
      "runner_kind" => runner_kind,
      "provider" => provider_for_runner(runner_kind, codex.model_provider),
      "model" => model_for_runner(runner_kind, codex.model),
      "credential_ref" => nil,
      "fallbacks" => [],
      "model_tier_floor" => "any",
      "tool_profile" => "coding",
      "capabilities" => %{},
      "source_metadata" => %{
        "source" => "legacy_runner_config",
        "fallback_used" => true
      }
    }
  end

  defp normalize_profile(profile) when is_map(profile) do
    normalized =
      profile
      |> stringify_keys()
      |> Map.update("source_metadata", %{}, &normalize_map/1)
      |> Map.update("capabilities", %{}, &normalize_map/1)
      |> Map.update("adapter_config", %{}, &normalize_map/1)
      |> Map.update("fallbacks", [], &normalize_fallbacks/1)
      |> Map.update("runner_kind", nil, &normalize_string/1)
      |> Map.update("role", nil, &normalize_string/1)
      |> Map.update("provider", nil, &normalize_string/1)
      |> Map.update("model", nil, &normalize_string/1)
      |> Map.update("credential_ref", nil, &normalize_string/1)
      |> Map.update("model_tier_floor", "any", &normalize_model_tier_floor/1)
      |> Map.update("tool_profile", nil, &normalize_string/1)
      |> normalize_family_runner_kind()

    {:ok, normalized}
  end

  defp normalize_profile(_profile), do: {:error, :invalid_execution_profile}

  defp validate_profile(profile, role: expected_role) do
    role = Map.get(profile, "role") || expected_role
    runner_kind = Map.get(profile, "runner_kind")

    cond do
      role != expected_role ->
        {:error, {:unsupported_profile_role, role}}

      runner_kind in [nil, ""] ->
        {:error, {:missing_execution_profile_field, "runner_kind"}}

      runner_kind not in ExecutionProfileSchema.supported_runner_kinds() ->
        {:error, {:unsupported_runner_kind, runner_kind}}

      true ->
        :ok
    end
  end

  defp runner_kind_for(SymphonyElixir.Runner.Codex), do: "codex"
  defp runner_kind_for(SymphonyElixir.Runner.ClaudeCode), do: "claude_code"
  defp runner_kind_for(SymphonyElixir.Runner.LlmToolRunner), do: "manager"
  defp runner_kind_for(SymphonyElixir.Runner.Planner), do: "planner"
  defp runner_kind_for(SymphonyElixir.Runner.OpenClaw), do: "openclaw"
  defp runner_kind_for(SymphonyElixir.Runner.OpenClawWS), do: "openclaw_ws"
  defp runner_kind_for(SymphonyElixir.Runner.ComputerUse), do: "computer_use"
  defp runner_kind_for(SymphonyElixir.Runner.LocalRelay), do: "local_relay"
  defp runner_kind_for(SymphonyElixir.Runner.LocalModelCoding), do: "local_model_coding"
  defp runner_kind_for(_runner), do: "codex"

  defp provider_for_runner("codex", nil), do: "openai_codex"
  defp provider_for_runner("codex", ""), do: "openai_codex"
  defp provider_for_runner("claude_code", nil), do: "anthropic"
  defp provider_for_runner("claude_code", ""), do: "anthropic"
  defp provider_for_runner(runner_kind, nil), do: default_provider_for_runner(runner_kind)
  defp provider_for_runner(runner_kind, ""), do: default_provider_for_runner(runner_kind)
  defp provider_for_runner(_runner_kind, provider), do: provider

  defp model_for_runner("codex", model), do: model
  defp model_for_runner("claude_code", model), do: model
  defp model_for_runner(_runner_kind, _model), do: nil

  # ---------------------------------------------------------------------------
  # normalize_from_config flow (consumed by Launcher.Server and Starter)
  # ---------------------------------------------------------------------------

  @doc """
  Normalize a (possibly empty) execution profile read from a workflow config
  map.

  Returns `{:ok, profile}` for both explicit profiles (validated against the
  supported runner/provider allowlists) and legacy fallback profiles derived
  from existing runner/codex config (which are not validated against the
  provider allowlist, since legacy configs may legitimately use providers
  outside it).
  """
  @spec normalize_from_config(map()) ::
          {:ok, t()}
          | {:error,
             {:missing_execution_profile_field, String.t()}
             | {:unsupported_execution_profile_runner, String.t()}
             | {:unsupported_execution_profile_provider, String.t()}
             | {:invalid_execution_profile_field, String.t()}}
  def normalize_from_config(config) when is_map(config) do
    case explicit_profile(config) do
      nil -> {:ok, fallback_profile(config)}
      profile -> normalize_explicit_profile(profile)
    end
  end

  @doc """
  Sanitize an arbitrary profile map by normalizing keys and redacting
  secret-shaped values.
  """
  @spec sanitize(map()) :: map()
  def sanitize(profile) when is_map(profile), do: redact_secrets(normalize_keys(profile))

  @doc """
  Returns log-friendly fields derived from a profile. Always sanitizes inputs.
  """
  @spec log_fields(map() | nil) :: map()
  def log_fields(profile) when is_map(profile) do
    profile = sanitize(profile)

    %{
      runner: Map.get(profile, "runner_kind"),
      provider: Map.get(profile, "provider"),
      model: Map.get(profile, "model"),
      profile_source: profile_source(profile)
    }
    |> Enum.reject(fn {_key, value} -> value in [nil, ""] end)
    |> Map.new()
  end

  def log_fields(_profile), do: %{}

  @doc """
  Extracts the runner kind from a profile, accepting both string and atom keys.
  """
  @spec runner_kind(map()) :: String.t() | nil
  def runner_kind(profile) when is_map(profile),
    do: normalize_string(Map.get(profile, "runner_kind") || Map.get(profile, :runner_kind))

  def runner_kind(_profile), do: nil

  defp explicit_profile(config) do
    normalize_keys(config)
    |> find_first_map(["execution_profile", "resolved_execution_profile"], [
      "runtime",
      "execution_profile"
    ])
  end

  defp find_first_map(config, top_level_keys, nested_path) do
    Enum.find_value(top_level_keys, fn key ->
      case Map.get(config, key) do
        value when is_map(value) and map_size(value) > 0 -> value
        _ -> nil
      end
    end) ||
      case get_in(config, nested_path) do
        value when is_map(value) and map_size(value) > 0 -> value
        _ -> nil
      end
  end

  defp normalize_explicit_profile(profile) when is_map(profile) do
    profile = profile |> normalize_keys() |> redact_secrets()

    runner_kind =
      profile
      |> explicit_runner_kind()
      |> normalize_family_runner_kind(Map.get(profile, "role") || Map.get(profile, "tool_profile"))

    provider =
      normalize_string(Map.get(profile, "provider") || Map.get(profile, "model_provider"))

    profile =
      profile
      |> Map.put("runner_kind", runner_kind)
      |> Map.put("provider", provider)
      |> maybe_put_normalized("model")
      |> maybe_put_normalized("role")
      |> maybe_put_normalized("tool_profile")
      |> Map.update("fallbacks", [], &normalize_fallbacks/1)
      |> Map.update("model_tier_floor", "any", &normalize_model_tier_floor/1)
      |> normalize_source_metadata()

    case ExecutionProfileSchema.validate(profile) do
      {:ok, schema_profile} -> {:ok, ExecutionProfileSchema.to_map(schema_profile)}
      {:error, changeset} -> {:error, execution_profile_error(changeset)}
    end
  end

  defp execution_profile_error(changeset) do
    cond do
      required_error?(changeset, :runner_kind) ->
        {:missing_execution_profile_field, "runner_kind"}

      required_error?(changeset, :provider) ->
        {:missing_execution_profile_field, "provider"}

      inclusion_error?(changeset, :runner_kind) ->
        {:unsupported_execution_profile_runner, field_value(changeset, :runner_kind)}

      inclusion_error?(changeset, :provider) ->
        {:unsupported_execution_profile_provider, field_value(changeset, :provider)}

      error_on?(changeset, :agent_id) ->
        {:invalid_execution_profile_field, "agent_id"}

      true ->
        {:invalid_execution_profile, changeset}
    end
  end

  defp required_error?(changeset, field),
    do: Enum.any?(Keyword.get_values(changeset.errors, field), &validation?(&1, :required))

  defp inclusion_error?(changeset, field),
    do: Enum.any?(Keyword.get_values(changeset.errors, field), &validation?(&1, :inclusion))

  defp error_on?(changeset, field), do: Keyword.has_key?(changeset.errors, field)

  defp validation?({_message, opts}, validation), do: Keyword.get(opts, :validation) == validation

  defp field_value(changeset, field),
    do: Ecto.Changeset.get_field(changeset, field) || Ecto.Changeset.get_change(changeset, field)

  defp fallback_profile(config) do
    config = normalize_keys(config)
    runner_kind = fallback_runner_kind(config)
    model = fallback_model(config)

    %{
      "runner_kind" => runner_kind,
      "provider" => fallback_provider(config, model, runner_kind),
      "model" => normalize_codex_model(model),
      "fallbacks" => [],
      "model_tier_floor" => "any",
      "role" => get_in(config, ["stored_agent", "type"]),
      "source_metadata" => %{
        "fallback_used" => true,
        "source" => "runtime_legacy_config"
      }
    }
    |> Enum.reject(fn {_key, value} -> value in [nil, ""] end)
    |> Map.new()
  end

  defp fallback_runner_kind(%{"runners" => %{"default" => default}}),
    do: normalize_string(default) || "codex"

  defp fallback_runner_kind(%{"runners" => runners}) when is_list(runners) do
    Enum.find_value(runners, "codex", fn
      %{"runner_kind" => runner_kind} -> normalize_string(runner_kind)
      %{"runner" => runner} -> normalize_string(runner)
      %{"kind" => kind} -> normalize_string(kind)
      _ -> nil
    end)
  end

  defp fallback_runner_kind(_config), do: "codex"

  defp explicit_runner_kind(profile),
    do: Map.get(profile, "runner_kind") || Map.get(profile, "runner") || Map.get(profile, "kind")

  defp normalize_family_runner_kind(%{"runner_kind" => runner_kind} = profile) do
    Map.put(
      profile,
      "runner_kind",
      normalize_family_runner_kind(
        runner_kind,
        Map.get(profile, "role") || Map.get(profile, "tool_profile")
      )
    )
  end

  defp normalize_family_runner_kind(profile), do: profile

  defp normalize_family_runner_kind(runner_kind, role) do
    runner_kind = normalize_string(runner_kind)
    role = normalize_string(role)

    case {runner_kind, role} do
      {"llm_tool_runner", "manager"} -> "manager"
      {"llm_tool_runner", "learning"} -> "manager"
      {"llm_tool_runner", "router"} -> "router"
      {"llm_tool_runner", "planning"} -> "planner"
      {"llm_tool_runner", "planner"} -> "planner"
      _ -> runner_kind
    end
  end

  defp fallback_model(%{"runners" => runners} = config) when is_list(runners) do
    Enum.find_value(runners, fn
      %{"model" => model} when is_binary(model) -> model
      _ -> nil
    end) || stored_agent_model(config)
  end

  defp fallback_model(config) do
    get_in(config, ["codex", "model"]) || stored_agent_model(config)
  end

  defp fallback_provider(config, model, runner_kind) do
    get_in(config, ["codex", "model_provider"]) ||
      runner_provider(config) ||
      stored_agent_provider(config) ||
      provider_from_model(model) ||
      default_provider_for_runner(runner_kind)
  end

  defp runner_provider(%{"runners" => runners}) when is_list(runners) do
    Enum.find_value(runners, fn
      %{"provider" => provider} when is_binary(provider) -> provider
      %{"model" => model} when is_binary(model) -> provider_from_model(model)
      _ -> nil
    end)
  end

  defp runner_provider(%{"runners" => %{} = runners}) do
    runners
    |> Map.values()
    |> Enum.find_value(fn
      %{"provider" => provider} when is_binary(provider) -> provider
      %{"model" => model} when is_binary(model) -> provider_from_model(model)
      _ -> nil
    end)
  end

  defp runner_provider(_config), do: nil

  defp stored_agent_model(config) do
    model_settings = get_in(config, ["stored_agent", "model_settings"]) || %{}
    Map.get(model_settings, "primary") || Map.get(model_settings, "model")
  end

  defp stored_agent_provider(config) do
    model_settings = get_in(config, ["stored_agent", "model_settings"]) || %{}

    Map.get(model_settings, "provider") ||
      provider_from_model(Map.get(model_settings, "primary")) ||
      provider_from_model(Map.get(model_settings, "model"))
  end

  defp default_provider_for_runner("openclaw"), do: "openclaw"
  defp default_provider_for_runner("openclaw_ws"), do: "openclaw"
  defp default_provider_for_runner("claude_code"), do: "anthropic"
  defp default_provider_for_runner("computer_use"), do: "computer_use"
  defp default_provider_for_runner("local_relay"), do: "local"
  defp default_provider_for_runner(_runner_kind), do: "openai"

  defp provider_from_model(model) when is_binary(model) do
    case String.split(model, "/", parts: 2) do
      [provider, _model] when provider != "" -> provider
      _ -> nil
    end
  end

  defp provider_from_model(_model), do: nil

  defp normalize_codex_model(model) when is_binary(model) do
    model
    |> String.trim()
    |> case do
      "" -> nil
      value -> value |> String.split("/") |> List.last()
    end
  end

  defp normalize_codex_model(_model), do: nil

  defp maybe_put_normalized(profile, key) do
    case normalize_string(Map.get(profile, key)) do
      nil -> Map.delete(profile, key)
      value -> Map.put(profile, key, value)
    end
  end

  defp normalize_source_metadata(profile) do
    case Map.get(profile, "source_metadata") do
      source when is_map(source) ->
        Map.put(profile, "source_metadata", redact_secrets(normalize_keys(source)))

      _ ->
        profile
    end
  end

  defp profile_source(%{"source_metadata" => source}) when is_map(source) do
    Map.get(source, "source") || Map.get(source, "routing_rule_id") ||
      Map.get(source, "scope_type")
  end

  defp profile_source(_profile), do: nil

  defp normalize_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) ->
        {canonical_key(Atom.to_string(key)), normalize_value(value)}

      {key, value} ->
        {canonical_key(key), normalize_value(value)}
    end)
  end

  defp canonical_key("agentId"), do: "agent_id"
  defp canonical_key("workspaceId"), do: "workspace_id"
  defp canonical_key("runnerKind"), do: "runner_kind"
  defp canonical_key("toolProfile"), do: "tool_profile"
  defp canonical_key("credentialRef"), do: "credential_ref"
  defp canonical_key("adapterConfig"), do: "adapter_config"
  defp canonical_key("sourceMetadata"), do: "source_metadata"
  defp canonical_key("modelTierFloor"), do: "model_tier_floor"
  defp canonical_key("modelProvider"), do: "model_provider"
  defp canonical_key(key), do: key

  defp normalize_fallbacks(fallbacks) when is_list(fallbacks) do
    fallbacks
    |> Enum.filter(&is_map/1)
    |> Enum.map(fn fallback ->
      fallback
      |> normalize_keys()
      |> maybe_put_normalized("provider")
      |> maybe_put_normalized("model")
    end)
  end

  defp normalize_fallbacks(_fallbacks), do: []

  defp normalize_model_tier_floor(value) do
    case normalize_string(value) do
      floor when floor in ~w(any frontier mid local) -> floor
      _ -> "any"
    end
  end

  defp normalize_value(value) when is_map(value), do: normalize_keys(value)
  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value

  defp redact_secrets(map) when is_map(map) do
    Map.new(map, fn {key, value} ->
      if secret_key?(key) do
        {key, "[REDACTED]"}
      else
        {key, redact_value(value)}
      end
    end)
  end

  defp redact_value(value) when is_map(value), do: redact_secrets(value)
  defp redact_value(value) when is_list(value), do: Enum.map(value, &redact_value/1)
  defp redact_value(value), do: value

  defp secret_key?(key) do
    normalized = key |> to_string() |> String.downcase()
    Enum.any?(@secret_key_fragments, &String.contains?(normalized, &1))
  end

  # ---------------------------------------------------------------------------
  # Shared helpers
  # ---------------------------------------------------------------------------

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), value} end)
  end

  defp normalize_map(map) when is_map(map), do: stringify_keys(map)
  defp normalize_map(_value), do: %{}

  defp normalize_string(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_string(value) when is_atom(value) and not is_nil(value),
    do: value |> Atom.to_string() |> normalize_string()

  defp normalize_string(_value), do: nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp metadata_value(metadata, key) when is_map(metadata), do: Map.get(metadata, key)
  defp metadata_value(_metadata, _key), do: nil
end
