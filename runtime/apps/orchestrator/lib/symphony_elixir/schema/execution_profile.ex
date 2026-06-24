defmodule SymphonyElixir.Schema.ExecutionProfile.CredentialRef do
  @moduledoc false

  use Ecto.Type

  @impl Ecto.Type
  def type, do: :map

  @impl Ecto.Type
  def cast(value) when is_binary(value) or is_map(value), do: {:ok, value}
  def cast(nil), do: {:ok, nil}
  def cast(_value), do: :error

  @impl Ecto.Type
  def load(value), do: cast(value)

  @impl Ecto.Type
  def dump(value), do: cast(value)
end

defmodule SymphonyElixir.Schema.ExecutionProfile do
  @moduledoc """
  Validated wire schema for platform-provided execution profiles.

  ## Runner kind vocabulary

  `@supported_runner_kinds` is the canonical runtime-internal vocabulary
  for execution profiles. Platform routing-rule values that are role or
  transport aliases must be normalized before this schema validates them:

  | Platform writes (routing_rule.runner_kind) | Runtime expects after normalization |
  |---|---|
  | `codex` | `codex` |
  | `claude_code` | `claude_code` |
  | `openclaw` | `openclaw` |
  | `openclaw_ws` | `openclaw_ws` |
  | `openclaw_http_sse` | unsupported platform-only transport alias |
  | `local_model_coding` | `local_model_coding` |
  | `local_relay` | `local_relay` |
  | `computer_use` | `computer_use` |
  | `llm_tool_runner` (role=coding) | `llm_tool_runner` |
  | `llm_tool_runner` (role=manager/learning) | `manager` |
  | `llm_tool_runner` (role=router) | `router` |
  | `llm_tool_runner` (role=planning) | `planner` |
  | `planner` | `planner` |

  `SymphonyElixir.ExecutionProfile.normalize_family_runner_kind/2`
  (in `lib/symphony_elixir/execution_profile.ex`) maps platform → runtime.
  The platform values that are **not** in `@supported_runner_kinds`
  (`openclaw_http_sse`, `llm_tool_runner`)
  reach this schema in two ways:

  1. **Validated path** (`Launcher.AgentStarter` → `normalize_from_config/1`
     in execution_profile.ex). `llm_tool_runner` is mapped to `manager` /
     `planner` by the normalizer before reaching `validate/1`, so it passes.
     `openclaw_http_sse` passes through the normalizer unchanged and **would
     fail** this validation if it reached it via the explicit-profile
     path. Today it doesn't — see #2.
  2. **Routing-rule path** (`Gateway.AgentExecutionProfile` reading
     `routing_rule` rows). This path now instantiates this schema directly,
     so routing-rule rows must already contain canonical runtime runner kinds
     such as `manager` or `planner`.

  The cross-repo enum drift CI check
  (parallel-agent-platform `scripts/check-cross-repo-enums.mjs`)
  understands this mapping — it asserts every platform `RUNNER_KINDS`
  value is in `@supported_runner_kinds` *or* is a known input to
  `normalize_family_runner_kind`. When adding a new runner_kind:

  - If it's already runtime-internal-shaped, add it here.
  - If it's a platform-facing alias for an existing runtime kind, add
    the mapping to `normalize_family_runner_kind/2`.
  - Update `RUNNER_KINDS` in the platform's `contracts/runner-kinds.ts`
    and the matching `routing_rule_runner_kind_check` in harper-server.

  ## Provider vocabulary

  `@supported_providers` mirrors the platform's `KNOWN_EXECUTION_PROVIDER_IDS`
  in `contracts/provider-registry.ts` and is enforced by the cross-repo
  drift check.
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key false

  @supported_runner_kinds ~w(codex claude_code openclaw openclaw_ws computer_use llm_tool_runner manager planner router local_relay local_model_coding)
  @supported_providers ~w(openai openai_codex codex anthropic openai_compatible openclaw computer_use local)

  embedded_schema do
    field(:agent_id, :string)
    field(:workspace_id, :string)
    field(:runner_kind, :string)
    field(:provider, :string)
    field(:model, :string)
    field(:role, :string)
    field(:tool_profile, :string)
    field(:credential_ref, SymphonyElixir.Schema.ExecutionProfile.CredentialRef)
    field(:fallbacks, {:array, :map}, default: [])
    field(:model_tier_floor, :string, default: "any")
    field(:adapter_config, :map, default: %{})
    field(:capabilities, :map, default: %{})
    field(:source_metadata, :map, default: %{})
    field(:raw, :map, default: %{})
  end

  @type t :: %__MODULE__{
          agent_id: String.t() | nil,
          workspace_id: String.t() | nil,
          runner_kind: String.t(),
          provider: String.t(),
          model: String.t() | nil,
          role: String.t() | nil,
          tool_profile: String.t() | nil,
          credential_ref: String.t() | map() | nil,
          fallbacks: [map()],
          model_tier_floor: String.t(),
          adapter_config: map(),
          capabilities: map(),
          source_metadata: map(),
          raw: map()
        }

  @spec validate(map()) :: {:ok, t()} | {:error, Ecto.Changeset.t()}
  def validate(attrs) when is_map(attrs) do
    attrs = normalize_attrs(attrs)

    %__MODULE__{}
    |> cast(attrs, __schema__(:fields))
    |> validate_required([:runner_kind, :provider])
    |> validate_inclusion(:runner_kind, @supported_runner_kinds)
    |> validate_inclusion(:provider, @supported_providers)
    |> validate_inclusion(:model_tier_floor, SymphonyElixir.ModelTiers.supported_floors())
    |> apply_action(:validate)
  end

  @spec validate(term()) :: {:error, Ecto.Changeset.t()}
  def validate(_attrs) do
    %__MODULE__{}
    |> change()
    |> add_error(:base, "must be a map")
    |> apply_action(:validate)
  end

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{raw: raw}) when is_map(raw), do: raw

  @spec supported_runner_kinds() :: [String.t()]
  def supported_runner_kinds, do: @supported_runner_kinds

  @spec supported_providers() :: [String.t()]
  def supported_providers, do: @supported_providers

  defp normalize_attrs(attrs) do
    attrs
    |> normalize_keys()
    |> normalize_string_fields([
      "agent_id",
      "workspace_id",
      "runner_kind",
      "provider",
      "model",
      "role",
      "tool_profile",
      "model_tier_floor"
    ])
    |> normalize_fallbacks()
    |> normalize_map_field("adapter_config")
    |> normalize_map_field("capabilities")
    |> normalize_map_field("source_metadata")
    |> then(&Map.put(&1, "raw", &1))
  end

  defp normalize_keys(map) when is_map(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {canonical_key(Atom.to_string(key)), normalize_value(value)}
      {key, value} -> {canonical_key(key), normalize_value(value)}
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

  defp normalize_fallbacks(attrs) do
    case Map.get(attrs, "fallbacks") do
      fallbacks when is_list(fallbacks) ->
        Map.put(attrs, "fallbacks", Enum.filter(fallbacks, &is_map/1))

      nil ->
        attrs

      _value ->
        Map.put(attrs, "fallbacks", [])
    end
  end

  defp normalize_value(value) when is_map(value), do: normalize_keys(value)
  defp normalize_value(value) when is_list(value), do: Enum.map(value, &normalize_value/1)
  defp normalize_value(value), do: value

  defp normalize_string_fields(attrs, fields) do
    Enum.reduce(fields, attrs, fn field, acc ->
      case Map.get(acc, field) do
        value when is_binary(value) or is_atom(value) ->
          case normalize_string(value) do
            nil -> Map.delete(acc, field)
            normalized -> Map.put(acc, field, normalized)
          end

        nil ->
          acc

        value ->
          Map.put(acc, field, value)
      end
    end)
  end

  defp normalize_map_field(attrs, field) do
    case Map.get(attrs, field) do
      value when is_map(value) -> Map.put(attrs, field, value)
      nil -> attrs
      _value -> Map.delete(attrs, field)
    end
  end

  defp normalize_string(value) when is_binary(value) do
    value = String.trim(value)
    if value == "", do: nil, else: value
  end

  defp normalize_string(value) when is_atom(value) and not is_nil(value),
    do: value |> Atom.to_string() |> normalize_string()

  defp normalize_string(_value), do: nil
end
