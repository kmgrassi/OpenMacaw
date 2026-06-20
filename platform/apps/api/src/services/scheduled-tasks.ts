import type { PostgrestError } from "@supabase/supabase-js";

import type {
  ScheduledTaskCancelResponse,
  ScheduledTaskCreateRequest,
  ScheduledTaskListResponse,
  ScheduledTaskProjection,
  ScheduledTaskResponse,
  ScheduledTaskRunNowResponse,
  ScheduledTaskUpdateRequest,
} from "../../../../contracts/scheduled-tasks.js";
import {
  ScheduledTaskCancelResponseSchema,
  ScheduledTaskDeliverySchema,
  ScheduledTaskListResponseSchema,
  ScheduledTaskResponseSchema,
  ScheduledTaskRunNowResponseSchema,
  ScheduledTaskRunStatusSchema,
  ScheduledTaskScheduleSchema,
} from "../../../../contracts/scheduled-tasks.js";
import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { computeScheduledTaskNextRunAt } from "./scheduled-tasks/schedule-calculator.js";

type JsonRecord = Record<string, unknown>;
type QueryResult<Row> = PromiseLike<{ data: Row[] | Row | null; error: PostgrestError | null }>;
type QueryBuilder<Row> = PromiseLike<{ data: Row[]; error: PostgrestError | null; count: number }> & {
  select(columns?: string): QueryBuilder<Row>;
  eq(column: string, value: unknown): QueryBuilder<Row>;
  in(column: string, value: unknown[]): QueryBuilder<Row>;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder<Row>;
  limit(count: number): QueryBuilder<Row>;
  insert(body: JsonRecord | JsonRecord[]): QueryBuilder<Row>;
  update(body: JsonRecord): QueryBuilder<Row>;
  single(): QueryResult<Row>;
};
type ScheduledTaskSupabase = {
  from<Row = JsonRecord>(table: string): QueryBuilder<Row>;
};

type AgentRow = {
  id: string;
  workspace_id: string;
  type: string | null;
};

type WorkItemRow = {
  id: string;
  workspace_id: string | null;
};

type ScheduledTaskRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  source_work_item_id: string | null;
  created_by_user_id: string | null;
  title: string | null;
  instructions: string | null;
  enabled: boolean;
  schedule: unknown;
  timezone: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_error: string | null;
  delivery: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

const DEFAULT_DELIVERY = { kind: "scheduled_agent_message", sessionStrategy: "scheduled_task" } as const;
const DEFAULT_TIMEZONE = "Etc/UTC";
function scheduledTaskSupabase(): ScheduledTaskSupabase {
  return getServiceRoleSupabase() as unknown as ScheduledTaskSupabase;
}

function missingScheduledTaskSchema(error: unknown) {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("PGRST204") ||
    message.includes("PGRST205") ||
    message.includes("42703") ||
    message.includes("Could not find") ||
    message.includes("column scheduled_task.") ||
    message.includes("schema cache")
  );
}

async function executeScheduledTaskRows<Row>(
  context: string,
  query: PromiseLike<{ data: unknown; error: PostgrestError | null }>,
) {
  try {
    return await executeSupabaseRows<Row>(context, query);
  } catch (error) {
    if (missingScheduledTaskSchema(error)) {
      throw new ApiRouteError(
        503,
        "scheduled_task_schema_unavailable",
        "Scheduled task API requires the v1 scheduled_task schema migration and generated type sync before it can be used",
        { context },
      );
    }
    throw error;
  }
}

