defmodule SymphonyElixir.Launcher.WorkspaceRuntime do
  @moduledoc """
  Counts active agents for a workspace by snapshotting managed orchestrators.
  """

  @spec active_agents_count(map(), String.t(), pid() | nil, (pid(), timeout() -> term())) ::
          {:ok, non_neg_integer()} | {:error, term()}
  def active_agents_count(state, workspace_id, exclude_pid, snapshotter) when is_binary(workspace_id) do
    state.orchestrators
    |> Map.values()
    |> Enum.filter(&workspace_count_entry?(&1, workspace_id, exclude_pid))
    |> Enum.reduce_while({:ok, 0}, fn entry, {:ok, count} ->
      case running_agents_for_entry(entry, snapshotter) do
        {:ok, running_count} ->
          {:cont, {:ok, count + running_count}}

        {:error, reason} ->
          {:halt, {:error, {:workspace_runtime_unavailable, Map.get(entry, :id), reason}}}
      end
    end)
  end

  def active_agents_count(_state, _workspace_id, _exclude_pid, _snapshotter),
    do: {:error, :invalid_workspace_id}

  defp workspace_count_entry?(entry, workspace_id, exclude_pid) do
    Map.get(entry, :workspace_id) == workspace_id and Map.get(entry, :status) == :running and
      Map.get(entry, :pid) != exclude_pid
  end

  defp running_agents_for_entry(%{pid: pid}, _snapshotter) when not is_pid(pid),
    do: {:error, :runtime_unavailable}

  defp running_agents_for_entry(%{pid: pid}, snapshotter) when is_function(snapshotter, 2) do
    case snapshotter.(pid, 1_000) do
      %{running: running} when is_list(running) ->
        {:ok, length(running)}

      :timeout ->
        {:error, :timeout}

      :unavailable ->
        {:error, :unavailable}

      other ->
        {:error, {:invalid_snapshot, other}}
    end
  end
end
