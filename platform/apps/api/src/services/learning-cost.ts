import type {
  LearningCostByKindEntry,
  LearningCostDailyEntry,
  LearningCostKind,
  LearningCostResponse,
  LearningCostTotals,
} from "../../../../contracts/learning-cost.js";
import { ApiRouteError } from "../http.js";
import {
  jsonRecord,
  listLearningCostRows,
  type LearningBrokerRunRow,
  type LearningBrokerTaskRow,
} from "../repositories/learning-cost.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";

const LEARNING_KIND_BY_TASK_TYPE: Record<string, LearningCostKind> = {
  learning_retrieval: "retrieval",
  retrieval: "retrieval",
  memory_search: "retrieval",
  "memory.search": "retrieval",
};

function emptyTotals(): LearningCostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

function addTotals(target: LearningCostTotals, source: LearningCostTotals) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function costFromRecord(record: Record<string, unknown>): number | null {
  for (const key of ["costUsd", "cost_usd", "totalCost", "total_cost", "cost"]) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }

  const usage = record.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    return costFromRecord(usage as Record<string, unknown>);
  }

  const learning = record.learning;
  if (learning && typeof learning === "object" && !Array.isArray(learning)) {
    return costFromRecord(learning as Record<string, unknown>);
  }

  return null;
}

function taskCost(task: LearningBrokerTaskRow, run: LearningBrokerRunRow): number {
  const eventCost = costFromRecord(jsonRecord(task.last_event));
  if (eventCost !== null) return eventCost;

  const metadataCost = costFromRecord(jsonRecord(run.metadata));
  return metadataCost ?? 0;
}

function classifyTask(task: LearningBrokerTaskRow): LearningCostKind | null {
  return LEARNING_KIND_BY_TASK_TYPE[task.type] ?? null;
}

function taskTotals(task: LearningBrokerTaskRow, run: LearningBrokerRunRow): LearningCostTotals {
  return {
    inputTokens: task.input_tokens,
    outputTokens: task.output_tokens,
    totalTokens: task.total_tokens,
    totalCost: taskCost(task, run),
  };
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function createKindEntry(kind: LearningCostKind): LearningCostByKindEntry {
  return {
    kind,
    taskCount: 0,
    runCount: 0,
    totals: emptyTotals(),
  };
}

function createDailyEntry(date: string): LearningCostDailyEntry {
  return {
    date,
    taskCount: 0,
    runCount: 0,
    totals: emptyTotals(),
  };
}

export function rollupLearningCost(input: {
  startDate: string;
  endDate: string;
  runs: LearningBrokerRunRow[];
  tasks: LearningBrokerTaskRow[];
}): LearningCostResponse {
  const runsById = new Map(input.runs.map((run) => [run.run_id, run]));
  const runIdsByKind = new Map<LearningCostKind, Set<string>>();
  const runIdsByDate = new Map<string, Set<string>>();
  const byKind = new Map<LearningCostKind, LearningCostByKindEntry>();
  const daily = new Map<string, LearningCostDailyEntry>();
  const totals = emptyTotals();

  for (const task of input.tasks) {
    const run = runsById.get(task.run_id);
    if (!run) continue;

    const kind = classifyTask(task);
    if (!kind) continue;

    const itemTotals = taskTotals(task, run);
    const kindEntry = byKind.get(kind) ?? createKindEntry(kind);
    kindEntry.taskCount += 1;
    addTotals(kindEntry.totals, itemTotals);
    byKind.set(kind, kindEntry);

    const day = dateKey(task.created_at || run.created_at);
    const dailyEntry = daily.get(day) ?? createDailyEntry(day);
    dailyEntry.taskCount += 1;
    addTotals(dailyEntry.totals, itemTotals);
    daily.set(day, dailyEntry);

    addTotals(totals, itemTotals);

    const kindRunIds = runIdsByKind.get(kind) ?? new Set<string>();
    kindRunIds.add(task.run_id);
    runIdsByKind.set(kind, kindRunIds);

    const dateRunIds = runIdsByDate.get(day) ?? new Set<string>();
    dateRunIds.add(task.run_id);
    runIdsByDate.set(day, dateRunIds);
  }

  for (const [kind, entry] of byKind) {
    entry.runCount = runIdsByKind.get(kind)?.size ?? 0;
  }
  for (const [day, entry] of daily) {
    entry.runCount = runIdsByDate.get(day)?.size ?? 0;
  }

  return {
    updatedAt: Date.now(),
    startDate: input.startDate,
    endDate: input.endDate,
    totals,
    aggregates: {
      byKind: Array.from(byKind.values()).sort((left, right) => left.kind.localeCompare(right.kind)),
      daily: Array.from(daily.values()).sort((left, right) => left.date.localeCompare(right.date)),
    },
  };
}

export async function getLearningCost(input: {
  userId: string;
  workspaceId: string;
  startDate: string;
  endDate: string;
}): Promise<LearningCostResponse> {
  try {
    await assertWorkspaceMembership(input.userId, input.workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) {
      throw new ApiRouteError(403, "workspace_forbidden", "User is not authorized for the target workspace");
    }
    throw new ApiRouteError(
      502,
      "workspace_membership_check_failed",
      "Could not verify workspace membership",
      String(error),
    );
  }

  const rows = await listLearningCostRows({
    workspaceId: input.workspaceId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  return rollupLearningCost({
    startDate: input.startDate,
    endDate: input.endDate,
    runs: rows.runs,
    tasks: rows.tasks,
  });
}
