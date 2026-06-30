defmodule SymphonyElixir.Tools.ShellExec do
  @behaviour SymphonyElixir.Tool

  alias SymphonyElixir.Runner.CodingTools.ShellExecutor

  @impl true
  def name, do: "shell.exec"

  @impl true
  def description, do: "Run an argv command in the assigned workspace."

  @impl true
  def parameters_schema do
    %{
      "type" => "object",
      "additionalProperties" => false,
      "required" => ["argv"],
      "properties" => %{
        "argv" => %{"type" => "array", "items" => %{"type" => "string"}, "minItems" => 1},
        "cwd" => %{"type" => "string"},
        "timeout_ms" => %{"type" => "integer", "minimum" => 1000, "maximum" => 600_000},
        "output_limit_bytes" => %{"type" => "integer", "minimum" => 1},
        "env" => %{"type" => "object", "additionalProperties" => %{"type" => "string"}}
      }
    }
  end

  @impl true
  def bundle, do: :coding

  @impl true
  def execution_kind, do: :runtime

  @impl true
  def execute(arguments, %{workspace_root: workspace_root} = context) when is_map(arguments) do
    ShellExecutor.run(arguments, %{
      workspace_root: workspace_root,
      command_id: context_value(arguments, "id") || Ecto.UUID.generate(),
      timeout_ms: context_value(arguments, "timeout_ms"),
      output_limit_bytes: context_value(arguments, "output_limit_bytes"),
      env_allowlist:
        context_value(arguments, "allowed_env") || context_value(arguments, "env_allowlist") ||
          context_value(context, "env_allowlist"),
      sandbox_policy: context_value(arguments, "sandbox_policy"),
      on_event: context_value(context, "on_event")
    })
    |> normalize_shell_result(workspace_root, arguments)
  end

  def execute(_arguments, _context), do: {:error, :invalid_local_model_coding_context}

  defp normalize_shell_result({:ok, result}, workspace_root, arguments) do
    result =
      result
      |> Map.put("tool", name())
      |> Map.put("status", if(result["success"], do: "completed", else: "failed"))
      |> Map.put("workspace_root", workspace_root)
      |> Map.put("argv", context_value(arguments, "argv"))
      |> Map.put("exit_code", result["exit_status"])
      |> Map.put_new("output", result["stdout"] || "")

    {:ok, %{output: result}}
  end

  defp normalize_shell_result(error, _workspace_root, _arguments), do: error

  defp context_value(map, key) when is_map(map), do: Map.get(map, key) || Map.get(map, atom_key(key))
  defp context_value(_map, _key), do: nil

  defp atom_key("allowed_env"), do: :allowed_env
  defp atom_key("env_allowlist"), do: :env_allowlist
  defp atom_key("id"), do: :id
  defp atom_key("on_event"), do: :on_event
  defp atom_key("output_limit_bytes"), do: :output_limit_bytes
  defp atom_key("sandbox_policy"), do: :sandbox_policy
  defp atom_key("timeout_ms"), do: :timeout_ms
  defp atom_key("argv"), do: :argv
  defp atom_key(_key), do: nil
end
