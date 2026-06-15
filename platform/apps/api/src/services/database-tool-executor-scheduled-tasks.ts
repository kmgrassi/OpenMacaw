import type { Json, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";

import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

import type { ToolExecutionContext } from "./tool-execution-client.js";
import {
  booleanArg,
  jsonOutput,
  scheduleArg,
  scheduledTaskIdArg,
  stringArg,
  type DatabaseToolResult,
} from "./database-tool-executor-shared.js";

const SCHEDULED_TASK_SELECT =
  "id,agent_id,instructions,cron_schedule,next_interval,start_time,is_active,is_completed,is_follow_up,cancelled_reason,created_at,updated_at" as const;

async function assertAgentInWorkspace(agentId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("agent")
    .select("id,workspace_id")
    .eq("id", agentId)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("agent query", error);
  if (!data) throw new ApiRouteError(404, "agent_not_found", "Agent was not found in the runtime workspace");
}

async function workspaceAgentIds(workspaceId: string): Promise<string[]> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase.from("agent").select("id").eq("workspace_id", workspaceId);
  if (error) throw normalizeSupabaseError("agent query", error);
  return (data ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function getScheduledTaskForWorkspace(scheduledTaskId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("scheduled_task")
    .select(SCHEDULED_TASK_SELECT)
    .eq("id", scheduledTaskId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("scheduled_task query", error);
  if (!data?.agent_id) throw new ApiRouteError(404, "scheduled_task_not_found", "Scheduled task was not found");
  await assertAgentInWorkspace(data.agent_id, workspaceId);
  return data;
}

function schedulePersistenceFields(
  args: Record<string, unknown>,
): Pick<TablesInsert<"scheduled_task">, "cron_schedule" | "next_interval" | "start_time"> {
  const schedule = scheduleArg(args);
  const cronSchedule =
    stringArg(args, "cronSchedule") ||
    stringArg(args, "cron_schedule") ||
    (schedule?.kind === "cron" ? String(schedule.expression ?? "").trim() : "");
  const startTime =
    stringArg(args, "startTime") ||
    stringArg(args, "start_time") ||
    (schedule?.kind === "at" ? String(schedule.runAt ?? "").trim() : "");
  return {
    ...(cronSchedule ? { cron_schedule: cronSchedule } : {}),
    ...(schedule ? { next_interval: schedule as Json } : {}),
    ...(startTime ? { start_time: startTime } : {}),
  };
}

export async function handleScheduledTaskList(
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<DatabaseToolResult> {
  const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id");
  const supabase = getServiceRoleSupabase();
  const agentIds = agentId ? [agentId] : await workspaceAgentIds(workspaceId);
  if (agentId) await assertAgentInWorkspace(agentId, workspaceId);
  if (agentIds.length === 0) return { status: 200, output: jsonOutput({ scheduledTasks: [] }) };
  const { data, error } = await supabase
    .from("scheduled_task")
    .select(SCHEDULED_TASK_SELECT)
    .in("agent_id", agentIds)
    .order("created_at", { ascending: false });
  if (error) throw normalizeSupabaseError("scheduled_task query", error);
  return { status: 200, output: jsonOutput({ scheduledTasks: data ?? [] }) };
}

export async function handleScheduledTaskRead(
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<DatabaseToolResult> {
  const scheduledTaskId = scheduledTaskIdArg(args);
  if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
  const scheduledTask = await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
  return { status: 200, output: jsonOutput({ scheduledTask }) };
}

export async function handleScheduledTaskCreate(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
): Promise<DatabaseToolResult> {
  const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id") || context?.agentId?.trim() || "";
  const instructions = stringArg(args, "instructions");
  if (!agentId) throw new ApiRouteError(400, "invalid_tool_arguments", "agentId is required");
  if (!instructions) throw new ApiRouteError(400, "invalid_tool_arguments", "instructions is required");
  await assertAgentInWorkspace(agentId, workspaceId);
  const supabase = getServiceRoleSupabase();
  const insert: TablesInsert<"scheduled_task"> = {
    agent_id: agentId,
    instructions,
    is_active: booleanArg(args, "enabled") ?? booleanArg(args, "is_active") ?? true,
    is_completed: false,
    is_follow_up: booleanArg(args, "isFollowUp") ?? booleanArg(args, "is_follow_up") ?? false,
    ...schedulePersistenceFields(args),
  };
  const { data, error } = await supabase.from("scheduled_task").insert(insert).select(SCHEDULED_TASK_SELECT).single();
  if (error) throw normalizeSupabaseError("scheduled_task insert", error);
  return { status: 201, output: jsonOutput({ scheduledTask: data }) };
}

export async function handleScheduledTaskUpdate(
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<DatabaseToolResult> {
  const scheduledTaskId = scheduledTaskIdArg(args);
  if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
  await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
  const update: TablesUpdate<"scheduled_task"> = {
    updated_at: new Date().toISOString(),
    ...schedulePersistenceFields(args),
  };
  const instructions = stringArg(args, "instructions");
  const enabled = booleanArg(args, "enabled") ?? booleanArg(args, "is_active");
  if (instructions) update.instructions = instructions;
  if (enabled !== null) update.is_active = enabled;
  const isCompleted = booleanArg(args, "isCompleted") ?? booleanArg(args, "is_completed");
  if (isCompleted !== null) update.is_completed = isCompleted;
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("scheduled_task")
    .update(update)
    .eq("id", scheduledTaskId)
    .select(SCHEDULED_TASK_SELECT)
    .single();
  if (error) throw normalizeSupabaseError("scheduled_task update", error);
  return { status: 200, output: jsonOutput({ scheduledTask: data }) };
}

export async function handleScheduledTaskDelete(
  args: Record<string, unknown>,
  workspaceId: string,
): Promise<DatabaseToolResult> {
  const scheduledTaskId = scheduledTaskIdArg(args);
  if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
  await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("scheduled_task")
    .update({
      is_active: false,
      is_completed: true,
      cancelled_reason: stringArg(args, "reason") || "Canceled by scheduled_task.delete",
      updated_at: new Date().toISOString(),
    })
    .eq("id", scheduledTaskId)
    .select(SCHEDULED_TASK_SELECT)
    .single();
  if (error) throw normalizeSupabaseError("scheduled_task cancel", error);
  return { status: 200, output: jsonOutput({ scheduledTask: data }) };
}
