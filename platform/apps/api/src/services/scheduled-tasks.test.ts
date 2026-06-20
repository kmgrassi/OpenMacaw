import { describe, expect, it } from "vitest";

import type { ScheduledTaskProjection } from "../../../../contracts/scheduled-tasks.js";
import { computeScheduledTaskNextRunAt } from "./scheduled-tasks/schedule-calculator.js";
import { dispatchScheduledTaskDelivery } from "./scheduled-tasks.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function scheduledTask(delivery: ScheduledTaskProjection["delivery"]): ScheduledTaskProjection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    agentId,
    sourceWorkItemId: null,
    createdByUserId: null,
    title: "Scheduled work",
    instructions: "Run the scheduled work.",
    enabled: true,
    schedule: { kind: "every", interval: 1, unit: "day", at: "03:00" },
    timezone: "Etc/UTC",
    nextRunAt: "2026-05-18T03:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    delivery,
    metadata: {},
    createdAt: "2026-05-17T12:00:00.000Z",
    updatedAt: "2026-05-17T12:00:00.000Z",
  };
}

describe("computeScheduledTaskNextRunAt", () => {
  it("computes an hourly schedule from the current instant", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "hour" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-14T13:30:00.000Z");
  });

  it("computes the next daily wall-clock time in the requested timezone", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "day", at: "09:00" },
        "America/New_York",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-14T13:00:00.000Z");
  });

  it("rolls daily wall-clock schedules forward when today's time already passed", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 1, unit: "day", at: "09:00" },
        "America/New_York",
        new Date("2026-05-14T14:30:00.000Z"),
      ),
    ).toBe("2026-05-15T13:00:00.000Z");
  });

  it("computes every-three-weeks schedules", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "every", interval: 3, unit: "week" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-06-04T12:30:00.000Z");
  });

  it("computes the next five-field cron occurrence", () => {
    expect(
      computeScheduledTaskNextRunAt(
        { kind: "cron", expression: "0 9 * * 1", timezone: "America/New_York" },
        "Etc/UTC",
        new Date("2026-05-14T12:30:00.000Z"),
      ),
    ).toBe("2026-05-18T13:00:00.000Z");
  });
});

describe("dispatchScheduledTaskDelivery", () => {
  it("routes scheduled agent messages to the existing delivery path", async () => {
    await expect(
      dispatchScheduledTaskDelivery(
        scheduledTask({ kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" }),
      ),
    ).resolves.toEqual({ kind: "scheduled_agent_message", status: "not_handled" });
  });
});