async function assertScheduledTaskSchemaReady() {
  await executeScheduledTaskRows<{ id: string }>(
    "scheduled_task schema readiness",
    scheduledTaskSupabase()
      .from("scheduled_task")
      .select("id, workspace_id, title, enabled, schedule, next_run_at, delivery, metadata")
      .limit(1),
  );
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

export { computeScheduledTaskNextRunAt } from "./scheduled-tasks/schedule-calculator.js";

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeLegacyTimeOfDay(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
  return match ? value.slice(0, 5) : value;
}

function normalizeLegacyEveryUnit(value: unknown) {
  if (typeof value !== "string") return null;
  const unit = value.endsWith("s") ? value.slice(0, -1) : value;
  return ["minute", "hour", "day", "week", "month"].includes(unit) ? unit : null;
}

function normalizeScheduledTaskSchedule(value: unknown) {
  const parsed = ScheduledTaskScheduleSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const record = jsonRecord(value);
  if (!record) {
    return ScheduledTaskScheduleSchema.parse(value);
  }

  if (typeof record.at === "string" && !("every" in record)) {
    return ScheduledTaskScheduleSchema.parse({ kind: "at", runAt: record.at });
  }

  const everyRecord = jsonRecord(record.every);
  const legacyUnit = everyRecord ? normalizeLegacyEveryUnit(everyRecord.unit) : normalizeLegacyEveryUnit(record.every);
  const legacyInterval = everyRecord && typeof everyRecord.interval === "number" ? everyRecord.interval : 1;
  if (legacyUnit) {
    return ScheduledTaskScheduleSchema.parse({
      kind: "every",
      interval: legacyInterval,
      unit: legacyUnit,
      at: normalizeLegacyTimeOfDay(record.at),
    });
  }

  return ScheduledTaskScheduleSchema.parse(value);
}

function safeNormalizeScheduledTaskSchedule(value: unknown) {
  try {
    return normalizeScheduledTaskSchedule(value);
  } catch {
    return null;
  }
}

function isEmptyRecord(value: unknown) {
  const record = jsonRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function scheduledTaskDelivery(row: ScheduledTaskRow) {
  if (row.delivery === null || row.delivery === undefined || isEmptyRecord(row.delivery)) {
    return DEFAULT_DELIVERY;
  }
  return ScheduledTaskDeliverySchema.parse(row.delivery);
}

function isUserVisibleScheduledTaskRow(row: ScheduledTaskRow) {
  let delivery;
  try {
    delivery = scheduledTaskDelivery(row);
  } catch {
    return false;
  }
  if (delivery.kind !== "scheduled_agent_message") return false;

  const schedule = safeNormalizeScheduledTaskSchedule(row.schedule);
  if (row.next_run_at === null && schedule?.kind === "at") return false;

  return true;
}

function fallbackScheduledTaskTitle(_row: ScheduledTaskRow) {
  return "Scheduled task";
}

function mapScheduledTaskRow(row: ScheduledTaskRow): ScheduledTaskProjection {
  const delivery = scheduledTaskDelivery(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    sourceWorkItemId: row.source_work_item_id,
    createdByUserId: row.created_by_user_id,
    title: row.title ?? fallbackScheduledTaskTitle(row),
    instructions: row.instructions ?? "",
    enabled: row.enabled,
    schedule: normalizeScheduledTaskSchedule(row.schedule),
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
    nextRunAt: row.next_run_at ?? row.created_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status === null ? null : ScheduledTaskRunStatusSchema.parse(row.last_run_status),
    lastError: row.last_error,
    delivery,
    metadata: jsonRecord(row.metadata) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isScheduledTaskAgentType(type: string | null) {
  return type === "manager" || type === "router";
}

async function assertScheduledTaskAgentBelongsToWorkspace(workspaceId: string, agentId: string) {
  const rows = await executeSupabaseRows<AgentRow>(
    "scheduled_task agent validation",
    scheduledTaskSupabase().from<AgentRow>("agent").select("id, workspace_id, type").eq("id", agentId).limit(1),
  );
  const agent = rows[0];
  if (!agent || agent.workspace_id !== workspaceId || !isScheduledTaskAgentType(agent.type)) {
    throw new ApiRouteError(
      404,
      "scheduled_task_agent_not_found",
      "Scheduled-task agent was not found in this workspace",
    );
  }
}

async function listScheduledTaskAgentIdsForWorkspace(workspaceId: string) {
  const rows = await executeSupabaseRows<AgentRow>(
    "scheduled_task agents list",
    scheduledTaskSupabase().from<AgentRow>("agent").select("id, workspace_id, type").eq("workspace_id", workspaceId),
  );
  return rows.filter((row) => isScheduledTaskAgentType(row.type)).map((row) => row.id);
}

async function assertSourceWorkItemBelongsToWorkspace(
  workspaceId: string,
  sourceWorkItemId: string | null | undefined,
) {
  if (!sourceWorkItemId) return;
  const rows = await executeSupabaseRows<WorkItemRow>(
    "scheduled_task source work item validation",
    scheduledTaskSupabase()
      .from<WorkItemRow>("work_items")
      .select("id, workspace_id")
      .eq("id", sourceWorkItemId)
      .eq("workspace_id", workspaceId)
      .limit(1),
  );
  if (!rows[0]) {
    throw new ApiRouteError(400, "invalid_source_work_item", "Source work item was not found in this workspace");
  }
}

async function findScheduledTask(workspaceId: string, scheduledTaskId: string, agentId?: string) {
  const query = scheduledTaskSupabase()
    .from<ScheduledTaskRow>("scheduled_task")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", scheduledTaskId);
  if (agentId) query.eq("agent_id", agentId);

  const rows = await executeScheduledTaskRows<ScheduledTaskRow>("scheduled_task lookup", query.limit(1));
  return rows[0] ?? null;
}

function notFound(): never {
  throw new ApiRouteError(404, "scheduled_task_not_found", "Scheduled task was not found in this workspace");
}
export async function listScheduledTasksForWorkspace(
  workspaceId: string,
  agentId?: string,
): Promise<ScheduledTaskListResponse> {
  await assertScheduledTaskSchemaReady();
  if (agentId) {
    await assertScheduledTaskAgentBelongsToWorkspace(workspaceId, agentId);
  }
  const scheduledTaskAgentIds = agentId ? [agentId] : await listScheduledTaskAgentIdsForWorkspace(workspaceId);
  if (scheduledTaskAgentIds.length === 0) {
    return ScheduledTaskListResponseSchema.parse({ scheduledTasks: [] });
  }

  const rows = await executeScheduledTaskRows<ScheduledTaskRow>(
    "scheduled_task list",
    scheduledTaskSupabase()
      .from<ScheduledTaskRow>("scheduled_task")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("agent_id", scheduledTaskAgentIds)
      .order("next_run_at", { ascending: true }),
  );
  return ScheduledTaskListResponseSchema.parse({
    scheduledTasks: rows.filter(isUserVisibleScheduledTaskRow).map(mapScheduledTaskRow),
  });
}

export async function createScheduledTaskForWorkspace(params: {
  workspaceId: string;
  userId: string;
  request: ScheduledTaskCreateRequest;
  now?: Date;
}): Promise<ScheduledTaskResponse> {
  const { workspaceId, userId, request, now = new Date() } = params;
  await assertScheduledTaskSchemaReady();
  await assertScheduledTaskAgentBelongsToWorkspace(workspaceId, request.agentId);
  await assertSourceWorkItemBelongsToWorkspace(workspaceId, request.sourceWorkItemId);

  const timezone =
    request.timezone ?? (request.schedule.kind === "cron" ? request.schedule.timezone : undefined) ?? DEFAULT_TIMEZONE;
  const body: JsonRecord = {
    workspace_id: workspaceId,
    agent_id: request.agentId,
    source_work_item_id: request.sourceWorkItemId ?? null,
    created_by_user_id: userId,
    title: request.title,
    instructions: request.instructions,
    enabled: request.enabled ?? true,
    schedule: request.schedule,
    timezone,
    next_run_at: computeScheduledTaskNextRunAt(request.schedule, timezone, now),
    last_run_at: null,
    last_run_status: null,
    last_error: null,
    delivery: request.delivery ?? DEFAULT_DELIVERY,
    metadata: request.metadata ?? {},
    updated_at: nowIso(now),
  };

  const rows = await executeScheduledTaskRows<ScheduledTaskRow>(
    "scheduled_task insert",
    scheduledTaskSupabase().from<ScheduledTaskRow>("scheduled_task").insert(body).select("*"),
  );
  const scheduledTask = rows[0];
  if (!scheduledTask) {
    throw new ApiRouteError(502, "scheduled_task_create_failed", "Scheduled task creation returned no row");
  }
  return ScheduledTaskResponseSchema.parse({ scheduledTask: mapScheduledTaskRow(scheduledTask) });
}

export async function updateScheduledTaskForWorkspace(params: {
  workspaceId: string;
  scheduledTaskId: string;
  agentId?: string;
  request: ScheduledTaskUpdateRequest;
  now?: Date;
}): Promise<ScheduledTaskResponse> {
  const { workspaceId, scheduledTaskId, agentId, request, now = new Date() } = params;
  await assertScheduledTaskSchemaReady();
  const existing = (await findScheduledTask(workspaceId, scheduledTaskId, agentId)) ?? notFound();
  await assertScheduledTaskAgentBelongsToWorkspace(workspaceId, existing.agent_id);
  const nextSchedule = request.schedule ?? normalizeScheduledTaskSchedule(existing.schedule);
  const nextTimezone =
    request.timezone ??
    (nextSchedule.kind === "cron" ? nextSchedule.timezone : undefined) ??
    existing.timezone ??
    DEFAULT_TIMEZONE;

  const body: JsonRecord = {
    updated_at: nowIso(now),
    next_run_at: computeScheduledTaskNextRunAt(nextSchedule, nextTimezone, now),
  };
  if (request.title !== undefined) body.title = request.title;
  if (request.instructions !== undefined) body.instructions = request.instructions;
  if (request.enabled !== undefined) body.enabled = request.enabled;
  if (request.schedule !== undefined) body.schedule = request.schedule;
  if (request.timezone !== undefined || nextTimezone !== existing.timezone) body.timezone = nextTimezone;
  if (request.delivery !== undefined) body.delivery = request.delivery;
  if (request.metadata !== undefined) body.metadata = request.metadata;

  const rows = await executeScheduledTaskRows<ScheduledTaskRow>(
    "scheduled_task update",
    scheduledTaskSupabase()
      .from<ScheduledTaskRow>("scheduled_task")
      .update(body)
      .eq("workspace_id", workspaceId)
      .eq("id", scheduledTaskId)
      .select("*"),
  );
  const scheduledTask = rows[0] ?? notFound();
  return ScheduledTaskResponseSchema.parse({ scheduledTask: mapScheduledTaskRow(scheduledTask) });
}

export async function cancelScheduledTaskForWorkspace(params: {
  workspaceId: string;
  scheduledTaskId: string;
  agentId?: string;
  reason?: string;
  now?: Date;
}): Promise<ScheduledTaskCancelResponse> {
  const { workspaceId, scheduledTaskId, agentId, reason, now = new Date() } = params;
  await assertScheduledTaskSchemaReady();
  const existing = await findScheduledTask(workspaceId, scheduledTaskId, agentId);
  if (!existing) {
    notFound();
  }
  await assertScheduledTaskAgentBelongsToWorkspace(workspaceId, existing.agent_id);
  const rows = await executeScheduledTaskRows<ScheduledTaskRow>(
    "scheduled_task cancel",
    scheduledTaskSupabase()
      .from<ScheduledTaskRow>("scheduled_task")
      .update({
        enabled: false,
        last_error: reason ?? null,
        updated_at: nowIso(now),
      })
      .eq("workspace_id", workspaceId)
      .eq("id", scheduledTaskId)
      .select("*"),
  );
  const scheduledTask = rows[0] ?? notFound();
  return ScheduledTaskCancelResponseSchema.parse({
    cancelled: true,
    scheduledTask: mapScheduledTaskRow(scheduledTask),
  });
}

export async function runScheduledTaskNowForWorkspace(params: {
  workspaceId: string;
  scheduledTaskId: string;
  agentId?: string;
  now?: Date;
}): Promise<ScheduledTaskRunNowResponse> {
  const { workspaceId, scheduledTaskId, agentId, now = new Date() } = params;
  await assertScheduledTaskSchemaReady();
  const existing = await findScheduledTask(workspaceId, scheduledTaskId, agentId);
  if (!existing) {
    notFound();
  }
  await assertScheduledTaskAgentBelongsToWorkspace(workspaceId, existing.agent_id);
  if (!existing.enabled) {
    throw new ApiRouteError(409, "scheduled_task_disabled", "Canceled or disabled scheduled tasks cannot be run now");
  }
  const scheduledFor = nowIso(now);
  const rows = await executeScheduledTaskRows<ScheduledTaskRow>(
    "scheduled_task run now",
    scheduledTaskSupabase()
      .from<ScheduledTaskRow>("scheduled_task")
      .update({
        next_run_at: scheduledFor,
        updated_at: scheduledFor,
      })
      .eq("workspace_id", workspaceId)
      .eq("id", scheduledTaskId)
      .select("*"),
  );
  const scheduledTask = rows[0] ?? notFound();
  return ScheduledTaskRunNowResponseSchema.parse({
    scheduledTask: mapScheduledTaskRow(scheduledTask),
    scheduledFor,
  });
}

export async function dispatchScheduledTaskForWorkspace(params: {
  workspaceId: string;
  scheduledTaskId: string;
  agentId?: string;
}): Promise<ScheduledTaskDeliveryDispatchResult> {
  const { workspaceId, scheduledTaskId, agentId } = params;
  await assertScheduledTaskSchemaReady();
  const existing = await findScheduledTask(workspaceId, scheduledTaskId, agentId);
  if (!existing) {
    notFound();
  }
  if (!existing.enabled) {
    throw new ApiRouteError(
      409,
      "scheduled_task_disabled",
      "Canceled or disabled scheduled tasks cannot be dispatched",
    );
  }
  return dispatchScheduledTaskDelivery(mapScheduledTaskRow(existing));
}

export type ScheduledTaskDeliveryDispatchResult = { kind: "scheduled_agent_message"; status: "not_handled" };

export async function dispatchScheduledTaskDelivery(
  _scheduledTask: ScheduledTaskProjection,
): Promise<ScheduledTaskDeliveryDispatchResult> {
  return { kind: "scheduled_agent_message", status: "not_handled" };
}
