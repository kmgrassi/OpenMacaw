defmodule SymphonyElixir.Runner.SkillMaterializer do
  @moduledoc """
  Materializes approved DB-backed agent skills into runner-native skill folders.

  The materializer tracks only files it wrote in a workspace-local manifest, so
  repository-owned `.codex/skills` or `.claude/skills` entries are left alone.
  """

  alias SymphonyElixir.PathSafety

  @manifest_dir ".openmacaw/materialized-skills"
  @supported_runners %{
    "codex" => ".codex/skills",
    "claude_code" => ".claude/skills"
  }
  @name_pattern ~r/^[a-z0-9-]+$/

  @spec materialize(String.t(), map(), String.t() | nil) :: :ok | {:error, term()}
  def materialize(runner_kind, config, workspace) when is_binary(runner_kind) and is_map(config) do
    with {:ok, target_relative} <- target_relative(runner_kind),
         {:ok, root} <- workspace_root(workspace),
         {:ok, skills} <- skills(config),
         {:ok, target_dir} <- safe_join(root, target_relative),
         {:ok, manifest_path} <- safe_join(root, Path.join(@manifest_dir, "#{runner_kind}.json")),
         :ok <- File.mkdir_p(target_dir),
         :ok <- File.mkdir_p(Path.dirname(manifest_path)),
         :ok <- remove_stale_materialized_skills(root, target_relative, manifest_path, skills),
         :ok <- write_skills(target_dir, skills),
         :ok <- write_manifest(manifest_path, target_relative, skills) do
      :ok
    end
  end

  def materialize(_runner_kind, _config, _workspace), do: :ok

  defp target_relative(runner_kind) do
    case Map.fetch(@supported_runners, runner_kind) do
      {:ok, target} -> {:ok, target}
      :error -> {:error, {:unsupported_skill_runner, runner_kind}}
    end
  end

  defp workspace_root(workspace) when is_binary(workspace) and workspace != "" do
    workspace
    |> Path.expand()
    |> PathSafety.canonicalize()
  end

  defp workspace_root(_workspace), do: {:error, :missing_workspace}

  defp skills(config) do
    snapshot =
      config_value(config, "skills_snapshot") ||
        config_value(config, "skillsSnapshot") ||
        config_value(config, ["runner_config", "skills_snapshot"]) ||
        %{}

    raw_skills =
      case snapshot do
        %{} -> config_value(snapshot, "skills") || []
        _ -> []
      end

    raw_skills
    |> Enum.reduce_while({:ok, []}, fn raw, {:ok, acc} ->
      case normalize_skill(raw) do
        {:ok, skill} -> {:cont, {:ok, [skill | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, normalized} -> {:ok, Enum.reverse(normalized)}
      {:error, _reason} = error -> error
    end
  end

  defp normalize_skill(raw) when is_map(raw) do
    name = string_field(raw, "name")
    body = string_field(raw, "body")

    cond do
      not Regex.match?(@name_pattern, name) ->
        {:error, {:invalid_skill_name, name}}

      body == "" ->
        {:error, {:invalid_skill_body, name}}

      true ->
        {:ok,
         %{
           "id" => string_field(raw, "id"),
           "name" => name,
           "description" => string_field(raw, "description"),
           "body" => body,
           "updatedAt" => string_field(raw, "updatedAt")
         }}
    end
  end

  defp normalize_skill(_raw), do: {:error, :invalid_skill_snapshot}

  defp remove_stale_materialized_skills(root, target_relative, manifest_path, current_skills) do
    current_names = MapSet.new(current_skills, &Map.fetch!(&1, "name"))

    manifest_path
    |> read_manifest()
    |> Enum.reject(fn entry -> Map.get(entry, "name") in current_names end)
    |> Enum.reduce_while(:ok, fn entry, :ok ->
      case stale_skill_path(root, target_relative, entry) do
        {:ok, path} ->
          _ = File.rm_rf(path)
          {:cont, :ok}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
  end

  defp write_skills(target_dir, skills) do
    Enum.reduce_while(skills, :ok, fn skill, :ok ->
      skill_dir = Path.join(target_dir, Map.fetch!(skill, "name"))

      with :ok <- File.mkdir_p(skill_dir),
           :ok <- File.write(Path.join(skill_dir, "SKILL.md"), skill_markdown(skill)) do
        {:cont, :ok}
      else
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp write_manifest(manifest_path, target_relative, skills) do
    manifest = %{
      "version" => 1,
      "target" => target_relative,
      "skills" =>
        Enum.map(skills, fn skill ->
          %{
            "id" => Map.get(skill, "id"),
            "name" => Map.fetch!(skill, "name"),
            "path" => Path.join([target_relative, Map.fetch!(skill, "name")])
          }
        end)
    }

    File.write(manifest_path, Jason.encode!(manifest, pretty: true))
  end

  defp read_manifest(path) do
    with {:ok, body} <- File.read(path),
         {:ok, %{"skills" => skills}} when is_list(skills) <- Jason.decode(body) do
      skills
    else
      _ -> []
    end
  end

  defp stale_skill_path(root, target_relative, %{"path" => relative, "name" => name})
       when is_binary(relative) and is_binary(name) do
    with :ok <- validate_skill_name(name),
         :ok <- validate_managed_relative_path(target_relative, relative, name) do
      safe_join(root, relative)
    end
  end

  defp stale_skill_path(root, target_relative, %{"name" => name}) when is_binary(name) do
    with :ok <- validate_skill_name(name) do
      safe_join(root, Path.join(target_relative, name))
    end
  end

  defp stale_skill_path(_root, _target_relative, _entry), do: {:error, :invalid_skill_manifest}

  defp validate_skill_name(name) do
    if Regex.match?(@name_pattern, name), do: :ok, else: {:error, {:invalid_skill_name, name}}
  end

  defp validate_managed_relative_path(target_relative, relative, name) do
    expected = Path.join(target_relative, name)

    if relative == expected do
      :ok
    else
      {:error, {:invalid_skill_manifest_path, relative}}
    end
  end

  defp safe_join(root, relative) when is_binary(relative) do
    path = Path.expand(relative, root)

    if path_inside?(path, root) do
      {:ok, path}
    else
      {:error, {:skill_path_escape, relative}}
    end
  end

  defp path_inside?(path, root), do: path == root or String.starts_with?(path, root <> "/")

  defp skill_markdown(skill) do
    """
    ---
    name: #{yaml_string(Map.fetch!(skill, "name"))}
    description: #{yaml_string(Map.get(skill, "description", ""))}
    ---

    #{Map.fetch!(skill, "body")}
    """
  end

  defp yaml_string(value) do
    value
    |> to_string()
    |> String.replace("\\", "\\\\")
    |> String.replace("\"", "\\\"")
    |> then(&"\"#{&1}\"")
  end

  defp config_value(config, [key]) when is_map(config), do: config_value(config, key)

  defp config_value(config, [key | rest]) when is_map(config) do
    case config_value(config, key) do
      nested when is_map(nested) -> config_value(nested, rest)
      _ -> nil
    end
  end

  defp config_value(config, key) when is_map(config) and is_binary(key) do
    atom_key = key |> Macro.underscore() |> String.to_atom()
    Map.get(config, key) || Map.get(config, atom_key)
  end

  defp config_value(_config, _key), do: nil

  defp string_field(map, key) do
    case config_value(map, key) do
      value when is_binary(value) -> String.trim(value)
      _ -> ""
    end
  end
end
