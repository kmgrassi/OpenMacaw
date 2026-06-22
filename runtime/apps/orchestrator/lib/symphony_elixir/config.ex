defmodule SymphonyElixir.Config do
  @moduledoc """
  Runtime configuration loaded from `WORKFLOW.md`.
  """

  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.Codex.ToolPolicy
  alias SymphonyElixir.WorkspaceSettings
  alias SymphonyElixir.Workflow
  alias SymphonyElixirWeb.Endpoint

  @default_prompt_template """
  You are working on a Linear issue.

  Identifier: {{ issue.identifier }}
  Title: {{ issue.title }}

  Body:
  {% if issue.description %}
  {{ issue.description }}
  {% else %}
  No description provided.
  {% endif %}
  """

  @type codex_runtime_settings :: %{
          approval_policy: String.t() | map(),
          model: String.t() | nil,
          model_provider: String.t() | nil,
          agent_kind: String.t(),
          dynamic_tool_specs: [map()],
          dynamic_tool_names: [String.t()],
          thread_sandbox: String.t(),
          turn_sandbox_policy: map()
        }

  @spec settings() :: {:ok, Schema.t()} | {:error, term()}
  def settings do
    case Workflow.current() do
      {:ok, %{config: config}} when is_map(config) ->
        Schema.parse(config)

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec settings!() :: Schema.t()
  def settings! do
    case settings() do
      {:ok, settings} ->
        settings

      {:error, reason} ->
        raise ArgumentError, message: format_config_error(reason)
    end
  end

  @spec max_concurrent_agents_for_state(term()) :: pos_integer()
  def max_concurrent_agents_for_state(state_name) when is_binary(state_name) do
    config = settings!()

    Map.get(
      config.agent.max_concurrent_agents_by_state,
      Schema.normalize_issue_state(state_name),
      config.agent.max_concurrent_agents
    )
  end

  def max_concurrent_agents_for_state(_state_name), do: settings!().agent.max_concurrent_agents

  @spec runtime_workspace_id(Schema.t() | nil) :: String.t() | nil
  def runtime_workspace_id(settings \\ nil) do
    settings = settings || settings!()

    first_present([
      settings.stored_agent.workspace_id,
      settings.tracker.workspace_id
    ])
  end

  @spec workspace_max_concurrent_agents(String.t(), keyword()) :: {:ok, pos_integer()} | {:error, term()}
  def workspace_max_concurrent_agents(workspace_id, opts \\ [])

  def workspace_max_concurrent_agents(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    repository = workspace_settings_repository()

    if repository_configured?(repository, opts) do
      repository.max_concurrent_agents(workspace_id, opts)
    else
      {:ok, WorkspaceSettings.Repository.default_max_concurrent_agents()}
    end
  end

  def workspace_max_concurrent_agents(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec codex_turn_sandbox_policy(Path.t() | nil) :: map()
  def codex_turn_sandbox_policy(workspace \\ nil) do
    case Schema.resolve_runtime_turn_sandbox_policy(settings!(), workspace) do
      {:ok, policy} ->
        policy

      {:error, reason} ->
        raise ArgumentError, message: "Invalid codex turn sandbox policy: #{inspect(reason)}"
    end
  end

  @spec workflow_prompt() :: String.t()
  def workflow_prompt do
    case Workflow.current() do
      {:ok, %{prompt_template: prompt}} ->
        if String.trim(prompt) == "", do: @default_prompt_template, else: prompt

      _ ->
        @default_prompt_template
    end
  end

  @spec server_port() :: non_neg_integer() | nil
  def server_port do
    case Application.get_env(:symphony_elixir, :server_port_override) do
      port when is_integer(port) and port >= 0 -> port
      _ -> Endpoint.relay_socket_port_from_env() || settings!().server.port || relay_socket_default_port()
    end
  end

  defp relay_socket_default_port do
    case Application.get_env(:symphony_elixir, :relay_socket_default_port) do
      port when is_integer(port) and port >= 0 -> port
      _ -> nil
    end
  end

  @spec runner_config() :: map()
  def runner_config do
    settings = settings!()
    runners = settings.runners
    execution_profile = settings.execution_profile

    %{
      "default" => runners.default,
      "codex" => runners.codex,
      "llm_tool_runner" => runners.llm_tool_runner,
      "planner" => runners.planner,
      "openclaw" => runners.openclaw,
      "openclaw_ws" => runners.openclaw_ws,
      "computer_use" => runners.computer_use,
      "local_relay" => runners.local_relay,
      "local_model_coding" => runners.local_model_coding,
      "execution_profile" => execution_profile || %{}
    }
  end

  @spec validate!() :: :ok | {:error, term()}
  def validate! do
    with {:ok, settings} <- settings() do
      validate_semantics(settings)
    end
  end

  @spec codex_runtime_settings(Path.t() | nil, keyword()) ::
          {:ok, codex_runtime_settings()} | {:error, term()}
  def codex_runtime_settings(workspace \\ nil, opts \\ []) do
    with {:ok, settings} <- settings() do
      with {:ok, turn_sandbox_policy} <-
             Schema.resolve_runtime_turn_sandbox_policy(settings, workspace, opts) do
        runtime_settings = %{
          approval_policy: settings.codex.approval_policy,
          model: settings.codex.model,
          model_provider: settings.codex.model_provider,
          thread_sandbox: settings.codex.thread_sandbox,
          turn_sandbox_policy: turn_sandbox_policy
        }

        policy_settings =
          ToolPolicy.resolve(
            settings.stored_agent.type,
            settings.stored_agent.tool_policy,
            runtime_settings
          )

        {:ok, Map.merge(runtime_settings, policy_settings)}
      end
    end
  end

  @supported_tracker_kinds ~w(linear memory database github api)

  defp validate_semantics(settings) do
    cond do
      is_nil(settings.tracker.kind) ->
        {:error, :missing_tracker_kind}

      settings.tracker.kind not in @supported_tracker_kinds ->
        {:error, {:unsupported_tracker_kind, settings.tracker.kind}}

      true ->
        validate_tracker_kind(settings.tracker)
    end
  end

  defp validate_tracker_kind(%{kind: "linear"} = tracker) do
    cond do
      not is_binary(tracker.api_key) ->
        {:error, :missing_linear_api_token}

      not is_binary(tracker.project_slug) ->
        {:error, :missing_linear_project_slug}

      true ->
        :ok
    end
  end

  defp validate_tracker_kind(%{kind: "database"} = tracker) do
    cond do
      not is_binary(tracker.endpoint) ->
        {:error, :missing_database_endpoint}

      not is_binary(tracker.api_key) ->
        {:error, :missing_database_api_key}

      not is_binary(tracker.table) ->
        {:error, :missing_database_table}

      true ->
        :ok
    end
  end

  defp validate_tracker_kind(%{kind: "github"} = tracker) do
    cond do
      not is_binary(tracker.repository) ->
        {:error, :missing_github_repository}

      not is_binary(tracker.api_key) ->
        {:error, :missing_github_api_key}

      true ->
        :ok
    end
  end

  defp validate_tracker_kind(%{kind: "api"}), do: :ok
  defp validate_tracker_kind(%{kind: "memory"}), do: :ok

  defp first_present(values) do
    Enum.find(values, fn
      value when is_binary(value) -> String.trim(value) != ""
      _ -> false
    end)
  end

  defp workspace_settings_repository do
    Application.get_env(:symphony_elixir, :config_workspace_settings_repository, WorkspaceSettings.Repository)
  end

  defp repository_configured?(WorkspaceSettings.Repository, opts) do
    Keyword.has_key?(opts, :config) or WorkspaceSettings.Repository.configured?()
  end

  defp repository_configured?(_repository, _opts), do: true

  defp format_config_error(reason) do
    case reason do
      {:invalid_workflow_config, message} ->
        "Invalid WORKFLOW.md config: #{message}"

      {:missing_workflow_file, path, raw_reason} ->
        "Missing WORKFLOW.md at #{path}: #{inspect(raw_reason)}"

      {:workflow_parse_error, raw_reason} ->
        "Failed to parse WORKFLOW.md: #{inspect(raw_reason)}"

      :workflow_front_matter_not_a_map ->
        "Failed to parse WORKFLOW.md: workflow front matter must decode to a map"

      other ->
        "Invalid WORKFLOW.md config: #{inspect(other)}"
    end
  end
end
