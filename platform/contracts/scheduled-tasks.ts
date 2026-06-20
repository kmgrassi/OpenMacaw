import { z } from "zod";

export const ScheduledTaskEveryUnitSchema = z.enum([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

const IsoDateTimeSchema = z.string().datetime({ offset: true });

const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm in 24-hour time");

export function isValidIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export const ScheduledTaskTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidIanaTimeZone, "Expected a valid IANA timezone name");

export const ScheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("at"),
    runAt: IsoDateTimeSchema,
  }),
  z.object({
    kind: z.literal("every"),
    interval: z.number().int().positive(),
    unit: ScheduledTaskEveryUnitSchema,
    at: TimeOfDaySchema.optional(),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: ScheduledTaskTimezoneSchema.optional(),
  }),
]);

export const ScheduledTaskDeliverySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scheduled_agent_message"),
    sessionStrategy: z.literal("scheduled_task").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const ScheduledTaskCrudDeliverySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scheduled_agent_message"),
    sessionStrategy: z.literal("scheduled_task").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const ScheduledTaskRunStatusSchema = z.enum([
  "claimed",
  "delivered",
  "failed",
  "skipped",
]);

export const ScheduledTaskProjectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  sourceWorkItemId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  title: z.string(),
  instructions: z.string(),
  enabled: z.boolean(),
  schedule: ScheduledTaskScheduleSchema,
  timezone: ScheduledTaskTimezoneSchema,
  nextRunAt: IsoDateTimeSchema,
  lastRunAt: IsoDateTimeSchema.nullable(),
  lastRunStatus: ScheduledTaskRunStatusSchema.nullable(),
  lastError: z.string().nullable(),
  delivery: ScheduledTaskDeliverySchema,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const ScheduledTaskCreateRequestSchema = z.object({
  agentId: z.string().uuid(),
  sourceWorkItemId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  schedule: ScheduledTaskScheduleSchema,
  timezone: ScheduledTaskTimezoneSchema.optional(),
  delivery: ScheduledTaskCrudDeliverySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ScheduledTaskUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  instructions: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  schedule: ScheduledTaskScheduleSchema.optional(),
  timezone: ScheduledTaskTimezoneSchema.optional(),
  delivery: ScheduledTaskCrudDeliverySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ScheduledTaskCancelRequestSchema = z.object({
  reason: z.string().trim().min(1).optional(),
});

export const ScheduledTaskListResponseSchema = z.object({
  scheduledTasks: z.array(ScheduledTaskProjectionSchema),
});

export const ScheduledTaskResponseSchema = z.object({
  scheduledTask: ScheduledTaskProjectionSchema,
});

export const ScheduledTaskCancelResponseSchema = z.object({
  cancelled: z.literal(true),
  scheduledTask: ScheduledTaskProjectionSchema,
});

export const ScheduledTaskRunNowResponseSchema = z.object({
  scheduledTask: ScheduledTaskProjectionSchema,
  scheduledFor: IsoDateTimeSchema,
});

export type ScheduledTaskSchedule = z.infer<typeof ScheduledTaskScheduleSchema>;
export type ScheduledTaskDelivery = z.infer<typeof ScheduledTaskDeliverySchema>;
export type ScheduledTaskCrudDelivery = z.infer<
  typeof ScheduledTaskCrudDeliverySchema
>;
export type ScheduledTaskRunStatus = z.infer<
  typeof ScheduledTaskRunStatusSchema
>;
export type ScheduledTaskProjection = z.infer<
  typeof ScheduledTaskProjectionSchema
>;
export type ScheduledTaskCreateRequest = z.infer<
  typeof ScheduledTaskCreateRequestSchema
>;
export type ScheduledTaskUpdateRequest = z.infer<
  typeof ScheduledTaskUpdateRequestSchema
>;
export type ScheduledTaskCancelRequest = z.infer<
  typeof ScheduledTaskCancelRequestSchema
>;
export type ScheduledTaskListResponse = z.infer<
  typeof ScheduledTaskListResponseSchema
>;
export type ScheduledTaskResponse = z.infer<typeof ScheduledTaskResponseSchema>;
export type ScheduledTaskCancelResponse = z.infer<
  typeof ScheduledTaskCancelResponseSchema
>;
export type ScheduledTaskRunNowResponse = z.infer<
  typeof ScheduledTaskRunNowResponseSchema
>;
