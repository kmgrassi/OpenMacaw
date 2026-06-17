defmodule SymphonyElixir.ScheduledTask.ToolsTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ScheduledTask.Tools
  alias SymphonyElixir.ToolRegistry

  defmodule TestRepository do
    def create_task(payload, _opts), do: {:ok, Map.put(payload, "id", "scheduled-task-1")}

    def read_task("scheduled-task-1", "workspace-1", _opts),
      do: {:ok, %{"id" => "scheduled-task-1", "workspace_id" => "workspace-1"}}

    def read_task("scheduled-task-full", "workspace-1", _opts),
      do:
        {:ok,
         %{
           "id" => "scheduled-task-full",
           "workspace_id" => "workspace-1",
           "agent_id" => "agent-1",
           "source_work_item_id" => "work-item-1",
           "instructions" => "Old instructions",
           "enabled" => true,
           "schedule" => %{"every" => "day", "at" => "09:00:00"},
           "timezone" => "America/New_York",
           "next_run_at" => "2026-05-19T13:00:00Z",
           "delivery" => %{"kind" => "scheduled_agent_message"},
           "metadata" => %{"foo" => 1, "bar" => 2}
         }}

    def read_task(_id, _workspace_id, _opts), do: {:ok, nil}

    def list_tasks("workspace-1", _opts) do
      send(self(), {:scheduled_task_list_workspace, "workspace-1"})
      {:ok, [%{"id" => "scheduled-task-1"}]}
    end

    def update_task(id, payload, _opts) do
      send(self(), {:scheduled_task_update, id, payload})
      {:ok, Map.put(payload, "id", id)}
    end

    def agent_workspace_id("agent-1", _opts), do: {:ok, "workspace-1"}
    def agent_workspace_id("agent-2", _opts), do: {:ok, "workspace-2"}
  end

  defmodule ConcurrentUpdateRepository do
    def read_task("scheduled-task-1", "workspace-1", _opts) do
      count = Process.get(:scheduled_task_read_count, 0)
      Process.put(:scheduled_task_read_count, count + 1)

      updated_at =
        if count == 0 do
          "2026-05-19T12:00:00Z"
        else
          "2026-05-19T12:05:00Z"
        end

      {:ok,
       %{
         "id" => "scheduled-task-1",
         "workspace_id" => "workspace-1",
         "updated_at" => updated_at
       }}
    end

    def read_task(_id, _workspace_id, _opts), do: {:ok, nil}
    def list_tasks("workspace-1", _opts), do: {:ok, [%{"id" => "scheduled-task-1"}]}

    def update_task("scheduled-task-1", _payload, opts) do
      send(self(), {:match_updated_at, Keyword.get(opts, :match_updated_at)})
      {:ok, nil}
    end

    def agent_workspace_id("agent-1", _opts), do: {:ok, "workspace-1"}
  end

  test "create validates delivery kind and writes a scheduled_task payload" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "instructions" => "Check usage",
                 "schedule" => %{"every" => "hour"},
                 "next_run_at" => "2026-05-14T12:00:00Z",
                 "delivery" => %{"kind" => "scheduled_agent_message"}
               },
               repository: TestRepository
             )

    assert row["id"] == "scheduled-task-1"
    assert row["delivery"] == %{"kind" => "scheduled_agent_message"}
    assert row["enabled"] == true
  end

  test "create defaults workspace and agent from runtime context" do
    {:ok, create_tool} = ToolRegistry.get("scheduled_task.create")

    assert {:ok, row} =
             create_tool.execute(
               %{
                 "instructions" => "Ping me",
                 "schedule" => %{"at" => "2026-05-14T12:00:00Z"}
               },
               %{
                 session: %{workspace_id: "workspace-1", agent_id: "agent-1"},
                 repository: TestRepository
               }
             )

    assert row["workspace_id"] == "workspace-1"
    assert row["agent_id"] == "agent-1"
    assert row["instructions"] == "Ping me"
    assert row["delivery"] == %{"kind" => "scheduled_agent_message"}
    assert row["next_run_at"] == "2026-05-14T12:00:00Z"
  end

  test "create defaults workspace and agent from top-level registry runtime context" do
    assert {:ok, %{output: row}} =
             ToolRegistry.execute(
               "scheduled_task.create",
               %{
                 "instructions" => "Ping me",
                 "schedule" => %{"at" => "2026-05-14T12:00:00Z"}
               },
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "repository" => TestRepository
               },
               ["scheduled_task.create"]
             )

    assert row["workspace_id"] == "workspace-1"
    assert row["agent_id"] == "agent-1"
    assert row["next_run_at"] == "2026-05-14T12:00:00Z"
  end

  test "create infers next_run_at for recurring wall-clock schedules" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "instructions" => "Daily check-in",
                 "schedule" => %{"every" => "day", "at" => "09:00:00"},
                 "timezone" => "America/New_York"
               },
               repository: TestRepository,
               now: ~U[2026-05-18 12:00:00Z]
             )

    assert row["next_run_at"] == "2026-05-18T13:00:00Z"
  end

  test "create requires next_run_at for cadence-only recurring schedules" do
    assert {:error, {:missing_argument, "next_run_at"}} =
             Tools.execute(
               "scheduled_task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "instructions" => "Hourly check-in",
                 "schedule" => %{"every" => "hour"}
               },
               repository: TestRepository
             )
  end

  test "create returns a readable error for unsupported 30 minute schedules" do
    assert {:error, {:unsupported_schedule_unit, "minute", message}} =
             Tools.execute(
               "scheduled_task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "instructions" => "Check PR comments",
                 "schedule" => %{"kind" => "every", "interval" => 30, "unit" => "minute"},
                 "next_run_at" => "2026-05-14T12:00:00Z"
               },
               repository: TestRepository
             )

    assert message =~ "30-minute/minute schedules are not supported"
    assert message =~ ~s({"every":"hour"})
  end

  test "create rejects malformed one-shot schedule timestamps" do
    assert {:error, {:invalid_schedule_datetime, nil}} =
             Tools.execute(
               "scheduled_task.create",
               %{
                 "workspace_id" => "workspace-1",
                 "agent_id" => "agent-1",
                 "instructions" => "Bad timestamp",
                 "schedule" => %{"at" => nil}
               },
               repository: TestRepository
             )
  end

  test "create schema only requires instructions and schedule" do
    required = Tools.tool_spec("scheduled_task.create")["inputSchema"]["required"]

    assert required == ["instructions", "schedule"]
    refute "workspace_id" in required
    refute "agent_id" in required
  end

  test "read and list schemas do not require workspace when runtime context can provide it" do
    read_required = Tools.tool_spec("scheduled_task.read")["inputSchema"]["required"]
    list_required = Tools.tool_spec("scheduled_task.list")["inputSchema"]["required"]

    assert read_required == ["scheduledTaskId"]
    assert list_required == []
    refute "workspace_id" in read_required
    refute "workspace_id" in list_required
  end

  test "scheduled_task.list executes through the coding bundle with runtime context" do
    assert {:ok, %{output: [%{"id" => "scheduled-task-1"}]}} =
             ToolRegistry.execute(
               "scheduled_task.list",
               %{},
               %{"workspace_id" => "workspace-1", "repository" => TestRepository},
               ToolRegistry.bundle(:coding)
             )
  end

  test "scheduled_task.list ignores caller workspace override when runtime context exists" do
    assert {:ok, %{output: [%{"id" => "scheduled-task-1"}]}} =
             ToolRegistry.execute(
               "scheduled_task.list",
               %{"workspace_id" => "workspace-2"},
               %{"workspace_id" => "workspace-1", "repository" => TestRepository},
               ToolRegistry.bundle(:coding)
             )

    assert_received {:scheduled_task_list_workspace, "workspace-1"}
  end

  test "update requires an existing scheduled task" do
    assert {:error, :scheduled_task_not_found} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "missing",
                 "enabled" => false
               },
               repository: TestRepository
             )
  end

  test "update rejects retargeting a schedule to an agent from another workspace" do
    assert {:error, {:agent_workspace_mismatch, "agent-2", "workspace-2"}} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-1",
                 "agent_id" => "agent-2"
               },
               repository: TestRepository
             )
  end

  test "update accepts id-only calls as no-ops and does not patch" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-full"
               },
               repository: TestRepository
             )

    assert row["instructions"] == "Old instructions"
    assert row["changed_fields"] == []
    refute_received {:scheduled_task_update, _id, _payload}
  end

  test "update only patches changed fields and echoes the resolved row" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-full",
                 "enabled" => false
               },
               repository: TestRepository
             )

    assert_received {:scheduled_task_update, "scheduled-task-full", %{"enabled" => false}}
    assert row["enabled"] == false
    assert row["instructions"] == "Old instructions"
    assert row["changed_fields"] == ["enabled"]
  end

  test "update shallow-merges metadata before patching" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-full",
                 "metadata" => %{"foo" => 3, "baz" => 4}
               },
               repository: TestRepository
             )

    assert_received {:scheduled_task_update, "scheduled-task-full", %{"metadata" => %{"foo" => 3, "bar" => 2, "baz" => 4}}}

    assert row["metadata"] == %{"foo" => 3, "bar" => 2, "baz" => 4}
    assert row["changed_fields"] == ["metadata"]
  end

  test "update allows null for nullable fields and rejects null for non-nullable fields" do
    assert {:ok, row} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-full",
                 "timezone" => nil
               },
               repository: TestRepository
             )

    assert_received {:scheduled_task_update, "scheduled-task-full", %{"timezone" => nil}}
    assert row["timezone"] == nil
    assert row["changed_fields"] == ["timezone"]

    assert {:error, {:invalid_null, "instructions is non-nullable"}} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-full",
                 "instructions" => nil
               },
               repository: TestRepository
             )
  end

  test "update schema only requires the scheduled task id" do
    required = Tools.tool_spec("scheduled_task.update")["inputSchema"]["required"]

    assert required == ["scheduledTaskId"]
    refute "instructions" in required
    refute "schedule" in required
  end

  test "update treats zero-row guarded patches as stale writes" do
    assert {:error,
            {:stale_row,
             %{
               table: "scheduled_task",
               id: "scheduled-task-1",
               workspace_id: "workspace-1",
               expected_updated_at: "2026-05-19T12:00:00Z",
               actual_updated_at: "2026-05-19T12:05:00Z"
             }}} =
             Tools.execute(
               "scheduled_task.update",
               %{
                 "workspace_id" => "workspace-1",
                 "scheduledTaskId" => "scheduled-task-1",
                 "enabled" => false,
                 "if_updated_at" => "2026-05-19T12:00:00Z"
               },
               repository: ConcurrentUpdateRepository
             )

    assert_received {:match_updated_at, "2026-05-19T12:00:00Z"}
  end

  test "registry exposes scheduled task tools in generic bundles" do
    assert {:ok, SymphonyElixir.ScheduledTask.Tools.Create} =
             ToolRegistry.get("scheduled_task.create")

    assert "scheduled_task.create" in ToolRegistry.bundle(:planner)
    assert "scheduled_task.create" in ToolRegistry.bundle(:manager)
    assert "scheduled_task.delete" in ToolRegistry.bundle(:scheduled_task)
    assert "scheduled_task.delete" in ToolRegistry.bundle(:manager)
  end
end
