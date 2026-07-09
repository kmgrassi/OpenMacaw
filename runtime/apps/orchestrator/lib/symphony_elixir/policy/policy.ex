defmodule SymphonyElixir.Policy.Policy do
  @moduledoc """
  Normalization helpers for runtime session policies.
  """

  @type scope :: :session | :agent | :workspace
  @type t :: %{
          optional(:id) => String.t(),
          required(:scope) => scope(),
          required(:kind) => String.t(),
          required(:params) => map(),
          required(:priority) => integer(),
          required(:enabled) => boolean()
        }

  @scope_order %{session: 0, agent: 1, workspace: 2}

  @spec normalize_many(term()) :: [t()]
  def normalize_many(policies) when is_list(policies) do
    policies
    |> Enum.flat_map(fn policy ->
      case normalize(policy) do
        {:ok, normalized} -> [normalized]
        :error -> []
      end
    end)
    |> Enum.filter(& &1.enabled)
    |> Enum.sort_by(fn policy -> {Map.fetch!(@scope_order, policy.scope), policy.priority} end)
  end

  def normalize_many(_policies), do: []

  @spec normalize(term()) :: {:ok, t()} | :error
  def normalize(policy) when is_map(policy) do
    with {:ok, scope} <- scope(map_value(policy, :scope)),
         {:ok, kind} <- non_empty_string(map_value(policy, :kind)),
         {:ok, params} <- params(map_value(policy, :params)) do
      {:ok,
       %{
         id: map_value(policy, :id),
         scope: scope,
         kind: kind,
         params: params,
         priority: integer(map_value(policy, :priority), 0),
         enabled: enabled?(map_value(policy, :enabled))
       }}
    end
  end

  def normalize(_policy), do: :error

  @spec scope(term()) :: {:ok, scope()} | :error
  def scope("session"), do: {:ok, :session}
  def scope(:session), do: {:ok, :session}
  def scope("agent"), do: {:ok, :agent}
  def scope(:agent), do: {:ok, :agent}
  def scope("workspace"), do: {:ok, :workspace}
  def scope(:workspace), do: {:ok, :workspace}
  def scope(_scope), do: :error

  defp non_empty_string(value) when is_binary(value) and value != "", do: {:ok, value}
  defp non_empty_string(_value), do: :error

  defp params(value) when is_map(value), do: {:ok, value}
  defp params(_value), do: {:ok, %{}}

  defp integer(value, _default) when is_integer(value), do: value

  defp integer(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, ""} -> parsed
      _ -> default
    end
  end

  defp integer(_value, default), do: default

  defp enabled?(false), do: false
  defp enabled?("false"), do: false
  defp enabled?(0), do: false
  defp enabled?(_value), do: true

  defp map_value(map, key) when is_map(map) do
    cond do
      Map.has_key?(map, key) -> Map.get(map, key)
      Map.has_key?(map, to_string(key)) -> Map.get(map, to_string(key))
      true -> nil
    end
  end
end
