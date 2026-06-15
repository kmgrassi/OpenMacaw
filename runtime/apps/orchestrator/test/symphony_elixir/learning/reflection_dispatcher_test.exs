defmodule SymphonyElixir.Learning.ReflectionDispatcherTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Learning.ReflectionDispatcher

  defmodule TestRepository do
    def create_task(payload, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :reflection_dispatcher_test_pid)
      send(test_pid, {:create_task, payload, opts})

      case Application.get_env(:symphony_elixir, :reflection_dispatcher_test_create_result) do
        {:error, _} = error -> error
        {:raise, message} -> raise message
        _ -> {:ok, %{"id" => "scheduled-row-1"}}
      end
    end
  end

  defmodule TestWorkspaceSettings do
    @moduledoc """
    Stubs `WorkspaceSettings.Repository.learning_enabled?/2`. The test
    controls the return via the
    `:reflection_dispatcher_test_workspace_setting` app-env key:

      * `:enabled`   → `{:ok, true}` (memory on)
      * `:disabled`  → `{:ok, false}` (memory off)
      * `:no_row`    → `{:ok, false}` (mirrors repo's "no row = default false")
      * `{:error, reason}` → returned verbatim (caller should fail open)
      * default      → `{:ok, true}` (same as :enabled — keeps existing
                       tests' default behaviour explicit)
    """
    def learning_enabled?(workspace_id, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :reflection_dispatcher_test_pid)
      send(test_pid, {:workspace_settings_read, workspace_id, opts})

      case Application.get_env(:symphony_elixir, :reflection_dispatcher_test_workspace_setting) do
        :disabled -> {:ok, false}
        :enabled -> {:ok, true}
        :no_row -> {:ok, false}
        {:error, _} = error -> error
        _ -> {:ok, true}
      end
    end
  end

  setup do
    Application.put_env(:symphony_elixir, :reflection_dispatcher_test_pid, self())

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :reflection_dispatcher_test_pid)
      Application.delete_env(:symphony_elixir, :reflection_dispatcher_test_create_result)
      Application.delete_env(:symphony_elixir, :reflection_dispatcher_test_workspace_setting)
    end)

    :ok
  end

  describe "workspace gate" do
    test "enqueues when workspace_settings.learning_enabled is true" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :enabled
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-1",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:workspace_settings_read, "ws-1", _opts}
      assert_receive {:create_task, _payload, _opts}
    end

    test "skips enqueue when no workspace_settings row exists (defaults to disabled)" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :no_row
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-2",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:workspace_settings_read, "ws-1", _opts}
      refute_received {:create_task, _, _}
    end

    test "skips enqueue when workspace_settings.learning_enabled is false" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :disabled
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-3",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:workspace_settings_read, "ws-1", _opts}
      refute_received {:create_task, _, _}
    end

    test "fails open (enqueues) when the workspace_settings read errors" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        {:error, :supabase_unreachable}
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-4",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:workspace_settings_read, "ws-1", _opts}
      assert_receive {:create_task, _payload, _opts}
    end
  end

  describe "payload shape (workspace gate on)" do
    setup do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :enabled
      )

      :ok
    end

    test "inserts a one-shot scheduled_task row with the right delivery shape" do
      scope = %{workspace_id: "ws-1", agent_id: "agent-7", user_id: "user-1"}
      now = ~U[2026-05-18 12:00:00Z]

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9001",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings,
                 source_work_item_id: "work-item-42",
                 now: now
               )

      assert_receive {:create_task, payload, _opts}

      assert payload["workspace_id"] == "ws-1"
      assert payload["agent_id"] == "agent-7"
      assert payload["title"] == "Learning reflection"

      assert payload["instructions"] ==
               "Reflect on the completed agent run and extract durable workspace memory."

      assert payload["enabled"] == true
      assert payload["timezone"] == "Etc/UTC"
      assert payload["next_run_at"] == "2026-05-18T12:00:00Z"
      assert payload["schedule"] == %{"kind" => "at", "runAt" => "2026-05-18T12:00:00Z"}
      assert payload["source_work_item_id"] == "work-item-42"

      assert payload["delivery"] == %{
               "kind" => "learning_reflection",
               "sourceRunId" => "run-9001",
               "sourceTaskId" => "work-item-42"
             }
    end

    test "omits sourceTaskId when no work item is supplied" do
      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9002",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:create_task, payload, _opts}

      refute Map.has_key?(payload["delivery"], "sourceTaskId")
      refute Map.has_key?(payload, "source_work_item_id")
    end
  end

  describe "error swallowing (workspace gate on)" do
    setup do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :enabled
      )

      :ok
    end

    test "swallows repository errors (never propagates)" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_create_result,
        {:error, :postgrest_unreachable}
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9003",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:create_task, _, _}
    end

    test "swallows repository exceptions (never propagates)" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_create_result,
        {:raise, "boom"}
      )

      scope = %{workspace_id: "ws-1", agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9004",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )
    end
  end

  describe "missing scope fields" do
    test "skips enqueue (and does not read workspace settings) when workspace_id missing" do
      scope = %{workspace_id: nil, agent_id: "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9005",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      refute_received {:workspace_settings_read, _, _}
      refute_received {:create_task, _, _}
    end

    test "skips enqueue when agent_id missing (workspace gate already passed)" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :enabled
      )

      scope = %{workspace_id: "ws-1", agent_id: nil}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9006",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:workspace_settings_read, "ws-1", _opts}
      refute_received {:create_task, _, _}
    end
  end

  describe "scope key shapes" do
    test "reads scope fields from string-keyed maps too" do
      Application.put_env(
        :symphony_elixir,
        :reflection_dispatcher_test_workspace_setting,
        :enabled
      )

      scope = %{"workspace_id" => "ws-1", "agent_id" => "agent-7"}

      assert :ok =
               ReflectionDispatcher.maybe_enqueue(scope, "run-9007",
                 repository: TestRepository,
                 workspace_settings: TestWorkspaceSettings
               )

      assert_receive {:create_task, payload, _opts}
      assert payload["workspace_id"] == "ws-1"
      assert payload["agent_id"] == "agent-7"
    end
  end
end
