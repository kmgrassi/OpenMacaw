defmodule SymphonyElixir.AgentInventory.Agent do
  @moduledoc """
  Canonical launcher-side representation of an `agent` row from Supabase.
  """

  @coding "coding"
  @planning "planning"
  @learning "learning"
  @custom "custom"
  @supported_kinds ~w(coding planning manager learning router custom)

  @type kind :: String.t()

  @type t :: %__MODULE__{
          id: String.t() | nil,
          name: String.t() | nil,
          workspace_id: String.t() | nil,
          created_by_user_id: String.t() | nil,
          project_id: String.t() | nil,
          description: String.t() | nil,
          slug: String.t() | nil,
          status: String.t() | nil,
          type: kind(),
          session_id: String.t() | nil,
          model_settings: map(),
          tool_policy: map(),
          context: String.t() | nil,
          is_active: boolean() | nil,
          has_credentials: boolean(),
          inserted_at: String.t() | nil,
          updated_at: String.t() | nil
        }

  defstruct [
    :id,
    :name,
    :workspace_id,
    :created_by_user_id,
    :project_id,
    :description,
    :slug,
    :status,
    :type,
    :session_id,
    :context,
    :is_active,
    model_settings: %{},
    tool_policy: %{},
    has_credentials: false,
    inserted_at: nil,
    updated_at: nil
  ]

  @spec from_row(map(), keyword()) :: t()
  def from_row(row, opts \\ []) when is_map(row) do
    %__MODULE__{
      id: string_field(row, "id"),
      name: string_field(row, "name"),
      workspace_id: string_field(row, "workspace_id"),
      created_by_user_id: string_field(row, "created_by_user_id"),
      project_id: string_field(row, "project_id"),
      description: string_field(row, "description"),
      slug: string_field(row, "slug"),
      status: string_field(row, "status"),
      type: normalize_type(string_field(row, "type")),
      session_id: string_field(row, "session_id"),
      context: string_field(row, "context"),
      is_active: boolean_field(row, "is_active"),
      model_settings: map_field(row, ["model_settings"]),
      tool_policy: map_field(row, ["tool_policy"]),
      has_credentials: Keyword.get(opts, :has_credentials, false),
      inserted_at: string_field(row, "created_at"),
      updated_at: string_field(row, "updated_at")
    }
  end

  @spec to_public_map(t()) :: map()
  def to_public_map(%__MODULE__{} = agent) do
    %{
      id: agent.id,
      name: agent.name || agent.id,
      workspace_id: agent.workspace_id,
      created_by_user_id: agent.created_by_user_id,
      project_id: agent.project_id,
      description: agent.description,
      slug: agent.slug,
      status: agent.status,
      type: kind(agent),
      session_id: agent.session_id,
      context: agent.context,
      is_active: agent.is_active,
      model_settings: agent.model_settings,
      tool_policy: agent.tool_policy,
      has_credentials: agent.has_credentials,
      created_at: agent.inserted_at,
      updated_at: agent.updated_at
    }
  end

  @spec kind(t() | map() | String.t() | nil) :: kind()
  def kind(%__MODULE__{type: type}), do: normalize_type(type)
  def kind(%{} = agent), do: normalize_type(fetch_key(agent, "type"))
  def kind(type) when is_binary(type), do: normalize_type(type)
  def kind(_), do: @coding

  @spec coding?(t() | map() | String.t() | nil) :: boolean()
  def coding?(agent), do: kind(agent) == @coding

  @spec planning?(t() | map() | String.t() | nil) :: boolean()
  def planning?(agent), do: kind(agent) == @planning

  @spec learning?(t() | map() | String.t() | nil) :: boolean()
  def learning?(agent), do: kind(agent) == @learning

  @spec custom?(t() | map() | String.t() | nil) :: boolean()
  def custom?(agent), do: kind(agent) == @custom

  @spec kind?(t() | map() | String.t() | nil, String.t()) :: boolean()
  def kind?(agent, kind) when is_binary(kind), do: kind(agent) == normalize_type(kind)

  defp string_field(row, key) do
    case fetch_key(row, key) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp normalize_type(value) when is_binary(value) do
    case String.trim(value) do
      "" -> @coding
      kind when kind in @supported_kinds -> kind
      _other -> @coding
    end
  end

  defp normalize_type(_value), do: @coding

  defp boolean_field(row, key) do
    case fetch_key(row, key) do
      value when is_boolean(value) -> value
      _ -> nil
    end
  end

  defp map_field(row, keys) do
    Enum.find_value(keys, %{}, fn key ->
      case fetch_key(row, key) do
        value when is_map(value) -> value
        _ -> nil
      end
    end)
  end

  defp fetch_key(row, key) do
    case Map.fetch(row, key) do
      {:ok, value} ->
        value

      :error ->
        Map.get(row, String.to_atom(key))
    end
  rescue
    ArgumentError -> Map.get(row, key)
  end
end
