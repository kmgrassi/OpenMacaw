import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ScheduledTaskCancelRequestSchema,
  ScheduledTaskCreateRequestSchema,
  ScheduledTaskCrudDeliverySchema,
  ScheduledTaskDeliverySchema,
  ScheduledTaskListResponseSchema,
  ScheduledTaskRunNowResponseSchema,
  ScheduledTaskRunStatusSchema,
  ScheduledTaskScheduleSchema,
  ScheduledTaskUpdateRequestSchema,
} from "../../../../contracts/scheduled-tasks.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const scheduledTaskId = "33333333-3333-4333-8333-333333333333";
const sourceWorkItemId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const now = "2026-05-14T13:00:00.000Z";
const localTimeWithOffset = "2026-05-15T09:00:00-04:00";

const baseScheduledTask = {
  id: scheduledTaskId,
  workspaceId,
  agentId,
  sourceWorkItemId: null,
  createdByUserId: userId,
  title: "Review blocked PRs",
  instructions: "Find blocked PR-related work items and move them forward.",
  enabled: true,
  schedule: { kind: "every", interval: 1, unit: "hour" },
  timezone: "America/New_York",
  nextRunAt: now,
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
  delivery: { kind: "scheduled_agent_message" },
  metadata: {},
  createdAt: now,
  updatedAt: now,
} as const;

describe("scheduled task contracts", () => {
  it("accepts v1 schedule shapes", () => {
    expect(
      ScheduledTaskScheduleSchema.parse({
        kind: "at",
        runAt: localTimeWithOffset,
      }),
    ).toEqual({
      kind: "at",
      runAt: localTimeWithOffset,
    });

    expect(
      ScheduledTaskScheduleSchema.parse({
        kind: "every",
        interval: 1,
        unit: "day",
        at: "09:00",
      }),
    ).toEqual({
      kind: "every",
      interval: 1,
      unit: "day",
      at: "09:00",
    });

    expect(
      ScheduledTaskScheduleSchema.parse({
        kind: "every",
        interval: 3,
        unit: "week",
      }),
    ).toEqual({
      kind: "every",
      interval: 3,
      unit: "week",
    });

    expect(
      ScheduledTaskScheduleSchema.parse({
        kind: "every",
        interval: 1,
        unit: "month",
      }),
    ).toEqual({
      kind: "every",
      interval: 1,
      unit: "month",
    });

    expect(
      ScheduledTaskScheduleSchema.parse({
        kind: "cron",
        expression: "0 9 * * 1",
        timezone: "America/New_York",
      }),
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * 1",
      timezone: "America/New_York",
    });
  });

  it("rejects invalid schedule JSON", () => {
    expect(
      ScheduledTaskScheduleSchema.safeParse({
        kind: "every",
        interval: 0,
        unit: "hour",
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskScheduleSchema.safeParse({
        kind: "every",
        interval: 1,
        unit: "year",
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskScheduleSchema.safeParse({
        kind: "every",
        interval: 1,
        unit: "day",
        at: "9am",
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskScheduleSchema.safeParse({
        kind: "cron",
        expression: "   ",
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskScheduleSchema.safeParse({
        kind: "work_item_poll",
        interval: 1,
        unit: "hour",
      }).success,
    ).toBe(false);
  });

  it("keeps scheduled task delivery and statuses explicit", () => {
    expect(
      ScheduledTaskDeliverySchema.parse({
        kind: "scheduled_agent_message",
        sessionStrategy: "scheduled_task",
      }),
    ).toEqual({
      kind: "scheduled_agent_message",
      sessionStrategy: "scheduled_task",
    });
    expect(ScheduledTaskDeliverySchema.safeParse({ kind: "unknown" }).success).toBe(false);
    expect(ScheduledTaskDeliverySchema.safeParse({ kind: "learning_reflection" }).success).toBe(false);
    expect(
      ScheduledTaskDeliverySchema.safeParse({
        kind: "learning_distillation",
        windowDays: 0,
      }).success,
    ).toBe(false);
    expect(ScheduledTaskDeliverySchema.safeParse({ kind: "unknown" }).success).toBe(false);
    expect(ScheduledTaskCrudDeliverySchema.safeParse({ kind: "scheduled_agent_message" }).success).toBe(true);
    expect(
      ScheduledTaskCrudDeliverySchema.safeParse({ kind: "learning_reflection", sourceRunId: "run-123" }).success,
    ).toBe(false);
    expect(ScheduledTaskCrudDeliverySchema.safeParse({ kind: "learning_distillation" }).success).toBe(false);

    expect(ScheduledTaskRunStatusSchema.parse("claimed")).toBe("claimed");
    expect(ScheduledTaskRunStatusSchema.parse("delivered")).toBe("delivered");
    expect(ScheduledTaskRunStatusSchema.parse("failed")).toBe("failed");
    expect(ScheduledTaskRunStatusSchema.parse("skipped")).toBe("skipped");
    expect(ScheduledTaskRunStatusSchema.safeParse("queued").success).toBe(false);
  });

  it("snapshots the scheduled task delivery JSON schema", () => {
    expect(z.toJSONSchema(ScheduledTaskDeliverySchema, { io: "input" })).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "oneOf": [
          {
            "properties": {
              "kind": {
                "const": "scheduled_agent_message",
                "type": "string",
              },
              "metadata": {
                "additionalProperties": {},
                "propertyNames": {
                  "type": "string",
                },
                "type": "object",
              },
              "sessionStrategy": {
                "const": "scheduled_task",
                "type": "string",
              },
            },
            "required": [
              "kind",
            ],
            "type": "object",
          },
        ],
      }
    `);
  });

  it("validates create and update request projections", () => {
    const createRequest = ScheduledTaskCreateRequestSchema.parse({
      agentId,
      sourceWorkItemId,
      title: "Audit runtime setup",
      instructions: "Review local runtime setup and create follow-up notes.",
      schedule: { kind: "every", interval: 3, unit: "week", at: "09:00" },
      timezone: "America/New_York",
      delivery: { kind: "scheduled_agent_message" },
      metadata: { source: "manager_agent" },
    });

    expect(createRequest.sourceWorkItemId).toBe(sourceWorkItemId);
    expect(createRequest.schedule).toEqual({
      kind: "every",
      interval: 3,
      unit: "week",
      at: "09:00",
    });

    expect(
      ScheduledTaskUpdateRequestSchema.safeParse({
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      ScheduledTaskCancelRequestSchema.parse({
        reason: "User asked to stop the weekly review.",
      }).reason,
    ).toBe("User asked to stop the weekly review.");
    expect(
      ScheduledTaskCreateRequestSchema.safeParse({
        agentId,
        title: "Nightly distillation",
        instructions: "Summarize recent memories.",
        schedule: { kind: "every", interval: 1, unit: "day", at: "09:00" },
        delivery: { kind: "learning_distillation" },
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskUpdateRequestSchema.safeParse({
        delivery: { kind: "learning_reflection", sourceRunId: "run-123" },
      }).success,
    ).toBe(false);
  });

  it("validates list and run-now responses", () => {
    const listResponse = ScheduledTaskListResponseSchema.parse({
      scheduledTasks: [baseScheduledTask],
    });

    expect(listResponse.scheduledTasks[0]?.id).toBe(scheduledTaskId);

    const runNowResponse = ScheduledTaskRunNowResponseSchema.parse({
      scheduledTask: {
        ...baseScheduledTask,
        lastRunStatus: "delivered",
        lastRunAt: now,
      },
      scheduledFor: localTimeWithOffset,
    });

    expect(runNowResponse.scheduledFor).toBe(localTimeWithOffset);
  });
});
