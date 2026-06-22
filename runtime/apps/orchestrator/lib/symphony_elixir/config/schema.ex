defmodule SymphonyElixir.Config.Schema do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  alias SymphonyElixir.Config.{EmbeddedConfig, Errors, PathResolver, SecretResolver}
  alias SymphonyElixir.Supabase

  @primary_key false

  @type t :: %__MODULE__{}

  defmodule StringOrMap do
    @moduledoc false
    @behaviour Ecto.Type

    @spec type() :: :map
    def type, do: :map

    @spec embed_as(term()) :: :self
    def embed_as(_format), do: :self

    @spec equal?(term(), term()) :: boolean()
    def equal?(left, right), do: left == right

    @spec cast(term()) :: {:ok, String.t() | map()} | :error
    def cast(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def cast(_value), do: :error

    @spec load(term()) :: {:ok, String.t() | map()} | :error
    def load(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def load(_value), do: :error

    @spec dump(term()) :: {:ok, String.t() | map()} | :error
    def dump(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def dump(_value), do: :error
  end

  defmodule Writeback do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:table, :string)
      field(:id_field, :string)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      cast_with(schema, attrs, [:table, :id_field])
    end
  end

  defmodule Tracker do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:kind, :string)
      field(:endpoint, :string)
      field(:api_key, :string)
      field(:project_slug, :string)
      field(:assignee, :string)
      field(:table, :string)
      field(:workspace_id, :string)
      field(:plan_id, :string)
      field(:runner_type, :string)
      field(:comments_table, :string)
      field(:comment_author, :string)
      field(:repository, :string)
      field(:webhook_secret, :string)
      field(:active_states, {:array, :string}, default: ["Todo", "In Progress"])

      field(:terminal_states, {:array, :string}, default: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"])

      embeds_one(:writeback, SymphonyElixir.Config.Schema.Writeback,
        on_replace: :update,
        defaults_to_struct: false
      )
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(
        attrs,
        [
          :kind,
          :endpoint,
          :api_key,
          :project_slug,
          :assignee,
          :table,
          :workspace_id,
          :plan_id,
          :runner_type,
          :comments_table,
          :comment_author,
          :repository,
          :webhook_secret,
          :active_states,
          :terminal_states
        ]
      )
      |> cast_embed(:writeback, with: &SymphonyElixir.Config.Schema.Writeback.changeset/2)
      |> apply_kind_defaults()
    end

    defp apply_kind_defaults(changeset) do
      case get_field(changeset, :kind) do
        "linear" ->
          if is_nil(get_field(changeset, :endpoint)) do
            put_change(changeset, :endpoint, "https://api.linear.app/graphql")
          else
            changeset
          end

        _ ->
          changeset
      end
    end
  end

  defmodule Polling do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:interval_ms, :integer, default: 30_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(attrs, [:interval_ms])
      |> validate_number(:interval_ms, greater_than: 0)
    end
  end

  defmodule Workspace do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:root, :string, default: Path.join(System.tmp_dir!(), "symphony_workspaces"))
      field(:session_workspace_root, :string)

      field(:repo_cache_root, :string, default: Path.join(System.tmp_dir!(), "symphony_repo_cache"))

      field(:artifact_sink, :string, default: Path.join(System.tmp_dir!(), "symphony_artifacts"))
      field(:repository, :string)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(
        attrs,
        [:root, :session_workspace_root, :repo_cache_root, :artifact_sink, :repository]
      )
    end
  end

  defmodule Worker do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:ssh_hosts, {:array, :string}, default: [])
      field(:max_concurrent_agents_per_host, :integer)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(attrs, [:ssh_hosts, :max_concurrent_agents_per_host])
      |> validate_number(:max_concurrent_agents_per_host, greater_than: 0)
    end
  end

  defmodule Agent do
    @moduledoc false
    use EmbeddedConfig

    alias SymphonyElixir.Config.Schema

    embedded_schema do
      field(:max_concurrent_agents, :integer, default: 10)
      field(:max_turns, :integer, default: 20)
      field(:max_retry_backoff_ms, :integer, default: 300_000)
      field(:max_concurrent_agents_by_state, :map, default: %{})
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(
        attrs,
        [
          :max_concurrent_agents,
          :max_turns,
          :max_retry_backoff_ms,
          :max_concurrent_agents_by_state
        ]
      )
      |> validate_number(:max_concurrent_agents, greater_than: 0)
      |> validate_number(:max_turns, greater_than: 0)
      |> validate_number(:max_retry_backoff_ms, greater_than: 0)
      |> update_change(:max_concurrent_agents_by_state, &Schema.normalize_state_limits/1)
      |> Schema.validate_state_limits(:max_concurrent_agents_by_state)
    end
  end

  defmodule Codex do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:command, :string, default: "codex app-server")
      field(:model, :string)
      field(:model_provider, :string)

      field(:approval_policy, StringOrMap, default: "on-request")

      field(:thread_sandbox, :string, default: "workspace-write")
      field(:turn_sandbox_policy, :map)
      field(:turn_timeout_ms, :integer, default: 3_600_000)
      field(:read_timeout_ms, :integer, default: 60_000)
      field(:stall_timeout_ms, :integer, default: 300_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(
        attrs,
        [
          :command,
          :model,
          :model_provider,
          :approval_policy,
          :thread_sandbox,
          :turn_sandbox_policy,
          :turn_timeout_ms,
          :read_timeout_ms,
          :stall_timeout_ms
        ]
      )
      |> validate_required([:command])
      |> validate_number(:turn_timeout_ms, greater_than: 0)
      |> validate_number(:read_timeout_ms, greater_than: 0)
      |> validate_number(:stall_timeout_ms, greater_than_or_equal_to: 0)
    end
  end

  defmodule Hooks do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:after_create, :string)
      field(:before_run, :string)
      field(:after_run, :string)
      field(:before_remove, :string)
      field(:timeout_ms, :integer, default: 60_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(attrs, [:after_create, :before_run, :after_run, :before_remove, :timeout_ms])
      |> validate_number(:timeout_ms, greater_than: 0)
    end
  end

  defmodule Observability do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:dashboard_enabled, :boolean, default: true)
      field(:refresh_ms, :integer, default: 1_000)
      field(:render_interval_ms, :integer, default: 16)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(attrs, [:dashboard_enabled, :refresh_ms, :render_interval_ms])
      |> validate_number(:refresh_ms, greater_than: 0)
      |> validate_number(:render_interval_ms, greater_than: 0)
    end
  end

  defmodule Runners do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:default, :string, default: "codex")
      field(:codex, :map, default: %{})
      field(:llm_tool_runner, :map, default: %{})
      field(:planner, :map, default: %{})
      field(:openclaw, :map, default: %{})
      field(:openclaw_ws, :map, default: %{})
      field(:computer_use, :map, default: %{})
      field(:local_relay, :map, default: %{})
      field(:local_model_coding, :map, default: %{})
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      fields = [
        :default,
        :codex,
        :llm_tool_runner,
        :planner,
        :openclaw,
        :openclaw_ws,
        :computer_use,
        :local_relay,
        :local_model_coding
      ]

      runner_kinds =
        ~w(codex llm_tool_runner planner openclaw openclaw_ws computer_use local_relay local_model_coding)

      schema
      |> cast_with(attrs, fields)
      |> validate_inclusion(:default, runner_kinds)
    end
  end

  defmodule Server do
    @moduledoc false
    use EmbeddedConfig

    embedded_schema do
      field(:port, :integer)
      field(:host, :string, default: "127.0.0.1")
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast_with(attrs, [:port, :host])
      |> validate_number(:port, greater_than_or_equal_to: 0)
    end
  end

  defmodule StoredAgent do
    @moduledoc """
    Agent identity injected by the Launcher when it boots this orchestrator.

    Used by BrokerLog to attribute `broker_run` / `broker_task` rows to the
    right Supabase `agent` and `workspaces` rows.
    """
    use EmbeddedConfig

    embedded_schema do
      field(:id, :string)
      field(:type, :string)
      field(:name, :string)
      field(:workspace_id, :string)
      field(:project_id, :string)
      field(:tool_policy, :map, default: %{})
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      cast_with(schema, attrs, [:id, :name, :workspace_id, :project_id, :type, :tool_policy])
    end
  end

  embedded_schema do
    embeds_one(:tracker, Tracker, on_replace: :update, defaults_to_struct: true)
    embeds_one(:polling, Polling, on_replace: :update, defaults_to_struct: true)
    embeds_one(:workspace, Workspace, on_replace: :update, defaults_to_struct: true)
    embeds_one(:worker, Worker, on_replace: :update, defaults_to_struct: true)
    embeds_one(:agent, Agent, on_replace: :update, defaults_to_struct: true)
    embeds_one(:codex, Codex, on_replace: :update, defaults_to_struct: true)
    embeds_one(:hooks, Hooks, on_replace: :update, defaults_to_struct: true)
    embeds_one(:observability, Observability, on_replace: :update, defaults_to_struct: true)
    embeds_one(:runners, Runners, on_replace: :update, defaults_to_struct: true)
    embeds_one(:server, Server, on_replace: :update, defaults_to_struct: true)
    embeds_one(:stored_agent, StoredAgent, on_replace: :update, defaults_to_struct: true)
    field(:execution_profile, :map)
  end

  @spec parse(map()) :: {:ok, %__MODULE__{}} | {:error, {:invalid_workflow_config, String.t()}}
  def parse(config) when is_map(config) do
    config
    |> normalize_keys()
    |> drop_nil_values()
    |> changeset()
    |> apply_action(:validate)
    |> case do
      {:ok, settings} ->
        {:ok, finalize_settings(settings)}

      {:error, changeset} ->
        {:error, {:invalid_workflow_config, Errors.format(changeset)}}
    end
  end

  @spec resolve_turn_sandbox_policy(%__MODULE__{}, Path.t() | nil) :: map()
  def resolve_turn_sandbox_policy(settings, workspace \\ nil) do
    case settings.codex.turn_sandbox_policy do
      %{} = policy ->
        policy

      _ ->
        workspace
        |> default_workspace_root(workspace_root_setting(settings))
        |> PathResolver.expand_local_workspace_root(default_session_workspace_root())
        |> default_turn_sandbox_policy()
    end
  end

  @spec resolve_runtime_turn_sandbox_policy(%__MODULE__{}, Path.t() | nil, keyword()) ::
          {:ok, map()} | {:error, term()}
  def resolve_runtime_turn_sandbox_policy(settings, workspace \\ nil, opts \\ []) do
    case settings.codex.turn_sandbox_policy do
      %{} = policy ->
        {:ok, policy}

      _ ->
        workspace
        |> default_workspace_root(workspace_root_setting(settings))
        |> default_runtime_turn_sandbox_policy(opts)
    end
  end

  @spec normalize_issue_state(String.t()) :: String.t()
  def normalize_issue_state(state_name) when is_binary(state_name) do
    String.downcase(state_name)
  end

  @doc false
  @spec normalize_state_limits(nil | map()) :: map()
  def normalize_state_limits(nil), do: %{}

  def normalize_state_limits(limits) when is_map(limits) do
    Enum.reduce(limits, %{}, fn {state_name, limit}, acc ->
      Map.put(acc, normalize_issue_state(to_string(state_name)), limit)
    end)
  end

  @doc false
  @spec validate_state_limits(Ecto.Changeset.t(), atom()) :: Ecto.Changeset.t()
  def validate_state_limits(changeset, field) do
    validate_change(changeset, field, fn ^field, limits ->
      Enum.flat_map(limits, fn {state_name, limit} ->
        cond do
          to_string(state_name) == "" ->
            [{field, "state names must not be blank"}]

          not is_integer(limit) or limit <= 0 ->
            [{field, "limits must be positive integers"}]

          true ->
            []
        end
      end)
    end)
  end

  defp changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:execution_profile])
    |> cast_embed(:tracker, with: &Tracker.changeset/2)
    |> cast_embed(:polling, with: &Polling.changeset/2)
    |> cast_embed(:workspace, with: &Workspace.changeset/2)
    |> cast_embed(:worker, with: &Worker.changeset/2)
    |> cast_embed(:agent, with: &Agent.changeset/2)
    |> cast_embed(:codex, with: &Codex.changeset/2)
    |> cast_embed(:hooks, with: &Hooks.changeset/2)
    |> cast_embed(:observability, with: &Observability.changeset/2)
    |> cast_embed(:runners, with: &Runners.changeset/2)
    |> cast_embed(:server, with: &Server.changeset/2)
    |> cast_embed(:stored_agent, with: &StoredAgent.changeset/2)
  end

  defp finalize_settings(settings) do
    tracker = finalize_tracker(settings.tracker)

    repo_override =
      Application.get_env(:symphony_elixir, :repo_override) ||
        System.get_env("SYMPHONY_REPOSITORY")

    session_workspace_root =
      PathResolver.resolve_path_value_with_fallback(
        settings.workspace.session_workspace_root,
        settings.workspace.root,
        default_session_workspace_root()
      )

    workspace = %{
      settings.workspace
      | root: session_workspace_root,
        session_workspace_root: session_workspace_root,
        repo_cache_root: PathResolver.resolve_path_value(settings.workspace.repo_cache_root, default_repo_cache_root()),
        artifact_sink: PathResolver.resolve_storage_value(settings.workspace.artifact_sink, default_artifact_sink()),
        repository: repo_override || settings.workspace.repository
    }

    codex = %{
      settings.codex
      | approval_policy: normalize_keys(settings.codex.approval_policy),
        turn_sandbox_policy: normalize_optional_map(settings.codex.turn_sandbox_policy)
    }

    runners = finalize_runners(settings.runners)

    %{
      settings
      | tracker: tracker,
        workspace: workspace,
        codex: codex,
        runners: runners,
        execution_profile: normalize_optional_map(settings.execution_profile)
    }
  end

  defp finalize_runners(runners) do
    %{
      runners
      | codex: SecretResolver.resolve_map(runners.codex),
        llm_tool_runner: SecretResolver.resolve_map(runners.llm_tool_runner),
        planner: SecretResolver.resolve_map(runners.planner),
        openclaw: SecretResolver.resolve_map(runners.openclaw),
        openclaw_ws: SecretResolver.resolve_map(runners.openclaw_ws),
        computer_use: SecretResolver.resolve_map(runners.computer_use),
        local_relay: SecretResolver.resolve_map(runners.local_relay),
        local_model_coding: SecretResolver.resolve_map(runners.local_model_coding)
    }
  end

  defp finalize_tracker(%{kind: "linear"} = tracker) do
    %{
      tracker
      | api_key: SecretResolver.resolve_setting(tracker.api_key, System.get_env("LINEAR_API_KEY")),
        assignee: SecretResolver.resolve_setting(tracker.assignee, System.get_env("LINEAR_ASSIGNEE")),
        project_slug: tracker.project_slug || System.get_env("LINEAR_PROJECT_SLUG")
    }
  end

  defp finalize_tracker(%{kind: "database"} = tracker) do
    endpoint =
      case Supabase.rest_endpoint(endpoint: tracker.endpoint) do
        {:ok, value} -> value
        {:error, :missing} -> tracker.endpoint
      end

    api_key =
      case tracker.api_key do
        value when is_binary(value) and value != "" ->
          SecretResolver.resolve_setting(value, nil)

        _ ->
          case Supabase.service_role_key() do
            {:ok, value} -> value
            {:error, :missing} -> nil
          end
      end

    %{tracker | endpoint: endpoint, api_key: api_key}
  end

  defp finalize_tracker(%{kind: "github"} = tracker) do
    %{
      tracker
      | api_key: SecretResolver.resolve_setting(tracker.api_key, System.get_env("GITHUB_TOKEN")),
        webhook_secret: SecretResolver.resolve_setting(tracker.webhook_secret, nil)
    }
  end

  defp finalize_tracker(tracker) do
    # Default: resolve secrets with Linear env var fallbacks for backward compatibility
    %{
      tracker
      | api_key: SecretResolver.resolve_setting(tracker.api_key, System.get_env("LINEAR_API_KEY")),
        assignee: SecretResolver.resolve_setting(tracker.assignee, System.get_env("LINEAR_ASSIGNEE")),
        project_slug: tracker.project_slug || System.get_env("LINEAR_PROJECT_SLUG")
    }
  end

  defp normalize_keys(value) when is_map(value) do
    Enum.reduce(value, %{}, fn {key, raw_value}, normalized ->
      Map.put(normalized, normalize_key(key), normalize_keys(raw_value))
    end)
  end

  defp normalize_keys(value) when is_list(value), do: Enum.map(value, &normalize_keys/1)
  defp normalize_keys(value), do: value

  defp normalize_optional_map(nil), do: nil
  defp normalize_optional_map(value) when is_map(value), do: normalize_keys(value)

  defp normalize_key(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize_key(value), do: to_string(value)

  defp drop_nil_values(value) when is_map(value) do
    Enum.reduce(value, %{}, fn {key, nested}, acc ->
      case drop_nil_values(nested) do
        nil -> acc
        normalized -> Map.put(acc, key, normalized)
      end
    end)
  end

  defp drop_nil_values(value) when is_list(value), do: Enum.map(value, &drop_nil_values/1)
  defp drop_nil_values(value), do: value

  defp workspace_root_setting(settings) do
    settings.workspace.session_workspace_root || settings.workspace.root
  end

  defp default_session_workspace_root do
    Path.join(System.tmp_dir!(), "symphony_workspaces")
  end

  defp default_repo_cache_root do
    Path.join(System.tmp_dir!(), "symphony_repo_cache")
  end

  defp default_artifact_sink do
    Path.join(System.tmp_dir!(), "symphony_artifacts")
  end

  defp default_turn_sandbox_policy(workspace) do
    %{
      "type" => "workspaceWrite",
      "writableRoots" => [workspace],
      "readOnlyAccess" => %{"type" => "fullAccess"},
      "networkAccess" => false,
      "excludeTmpdirEnvVar" => false,
      "excludeSlashTmp" => false
    }
  end

  defp default_runtime_turn_sandbox_policy(workspace_root, opts) when is_binary(workspace_root) do
    if Keyword.get(opts, :remote, false) do
      {:ok, default_turn_sandbox_policy(workspace_root)}
    else
      with {:ok, canonical_workspace_root} <-
             PathResolver.canonicalize_local_workspace_root(workspace_root) do
        {:ok, default_turn_sandbox_policy(canonical_workspace_root)}
      end
    end
  end

  defp default_runtime_turn_sandbox_policy(workspace_root, _opts) do
    {:error, {:unsafe_turn_sandbox_policy, {:invalid_workspace_root, workspace_root}}}
  end

  defp default_workspace_root(workspace, _fallback) when is_binary(workspace) and workspace != "",
    do: workspace

  defp default_workspace_root(nil, fallback), do: fallback
  defp default_workspace_root("", fallback), do: fallback
  defp default_workspace_root(workspace, _fallback), do: workspace
end
