import { describe, expect, it } from "vitest";
import { getManagerSchedulerMessageDisplay } from "./manager-message-rendering";

describe("getManagerSchedulerMessageDisplay", () => {
  it("summarizes manager scheduler due-task messages from metadata", () => {
    const display = getManagerSchedulerMessageDisplay(
      JSON.stringify({ due_tasks: [{ id: "task-1" }, { id: "task-2" }] }),
      {
        source: "manager_scheduler",
        kind: "due_tasks",
        work_item_ids: ["work-1", "work-2"],
        tool_calls: [{ tool_name: "work_items.list", status: "ok" }],
      },
    );

    expect(display).toEqual({
      summary: "Manager checked 2 due tasks",
      workItemIds: ["work-1", "work-2"],
      toolCalls: [{ label: "work_items.list", status: "ok" }],
      rawPayload: JSON.stringify(
        { due_tasks: [{ id: "task-1" }, { id: "task-2" }] },
        null,
        2,
      ),
    });
  });

  it("prefers persisted tool calls over metadata tool call summaries", () => {
    const display = getManagerSchedulerMessageDisplay(
      JSON.stringify({ due_tasks: [{ id: "task-1" }] }),
      {
        source: "manager_scheduler",
        kind: "due_tasks",
        tool_calls: [{ tool_name: "metadata_tool", status: "ok" }],
      },
      [
        {
          id: "tool-call-1",
          input: JSON.stringify({
            call_id: "call-1",
            tool_name: "work_items.list",
            input: { arguments: { state: "due" } },
          }),
          output: JSON.stringify({
            status: "failed",
            error_code: "timeout",
            output: { error: "Timed out" },
          }),
        },
      ],
    );

    expect(display?.toolCalls).toEqual([
      {
        label: "work_items.list",
        status: "failed timeout",
        inputSummary: '{"state":"due"}',
        outputSummary: "Timed out",
      },
    ]);
  });

  it("shows raw persisted tool call text when JSON parsing fails", () => {
    const display = getManagerSchedulerMessageDisplay(
      JSON.stringify({ due_tasks: [{ id: "task-1" }] }),
      { source: "manager_scheduler", kind: "due_tasks" },
      [
        {
          id: "tool-call-1",
          input: "not-json-input",
          output: "not-json-output",
        },
      ],
    );

    expect(display?.toolCalls).toEqual([
      {
        label: "Tool call 1",
        inputSummary: "not-json-input",
        outputSummary: "not-json-output",
      },
    ]);
  });

  it("does not render an empty arguments wrapper for helper tool calls", () => {
    const display = getManagerSchedulerMessageDisplay(
      JSON.stringify({ due_tasks: [{ id: "task-1" }] }),
      { source: "manager_scheduler", kind: "due_tasks" },
      [
        {
          id: "tool-call-1",
          input: JSON.stringify({
            call_id: "call-1",
            tool_name: "git.run",
            input: { arguments: {} },
          }),
          output: JSON.stringify({
            status: "ok",
            output: JSON.stringify({
              argv: ["gh", "pr", "list"],
              cwd: "/Users/kevingrassi/Desktop/repos/openmacaw",
              ok: true,
            }),
          }),
        },
      ],
    );

    expect(display?.toolCalls[0]?.inputSummary).toBe(
      '{"command":"gh pr list","cwd":"/Users/kevingrassi/Desktop/repos/openmacaw"}',
    );
  });

  it("falls back to the due_tasks array count when ids are absent", () => {
    const display = getManagerSchedulerMessageDisplay(
      JSON.stringify({ due_tasks: [{ id: "task-1" }] }),
      { source: "manager_scheduler", kind: "due_tasks" },
    );

    expect(display?.summary).toBe("Manager checked 1 due task");
    expect(display?.workItemIds).toEqual([]);
  });

  it("preserves non-object scheduler content for debugging", () => {
    const textDisplay = getManagerSchedulerMessageDisplay("legacy payload", {
      source: "manager_scheduler",
      kind: "due_tasks",
    });
    const arrayDisplay = getManagerSchedulerMessageDisplay(
      JSON.stringify([{ id: "task-1" }]),
      {
        source: "manager_scheduler",
        kind: "due_tasks",
      },
    );

    expect(textDisplay?.rawPayload).toBe("legacy payload");
    expect(arrayDisplay?.rawPayload).toBe(JSON.stringify([{ id: "task-1" }]));
  });

  it("ignores non-manager-scheduler messages", () => {
    expect(
      getManagerSchedulerMessageDisplay("hello", {
        source: "user",
        kind: "due_tasks",
      }),
    ).toBeNull();
  });
});
