defmodule SymphonyElixir.WorkerBridge.RepositoryManager.Resources do
  @moduledoc false

  alias SymphonyElixir.WorkerBridge.RepositoryManager.Metadata

  @spec normalize_resources(
          [map()],
          (String.t() -> {:ok, String.t()} | {:error, term()}),
          Regex.t()
        ) :: {:ok, [map()]} | {:error, term()}
  def normalize_resources(resources, normalize_repository_url, alias_pattern)
      when is_list(resources) and is_function(normalize_repository_url, 1) do
    case resources do
      [] ->
        {:error, :invalid_resources}

      _ ->
        resources
        |> Enum.reduce_while({:ok, [], MapSet.new()}, fn resource, {:ok, acc, aliases} ->
          with {:ok, normalized} <-
                 normalize_resource(resource, normalize_repository_url, alias_pattern),
               alias_value = normalized["alias"],
               false <- MapSet.member?(aliases, alias_value) do
            {:cont, {:ok, [normalized | acc], MapSet.put(aliases, alias_value)}}
          else
            true -> {:halt, {:error, {:duplicate_resource_alias, Map.get(resource, "alias")}}}
            {:error, reason} -> {:halt, {:error, reason}}
          end
        end)
        |> case do
          {:ok, normalized, _aliases} -> {:ok, Enum.reverse(normalized)}
          {:error, reason} -> {:error, reason}
        end
    end
  end

  @spec create_workspace(Path.t(), [map()], String.t()) :: {:ok, Path.t()} | {:error, term()}
  def create_workspace(session_root, resources, session_id)
      when is_binary(session_root) and is_list(resources) and is_binary(session_id) do
    File.mkdir_p!(session_root)
    workspace_path = Path.join(session_root, session_slug("resources", session_id))
    resources_path = Path.join(workspace_path, "resources")
    File.rm_rf!(workspace_path)
    File.mkdir_p!(resources_path)

    resources
    |> Enum.map(&Path.join(resources_path, &1["alias"]))
    |> Enum.reduce_while(:ok, fn path, :ok ->
      case assert_child_path(path, resources_path) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      :ok -> {:ok, workspace_path}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec materialize_resources(Path.t(), [map()], keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def materialize_resources(workspace_path, resources, opts)
      when is_binary(workspace_path) and is_list(resources) and is_list(opts) do
    resources_root = Path.join(workspace_path, "resources")

    resources
    |> Enum.reduce_while({:ok, []}, fn resource, {:ok, statuses} ->
      status = materialize_resource(resources_root, resource, opts)
      updated_statuses = [status | statuses]

      cond do
        status["status"] == "available" ->
          {:cont, {:ok, updated_statuses}}

        resource_required?(resource) ->
          {:halt, {:error, {:required_resource_unavailable, resource["alias"], status["error"], Enum.reverse(updated_statuses)}}}

        true ->
          {:cont, {:ok, updated_statuses}}
      end
    end)
    |> case do
      {:ok, statuses} -> {:ok, Enum.reverse(statuses)}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec assert_child_path(Path.t(), Path.t()) :: :ok | {:error, term()}
  def assert_child_path(path, root) do
    expanded_path = Path.expand(path)
    expanded_root = Path.expand(root)

    if String.starts_with?(expanded_path <> "/", expanded_root <> "/"),
      do: :ok,
      else: {:error, {:resource_path_outside_workspace, expanded_path, expanded_root}}
  end

  @spec resource_required?(map()) :: boolean()
  def resource_required?(%{"required" => false}), do: false
  def resource_required?(%{"required" => "false"}), do: false
  def resource_required?(_resource), do: true

  defp normalize_resource(%{"url" => url, "alias" => alias_value} = resource, normalize_repository_url, alias_pattern)
       when is_binary(url) and is_binary(alias_value) do
    with {:ok, normalized_url} <- normalize_repository_url.(url),
         {:ok, alias_value} <- normalize_alias(alias_value, alias_pattern) do
      {:ok,
       resource
       |> Map.put("url", normalized_url)
       |> Map.put("alias", alias_value)
       |> Map.put_new("required", true)}
    end
  end

  defp normalize_resource(_resource, _normalize_repository_url, _alias_pattern),
    do: {:error, :invalid_resource}

  defp normalize_alias(alias_value, alias_pattern) when is_binary(alias_value) do
    alias_value = String.trim(alias_value)

    if String.match?(alias_value, alias_pattern),
      do: {:ok, alias_value},
      else: {:error, {:invalid_resource_alias, alias_value}}
  end

  defp materialize_resource(resources_root, resource, opts) do
    alias_value = resource["alias"]
    target_path = Path.join(resources_root, alias_value)
    sanitized_url = Keyword.fetch!(opts, :sanitize_url).(resource["url"])

    base_status = %{
      "resource_id" => Map.get(resource, "resource_id") || Map.get(resource, "id"),
      "grant_id" => Map.get(resource, "grant_id") || get_in(resource, ["grant", "id"]),
      "alias" => alias_value,
      "path" => target_path,
      "kind" => Map.get(resource, "kind", "repository"),
      "provider" => Map.get(resource, "provider", "git"),
      "locator" => sanitized_url,
      "ref" => Map.get(resource, "ref"),
      "required" => resource_required?(resource),
      "credential_ref" => Map.get(resource, "credential_ref") || get_in(resource, ["grant", "credential_ref"])
    }

    with :ok <- assert_child_path(target_path, resources_root),
         repo_id <- Keyword.fetch!(opts, :repo_id).(sanitized_url),
         {:ok, credential} <- Keyword.fetch!(opts, :resolve_credential).(resource),
         {:ok, cache_result} <-
           Keyword.fetch!(opts, :ensure_mirror_cache).(resource, resource["url"], repo_id, credential),
         {:ok, _materialization_method} <-
           Keyword.fetch!(opts, :clone_checkout).(cache_result.cache_path, target_path, resource) do
      Map.merge(base_status, %{
        "status" => "available",
        "commit" => Keyword.fetch!(opts, :workspace_revision).(target_path),
        "error" => nil
      })
    else
      {:error, reason} ->
        Map.merge(base_status, %{
          "status" => "unavailable",
          "commit" => nil,
          "error" => Metadata.safe_error(reason, resource["url"])
        })
    end
  end

  defp session_slug(repo_id, session_id) do
    "#{repo_id}-#{session_id}"
  end
end
