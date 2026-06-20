import type { Json, Tables } from "@kmgrassi/supabase-schema";

import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

export const LEARNING_TASK_TYPES = ["learning_retrieval", "retrieval", "memory_search", "memory.search"] as const;

export type LearningBrokerRunRow = Pick<
  Tables<"broker_run">,
  "run_id" | "workspace_id" | "created_at" | "metadata" | "session_thread_id"
>;

export type LearningBrokerTaskRow = Pick<
  Tables<"broker_task">,
  "task_id" | "run_id" | "type" | "created_at" | "input_tokens" | "output_tokens" | "total_tokens" | "last_event"
>;

export type LearningSessionThreadRow = Pick<Tables<"session_thread">, "id" | "model" | "model_provider">;

export type LearningCostRows = {
  runs: LearningBrokerRunRow[];
  tasks: LearningBrokerTaskRow[];
  sessionThreads: LearningSessionThreadRow[];
};

export async function listLearningCostRows(input: {
  workspaceId: string;
  startDate: string;
  endDate: string;
}): Promise<LearningCostRows> {
  const supabase = getServiceRoleSupabase();
  const start = `${input.startDate}T00:00:00.000Z`;
  const end = `${input.endDate}T23:59:59.999Z`;

  const { data: runsData, error: runsError } = await supabase
    .from("broker_run")
    .select("run_id,workspace_id,created_at,metadata,session_thread_id")
    .eq("workspace_id", input.workspaceId)
    .gte("created_at", start)
    .lte("created_at", end);
  if (runsError) throw normalizeSupabaseError("broker_run learning cost query", runsError);

  const runs = (runsData ?? []) as LearningBrokerRunRow[];
  const runIds = runs.map((run) => run.run_id).filter(Boolean);
  if (runIds.length === 0) {
    return { runs, tasks: [], sessionThreads: [] };
  }

  const { data: tasksData, error: tasksError } = await supabase
    .from("broker_task")
    .select("task_id,run_id,type,created_at,input_tokens,output_tokens,total_tokens,last_event")
    .in("run_id", runIds)
    .gte("created_at", start)
    .lte("created_at", end)
    .in("type", [...LEARNING_TASK_TYPES]);
  if (tasksError) throw normalizeSupabaseError("broker_task learning cost query", tasksError);

  const sessionThreadIds = Array.from(
    new Set(
      runs.map((run) => run.session_thread_id).filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (sessionThreadIds.length === 0) {
    return { runs, tasks: (tasksData ?? []) as LearningBrokerTaskRow[], sessionThreads: [] };
  }

  const { data: sessionThreadsData, error: sessionThreadsError } = await supabase
    .from("session_thread")
    .select("id,model,model_provider")
    .in("id", sessionThreadIds);
  if (sessionThreadsError) throw normalizeSupabaseError("session_thread learning cost query", sessionThreadsError);

  return {
    runs,
    tasks: (tasksData ?? []) as LearningBrokerTaskRow[],
    sessionThreads: (sessionThreadsData ?? []) as LearningSessionThreadRow[],
  };
}

export function jsonRecord(value: Json | null | string | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
