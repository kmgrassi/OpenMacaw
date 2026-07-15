defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and writes.
  """

  alias SymphonyElixir.{Config, WorkspaceSettings}
  alias SymphonyElixir.WorkItem

  @type issue_ref :: String.t() | WorkItem.t()

  @callback fetch_candidate_issues(String.t()) :: {:ok, [WorkItem.t()]} | {:error, term()}
  @callback fetch_issues_by_states(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  @callback fetch_issue_states_by_ids(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  @callback create_comment(String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  @callback update_issue_state(String.t(), issue_ref(), String.t()) :: :ok | {:error, term()}

  @spec fetch_candidate_issues() :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_candidate_issues do
    adapter().fetch_candidate_issues()
  end

  @spec fetch_candidate_issues(String.t()) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_candidate_issues(workspace_id) do
    with {:ok, adapter} <- resolve_adapter(workspace_id) do
      adapter.fetch_candidate_issues(workspace_id)
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issues_by_states(states) do
    adapter().fetch_issues_by_states(states)
  end

  @spec fetch_issues_by_states(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issues_by_states(workspace_id, states) do
    with {:ok, adapter} <- resolve_adapter(workspace_id) do
      adapter.fetch_issues_by_states(workspace_id, states)
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) do
    adapter().fetch_issue_states_by_ids(issue_ids)
  end

  @spec fetch_issue_states_by_ids(String.t(), [String.t()]) :: {:ok, [WorkItem.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(workspace_id, issue_ids) do
    with {:ok, adapter} <- resolve_adapter(workspace_id) do
      adapter.fetch_issue_states_by_ids(workspace_id, issue_ids)
    end
  end

  @spec create_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(issue_id, body) do
    adapter().create_comment(issue_id, body)
  end

  @spec create_comment(String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  def create_comment(workspace_id, issue_id, body) do
    with {:ok, adapter} <- resolve_adapter(workspace_id) do
      adapter.create_comment(workspace_id, issue_id, body)
    end
  end

  @spec update_issue_state(issue_ref(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(issue_or_id, state_name) do
    adapter().update_issue_state(issue_or_id, state_name)
  end

  @spec update_issue_state(String.t(), issue_ref(), String.t()) :: :ok | {:error, term()}
  def update_issue_state(workspace_id, issue_or_id, state_name) do
    with {:ok, adapter} <- resolve_adapter(workspace_id) do
      adapter.update_issue_state(workspace_id, issue_or_id, state_name)
    end
  end

  @spec adapter() :: module()
  def adapter do
    case Config.settings!().tracker.kind do
      "memory" -> SymphonyElixir.Tracker.Memory
      "database" -> SymphonyElixir.Tracker.Database
      "github" -> SymphonyElixir.Tracker.GitHub
      "api" -> require_started!(SymphonyElixir.Tracker.API)
      "linear" -> SymphonyElixir.Tracker.Linear
      kind -> raise ArgumentError, "unknown tracker.kind: #{inspect(kind)}"
    end
  end

  @doc """
  Resolves the tracker adapter configured for a workspace.

  Use `adapter/0` for the process-wide workflow configuration. Keeping the
  workspace-scoped lookup under its own name makes the configuration scope
  explicit at call sites.
  """
  @spec adapter_for_workspace(String.t()) :: module() | {:error, term()}
  def adapter_for_workspace(workspace_id) when is_binary(workspace_id) and workspace_id != "" do
    with {:ok, adapter} <- resolve_adapter(workspace_id), do: adapter
  end

  def adapter_for_workspace(_workspace_id), do: {:error, :missing_workspace_id}

  @doc false
  @spec invalidate_adapter_cache(String.t()) :: :ok
  def invalidate_adapter_cache(workspace_id) when is_binary(workspace_id) do
    Process.delete({__MODULE__, :adapter, workspace_id})
    :ok
  end

  defp require_started!(module) do
    case Process.whereis(module) do
      pid when is_pid(pid) -> module
      nil -> raise "Tracker.API GenServer is not started. Add it to your supervision tree when using tracker kind \"api\"."
    end
  end

  defp resolve_adapter(workspace_id) when is_binary(workspace_id) and workspace_id != "" do
    cache_key = {__MODULE__, :adapter, workspace_id}

    case Process.get(cache_key) do
      {adapter, expires_at_ms} when is_integer(expires_at_ms) ->
        if System.monotonic_time(:millisecond) < expires_at_ms do
          {:ok, adapter}
        else
          Process.delete(cache_key)
          resolve_adapter_uncached(workspace_id, cache_key)
        end

      _ ->
        resolve_adapter_uncached(workspace_id, cache_key)
    end
  end

  defp resolve_adapter(_workspace_id), do: {:error, :missing_workspace_id}

  defp resolve_adapter_uncached(workspace_id, cache_key) do
    with {:ok, settings} <- workspace_settings_repository().tracker_settings(workspace_id),
         {:ok, kind} <- tracker_kind(settings),
         :ok <- validate_tracker_credential(kind, settings),
         {:ok, adapter} <- adapter_for_kind(kind) do
      Process.put(cache_key, {adapter, System.monotonic_time(:millisecond) + tracker_cache_ttl_ms()})
      {:ok, adapter}
    end
  end

  defp tracker_kind(%{"tracker_kind" => kind}) when is_binary(kind) and kind != "", do: {:ok, kind}
  defp tracker_kind(_settings), do: {:ok, "database"}

  defp validate_tracker_credential(kind, settings) when kind in ["linear", "github"] do
    case Map.get(settings, "tracker_credential_id") do
      credential_id when is_binary(credential_id) and credential_id != "" -> :ok
      _ -> {:error, {:missing_tracker_credential, kind}}
    end
  end

  defp validate_tracker_credential(_kind, _settings), do: :ok

  defp adapter_for_kind("memory"), do: {:ok, SymphonyElixir.Tracker.Memory}
  defp adapter_for_kind("database"), do: {:ok, SymphonyElixir.Tracker.Database}
  defp adapter_for_kind("github"), do: {:ok, SymphonyElixir.Tracker.GitHub}
  defp adapter_for_kind("api"), do: {:ok, require_started!(SymphonyElixir.Tracker.API)}
  defp adapter_for_kind("linear"), do: {:ok, SymphonyElixir.Tracker.Linear}
  defp adapter_for_kind(kind), do: {:error, {:unsupported_tracker_kind, kind}}

  defp tracker_cache_ttl_ms do
    :symphony_elixir
    |> Application.get_env(:tracker_adapter_cache_ttl_ms, 30_000)
    |> max(0)
  end

  defp workspace_settings_repository do
    Application.get_env(:symphony_elixir, :tracker_workspace_settings_repository, WorkspaceSettings.Repository)
  end
end
