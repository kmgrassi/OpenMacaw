import type { Json, Tables, TablesInsert } from "@kmgrassi/supabase-schema";
import type { PlanTaskV1, PlanV1 } from "@harper/plan-schema";
import type { PlanRecord } from "../../../../contracts/plans.js";
import type {
  WorkItemProjection,
  WorkItemSnoozeActor,
  WorkItemSnoozeProjection,
  WorkItemSource,
} from "../../../../contracts/work-items.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";

type JsonObject = { [key: string]: Json | undefined };
type PersistablePlan = PlanV1 & { workspaceId: string };
type PlanRow = Tables<"plan">;
type WorkItemRow = Tables<"work_items">;
type EventLogRow = Tables<"event_log">;

export class PlanGraphValidationError extends Error {
  details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "PlanGraphValidationError";
    this.details = details;
  }
}

function labelsToWorkItemLabels(labels: Record<string, string> | undefined): string[] {
  return Object.entries(labels ?? {})
    .map(([key, value]) => `${key}:${value}`.trim())
    .filter((label) => label.length > 0);
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as JsonObject;
}

function validateTaskGraph(tasks: PlanTaskV1[]) {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new PlanGraphValidationError("Task ids must be unique", { task_id: task.id });
    }
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new PlanGraphValidationError("Task dependsOn entries must reference tasks in the same plan", {
          taskId: task.id,
          dependsOn: dependency,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  function visit(taskId: string, path: string[]) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new PlanGraphValidationError("Task dependency graph must not contain cycles", {
        cycle: [...path, taskId],
      });
    }

    visiting.add(taskId);
    const task = byId.get(taskId);
    for (const dependency of task?.dependsOn ?? []) {
      visit(dependency, [...path, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id, []);
  }
}

export function mapPlanRow(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? "",
    name: row.name,
    description: row.description,
    status: row.status ?? "unknown",
    metadata: row.metadata as Record<string, unknown>,
    schemaVersion: row.schema_version,
    intent: row.intent,
    defaultRunnerKind: row.default_runner_kind,
    defaultModel: row.default_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isJsonObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoUtc(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseSnoozeActor(value: Json | undefined): WorkItemSnoozeActor | null {
  if (!value || !isJsonObject(value) || typeof value.kind !== "string") {
    return null;
  }

  if (value.kind === "user" && typeof value.user_id === "string") {
    return { kind: "user", userId: value.user_id };
  }
  if (value.kind === "agent" && typeof value.agent_id === "string") {
    return { kind: "agent", agentId: value.agent_id };
  }
  return null;
}

export function mapWorkItemSnoozeEvent(row: EventLogRow | null | undefined): WorkItemSnoozeProjection | null {
  if (!row || row.kind !== "work_item.snoozed" || !isJsonObject(row.payload)) {
    return null;
  }

  const actor = parseSnoozeActor(row.payload.actor);
  if (!actor) return null;

  const snoozedAt =
    toIsoUtc(typeof row.payload.snoozed_at === "string" ? row.payload.snoozed_at : null) ?? toIsoUtc(row.created_at);
  if (!snoozedAt) return null;

  return {
    indefinite: row.payload.indefinite === true,
    reason: typeof row.payload.reason === "string" ? row.payload.reason : null,
    snoozedAt,
    snoozedBy: actor,
  };
}

export function mapWorkItemRow(row: WorkItemRow, snoozeEvent?: EventLogRow | null): WorkItemProjection {
  const nextPollAt = toIsoUtc(row.next_poll_at);
  const lastPolledAt = toIsoUtc(row.last_polled_at);
  const isSnoozed = typeof nextPollAt === "string" && Date.parse(nextPollAt) > Date.now();

  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    identifier: row.identifier ?? undefined,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    state: row.state,
    priority: row.priority,
    source: row.source as WorkItemSource,
    runnerKind: row.runner_kind,
    repository: row.repository,
    labels: row.labels,
    dependsOn: row.depends_on,
    completionGates: row.completion_gates,
    metadata: row.metadata as Record<string, unknown>,
    nextPollAt,
    lastPolledAt,
    pollCadenceSeconds: row.poll_cadence_seconds,
    snooze: isSnoozed ? mapWorkItemSnoozeEvent(snoozeEvent) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requirePlanRecord(row: PlanRow | undefined): PlanRecord {
  if (!row?.id || !row.workspace_id) {
    throw new Error("Plan insert returned no row");
  }
  return mapPlanRow(row);
}

function buildWorkItemRows(plan: PersistablePlan, planId: string, now: string): TablesInsert<"work_items">[] {
  // Ids are generated by the database (work_items.id defaults to gen_random_uuid()).
  // Cross-references in depends_on are resolved after insert via author_task_id — see
  // resolveWorkItemDependencies — so the app never has to mint its own primary keys.
  return plan.tasks.map((task) => {
    return {
      workspace_id: plan.workspaceId,
      plan_id: planId,
      title: task.title,
      description: task.instructions,
      instructions: task.instructions,
      state: "todo",
      priority: null,
      source: "api",
      labels: labelsToWorkItemLabels(task.labels),
      metadata: asJsonObject({
        author_task_id: task.id,
        labels: task.labels ?? {},
        created_via: "api_plan",
      }),
      completion_gates: task.completionGates ?? [],
      updated_at: now,
    } satisfies TablesInsert<"work_items">;
  });
}

function authorTaskIdOf(row: WorkItemRow): string | null {
  const metadata = row.metadata;
  if (metadata !== null && isJsonObject(metadata) && typeof metadata.author_task_id === "string") {
    return metadata.author_task_id;
  }
  return null;
}

function workItemIdByAuthorTaskId(insertedWorkItems: WorkItemRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of insertedWorkItems) {
    const authorTaskId = authorTaskIdOf(row);
    if (authorTaskId) {
      map.set(authorTaskId, row.id);
    }
  }
  return map;
}

// Second pass: now that the DB has assigned each work item a primary key, translate the
// author task graph into work_item id references and persist depends_on. The inserted rows
// are mutated in place so the returned projection reflects the resolved dependencies.
async function resolveWorkItemDependencies(
  plan: PersistablePlan,
  insertedWorkItems: WorkItemRow[],
  idByAuthorTaskId: Map<string, string>,
  now: string,
): Promise<void> {
  const rowByAuthorTaskId = new Map(insertedWorkItems.map((row) => [authorTaskIdOf(row), row] as const));

  for (const task of plan.tasks) {
    const dependsOn = task.dependsOn ?? [];
    if (dependsOn.length === 0) continue;

    const workItemId = idByAuthorTaskId.get(task.id);
    if (!workItemId) {
      throw new Error(`No work item found for task ${task.id}`);
    }

    const resolvedDependsOn = dependsOn.map((dependency) => idByAuthorTaskId.get(dependency) ?? dependency);

    await executeSupabaseRows<WorkItemRow>(
      "work_items dependency update",
      getServiceRoleSupabase()
        .from("work_items")
        .update({ depends_on: resolvedDependsOn, updated_at: now })
        .eq("id", workItemId)
        .select("*"),
    );

    const row = rowByAuthorTaskId.get(task.id);
    if (row) {
      row.depends_on = resolvedDependsOn;
    }
  }
}

function orderWorkItemsByTask(
  plan: PersistablePlan,
  insertedWorkItems: WorkItemRow[],
  idByAuthorTaskId: Map<string, string>,
) {
  const updatedWorkItems: WorkItemRow[] = [];
  for (const task of plan.tasks) {
    const workItemId = idByAuthorTaskId.get(task.id);
    const workItem = insertedWorkItems.find((item) => item.id === workItemId);
    if (!workItem) {
      throw new Error(`No work item found for task ${task.id}`);
    }
    updatedWorkItems.push(workItem);
  }
  return updatedWorkItems;
}

export async function createPlanWithWorkItems(plan: PersistablePlan): Promise<{
  plan: PlanRecord;
  workItems: WorkItemProjection[];
}> {
  validateTaskGraph(plan.tasks);

  const now = new Date().toISOString();
  const planRows = await executeSupabaseRows<PlanRow>(
    "plan insert",
    getServiceRoleSupabase()
      .from("plan")
      .insert({
        workspace_id: plan.workspaceId,
        name: plan.title,
        description: plan.intent,
        status: "pending",
        metadata: plan as unknown as Json,
        schema_version: "1",
        intent: plan.intent,
        default_runner_kind: plan.defaultRunner ?? null,
        default_model: plan.defaultModel ?? null,
        updated_at: now,
      } satisfies TablesInsert<"plan">)
      .select("*"),
  );
  const createdPlan = requirePlanRecord(planRows[0]);

  try {
    const workItemRows = buildWorkItemRows(plan, createdPlan.id, now);

    const insertedWorkItems = await executeSupabaseRows<WorkItemRow>(
      "work_items insert",
      getServiceRoleSupabase().from("work_items").insert(workItemRows).select("*"),
    );

    if (insertedWorkItems.length !== plan.tasks.length) {
      throw new Error("Work item insert returned an unexpected number of rows");
    }

    const idByAuthorTaskId = workItemIdByAuthorTaskId(insertedWorkItems);
    if (idByAuthorTaskId.size !== plan.tasks.length) {
      throw new Error("Inserted work items did not map back to every plan task");
    }

    await resolveWorkItemDependencies(plan, insertedWorkItems, idByAuthorTaskId, now);

    const updatedWorkItems = orderWorkItemsByTask(plan, insertedWorkItems, idByAuthorTaskId);

    return {
      plan: createdPlan,
      workItems: updatedWorkItems.map((workItem) => mapWorkItemRow(workItem)),
    };
  } catch (error) {
    await executeSupabaseRows(
      "work_items delete",
      getServiceRoleSupabase().from("work_items").delete().eq("plan_id", createdPlan.id).select("*"),
    ).catch(() => undefined);
    await executeSupabaseRows(
      "plan delete",
      getServiceRoleSupabase().from("plan").delete().eq("id", createdPlan.id).select("*"),
    );
    throw error;
  }
}
