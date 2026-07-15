defmodule SymphonyElixir.TrackerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Tracker

  defmodule WorkspaceSettingsStub do
    def tracker_settings(workspace_id) do
      send(parent!(), {:tracker_settings, workspace_id})

      case Process.get({__MODULE__, workspace_id}, :missing) do
        :missing -> {:ok, %{"workspace_id" => workspace_id, "tracker_kind" => "database", "tracker_credential_id" => nil, "exists" => false}}
        settings when is_map(settings) -> {:ok, Map.put(settings, "workspace_id", workspace_id)}
        error -> error
      end
    end

    def put(workspace_id, settings) do
      Process.put({__MODULE__, workspace_id}, settings)
    end

    defp parent! do
      Process.get({__MODULE__, :parent}) || self()
    end
  end

  setup do
    Process.put({WorkspaceSettingsStub, :parent}, self())
    Application.put_env(:symphony_elixir, :tracker_workspace_settings_repository, WorkspaceSettingsStub)
    Application.put_env(:symphony_elixir, :tracker_adapter_cache_ttl_ms, 30_000)

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :tracker_workspace_settings_repository)
      Application.delete_env(:symphony_elixir, :tracker_adapter_cache_ttl_ms)
      Tracker.invalidate_adapter_cache("workspace-1")
      Tracker.invalidate_adapter_cache("workspace-2")
    end)

    :ok
  end

  test "adapter_for_workspace/1 resolves tracker kind from workspace_settings" do
    WorkspaceSettingsStub.put("workspace-1", %{"tracker_kind" => "memory", "tracker_credential_id" => nil})

    assert Tracker.adapter_for_workspace("workspace-1") == SymphonyElixir.Tracker.Memory
    assert_receive {:tracker_settings, "workspace-1"}
  end

  test "adapter_for_workspace/1 falls back to database when workspace_settings row is absent" do
    assert Tracker.adapter_for_workspace("workspace-2") == SymphonyElixir.Tracker.Database
    assert_receive {:tracker_settings, "workspace-2"}
  end

  test "adapter_for_workspace/1 caches per workspace and can be invalidated" do
    WorkspaceSettingsStub.put("workspace-1", %{"tracker_kind" => "memory", "tracker_credential_id" => nil})

    assert Tracker.adapter_for_workspace("workspace-1") == SymphonyElixir.Tracker.Memory
    assert_receive {:tracker_settings, "workspace-1"}

    WorkspaceSettingsStub.put("workspace-1", %{"tracker_kind" => "database", "tracker_credential_id" => nil})
    assert Tracker.adapter_for_workspace("workspace-1") == SymphonyElixir.Tracker.Memory
    refute_receive {:tracker_settings, "workspace-1"}

    :ok = Tracker.invalidate_adapter_cache("workspace-1")
    assert Tracker.adapter_for_workspace("workspace-1") == SymphonyElixir.Tracker.Database
    assert_receive {:tracker_settings, "workspace-1"}
  end

  test "adapter_for_workspace/1 rejects external trackers without credentials" do
    WorkspaceSettingsStub.put("workspace-1", %{"tracker_kind" => "linear", "tracker_credential_id" => nil})

    assert {:error, {:missing_tracker_credential, "linear"}} = Tracker.adapter_for_workspace("workspace-1")
  end

  test "adapter_for_workspace/1 requires a workspace id" do
    assert {:error, :missing_workspace_id} = Tracker.adapter_for_workspace(nil)
  end
end
