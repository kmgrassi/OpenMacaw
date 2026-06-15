import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import { computeScheduledTaskNextRunAt } from "../scheduled-tasks.js";
import { workspaceLearningDistillationTaskId, workspaceOperabilityRemediationTaskId } from "../setup/identity.js";

type JsonRecord = Record<string, unknown>;

type MemoryRow = {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  content: string;
  tags: unknown;
  event_time: string;
  source_run_id: string | null;
  source_task_id: string | null;
};

type AgentRow = {
  id: string;
  type: string | null;
};

type ToolEventRow = {
  id: string;
  run_id: string | null;
  tool_slug: string | null;
  status: string | null;
  error_code: string | null;
  error_message: string | null;
  approval_state: string | null;
  output_summary: string | null;
  started_at: string | null;
};

export type RecurringOperabilityFinding = {
  signature: string;
  toolSlug: string;
  errorCode: string;
  agentType: string;
  count: number;
  memoryIds: string[];
  sourceRunIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  examples: Array<{
    memoryId: string;
    content: string;
    sourceRunId: string | null;
    sourceTaskId: string | null;
    eventTime: string;
  }>;
  toolEvents: Array<{
    id: string;
    runId: string | null;
    toolSlug: string | null;
    status: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    approvalState: string | null;
    outputSummary: string | null;
    startedAt: string | null;
  }>;
};

export type RecurringOperabilityFindingList = {
  workspaceId: string;
  threshold: number;
  windowDays: number;
  generatedAt: string;
  findings: RecurringOperabilityFinding[];
};

const DISTILLATION_TASK_KIND = "learning_distillation";
const OPERABILITY_TASK_KIND = "learning_operability_remediation";
const DEFAULT_TIMEZONE = "Etc/UTC";
const DISTILLATION_SCHEDULE = { kind: "every", interval: 1, unit: "day", at: "03:30" } as const;
const OPERABILITY_SCHEDULE = { kind: "every", interval: 1, unit: "day", at: "04:00" } as const;

export const DEFAULT_OPERABILITY_REMEDIATION_INSTRUCTIONS = [
  "Review recurring operability findings for this workspace before taking action.",
  "Use the learning operability recurrence query as the source of truth: group by tool slug, error code, and agent type; ignore signatures below the recurrence threshold.",
  "For each recurring signature, decide whether the behavior is an intended policy stop or a real defect.",
  "If it is intended, take no action. If a tool grant fixes an existing catalog tool, route it through the agent_tool_grant workflow. If code, catalog, or template changes are required, create signature-tagged remediation work-items for the coding agent.",
  "Do not create a second work-item or PR when an open remediation item already carries the same signature. Escalate instead when the same signature keeps recurring while remediation is already open.",
].join("\n");

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringField(source: JsonRecord | null, ...keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isOperabilityToolFailure(tags: JsonRecord | null) {
  return stringField(tags, "kind") === "operability" && stringField(tags, "failure") === "tool_call";
}

function normalizeSignaturePart(value: string | null, fallback: string) {
  return (value ?? fallback).trim().toLowerCase().replace(/\s+/g, "_");
}

function findingSignature(input: { toolSlug: string; errorCode: string; agentType: string }) {
  return [
    normalizeSignaturePart(input.toolSlug, "unknown_tool"),
    normalizeSignaturePart(input.errorCode, "unknown_error"),
    normalizeSignaturePart(input.agentType, "unknown_agent"),
  ].join("|");
}

async function learningEnabledForWorkspace(workspaceId: string) {
  const { data, error } = await getServiceRoleSupabase()
    .from("workspace_settings")
    .select("workspace_id, learning_enabled")
    .eq("workspace_id", workspaceId)
    .limit(1);

  if (error) throw normalizeSupabaseError("workspace_settings query", error);
  const row = (data ?? [])[0] as { learning_enabled?: unknown } | undefined;
  return row?.learning_enabled !== false;
}

function metadataKind(metadata: unknown) {
  return stringField(record(metadata), "kind");
}

function isDuplicateKeyError(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "23505";
}

async function scheduledTaskExists(input: {
  workspaceId: string;
  agentId?: string;
  metadataKind?: string;
  deliveryKind?: string;
}) {
  let query = getServiceRoleSupabase()
    .from("scheduled_task")
    .select("id, metadata, delivery")
    .eq("workspace_id", input.workspaceId);
  if (input.agentId) query = query.eq("agent_id", input.agentId);
  const { data, error } = await query;

  if (error) throw normalizeSupabaseError("scheduled_task query", error);
  return (data ?? []).some((row) => {
    const task = row as { metadata?: unknown; delivery?: unknown };
    return (
      (input.metadataKind ? metadataKind(task.metadata) === input.metadataKind : true) &&
      (input.deliveryKind ? stringField(record(task.delivery), "kind") === input.deliveryKind : true)
    );
  });
}

export async function ensureLearningSidecarScheduledTasks(input: {
  workspaceId: string;
  userId: string;
  managerAgentId: string;
  planningAgentId: string;
  now?: Date;
}) {
  if (!(await learningEnabledForWorkspace(input.workspaceId))) return;

  await ensureLearningDistillationScheduledTask(input);
  await ensureOperabilityRemediationScheduledTask(input);
}

export async function ensureLearningDistillationScheduledTask(input: {
  workspaceId: string;
  userId: string;
  managerAgentId: string;
  now?: Date;
}) {
  if (
    await scheduledTaskExists({
      workspaceId: input.workspaceId,
      deliveryKind: DISTILLATION_TASK_KIND,
    })
  ) {
    return;
  }

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const { error } = await getServiceRoleSupabase()
    .from("scheduled_task")
    .insert({
      id: workspaceLearningDistillationTaskId(input.workspaceId, input.managerAgentId),
      workspace_id: input.workspaceId,
      agent_id: input.managerAgentId,
      source_work_item_id: null,
      created_by_user_id: input.userId,
      title: "Nightly learning distillation",
      instructions:
        "Cluster recent important run-summary memories and store reusable skill candidates for human review.",
      enabled: true,
      schedule: DISTILLATION_SCHEDULE,
      timezone: DEFAULT_TIMEZONE,
      next_run_at: computeScheduledTaskNextRunAt(DISTILLATION_SCHEDULE, DEFAULT_TIMEZONE, now),
      last_run_at: null,
      last_run_status: null,
      last_error: null,
      delivery: { kind: DISTILLATION_TASK_KIND, windowDays: 7 },
      metadata: { kind: DISTILLATION_TASK_KIND, source: "workspace_learning_sidecar_seed" },
      updated_at: timestamp,
    });

  if (isDuplicateKeyError(error)) return;
  if (error) throw normalizeSupabaseError("scheduled_task insert", error);
}

export async function ensureOperabilityRemediationScheduledTask(input: {
  workspaceId: string;
  userId: string;
  planningAgentId: string;
  now?: Date;
}) {
  if (
    await scheduledTaskExists({
      workspaceId: input.workspaceId,
      agentId: input.planningAgentId,
      metadataKind: OPERABILITY_TASK_KIND,
    })
  ) {
    return;
  }

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const { error } = await getServiceRoleSupabase()
    .from("scheduled_task")
    .insert({
      id: workspaceOperabilityRemediationTaskId(input.workspaceId, input.planningAgentId),
      workspace_id: input.workspaceId,
      agent_id: input.planningAgentId,
      source_work_item_id: null,
      created_by_user_id: input.userId,
      title: "Learning operability remediation",
      instructions: DEFAULT_OPERABILITY_REMEDIATION_INSTRUCTIONS,
      enabled: true,
      schedule: OPERABILITY_SCHEDULE,
      timezone: DEFAULT_TIMEZONE,
      next_run_at: computeScheduledTaskNextRunAt(OPERABILITY_SCHEDULE, DEFAULT_TIMEZONE, now),
      last_run_at: null,
      last_run_status: null,
      last_error: null,
      delivery: {
        kind: "scheduled_agent_message",
        sessionStrategy: "scheduled_task",
        metadata: { kind: OPERABILITY_TASK_KIND },
      },
      metadata: { kind: OPERABILITY_TASK_KIND, source: "workspace_learning_sidecar_seed" },
      updated_at: timestamp,
    });

  if (isDuplicateKeyError(error)) return;
  if (error) throw normalizeSupabaseError("scheduled_task insert", error);
}

export async function listRecurringOperabilityFindings(input: {
  workspaceId: string;
  threshold?: number;
  windowDays?: number;
  limit?: number;
  now?: Date;
}): Promise<RecurringOperabilityFindingList> {
  const threshold = input.threshold ?? 3;
  const windowDays = input.windowDays ?? 14;
  const limit = input.limit ?? 500;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: memoryData, error: memoryError } = await getServiceRoleSupabase()
    .from("memory_items")
    .select("id, workspace_id, agent_id, content, tags, event_time, source_run_id, source_task_id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_deleted", false)
    .gte("event_time", since)
    .order("event_time", { ascending: false })
    .limit(limit);

  if (memoryError) throw normalizeSupabaseError("memory_items operability query", memoryError);
  const memories = ((memoryData ?? []) as MemoryRow[]).filter((memory) =>
    isOperabilityToolFailure(record(memory.tags)),
  );
  const agentIds = [...new Set(memories.map((memory) => memory.agent_id).filter((id): id is string => Boolean(id)))];
  const agentTypes = await loadAgentTypes(agentIds);
  const grouped = new Map<string, RecurringOperabilityFinding>();

  for (const memory of memories) {
    const tags = record(memory.tags);
    const toolSlug = stringField(tags, "tool_slug", "toolSlug") ?? "unknown_tool";
    const errorCode = stringField(tags, "error_code", "errorCode") ?? "unknown_error";
    const agentType =
      stringField(tags, "agent_type", "agentType") ??
      (memory.agent_id ? agentTypes.get(memory.agent_id) : null) ??
      "unknown_agent";
    const signature = findingSignature({ toolSlug, errorCode, agentType });
    const existing = grouped.get(signature) ?? {
      signature,
      toolSlug,
      errorCode,
      agentType,
      count: 0,
      memoryIds: [],
      sourceRunIds: [],
      firstSeenAt: memory.event_time,
      lastSeenAt: memory.event_time,
      examples: [],
      toolEvents: [],
    };

    existing.count += 1;
    existing.memoryIds.push(memory.id);
    if (memory.source_run_id && !existing.sourceRunIds.includes(memory.source_run_id)) {
      existing.sourceRunIds.push(memory.source_run_id);
    }
    if (memory.event_time < existing.firstSeenAt) existing.firstSeenAt = memory.event_time;
    if (memory.event_time > existing.lastSeenAt) existing.lastSeenAt = memory.event_time;
    if (existing.examples.length < 3) {
      existing.examples.push({
        memoryId: memory.id,
        content: memory.content,
        sourceRunId: memory.source_run_id,
        sourceTaskId: memory.source_task_id,
        eventTime: memory.event_time,
      });
    }
    grouped.set(signature, existing);
  }

  const findings = [...grouped.values()]
    .filter((finding) => finding.count >= threshold)
    .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, 25);

  await attachToolEvents(findings);

  return {
    workspaceId: input.workspaceId,
    threshold,
    windowDays,
    generatedAt: now.toISOString(),
    findings,
  };
}

async function loadAgentTypes(agentIds: string[]) {
  if (agentIds.length === 0) return new Map<string, string>();

  const { data, error } = await getServiceRoleSupabase().from("agent").select("id, type").in("id", agentIds);
  if (error) throw normalizeSupabaseError("agent operability query", error);
  return new Map(((data ?? []) as AgentRow[]).map((agent) => [agent.id, agent.type ?? "unknown_agent"]));
}

async function attachToolEvents(findings: RecurringOperabilityFinding[]) {
  const runIds = [...new Set(findings.flatMap((finding) => finding.sourceRunIds))];
  if (runIds.length === 0) return;

  const { data, error } = await getServiceRoleSupabase()
    .from("agent_tool_call_event" as never)
    .select("id, run_id, tool_slug, status, error_code, error_message, approval_state, output_summary, started_at")
    .in("run_id", runIds)
    .order("started_at", { ascending: false })
    .limit(100);

  if (error) throw normalizeSupabaseError("agent_tool_call_event operability query", error);
  const events = (data ?? []) as ToolEventRow[];
  for (const finding of findings) {
    finding.toolEvents = events
      .filter((event) => finding.sourceRunIds.includes(event.run_id ?? "") && event.tool_slug === finding.toolSlug)
      .slice(0, 5)
      .map((event) => ({
        id: event.id,
        runId: event.run_id,
        toolSlug: event.tool_slug,
        status: event.status,
        errorCode: event.error_code,
        errorMessage: event.error_message,
        approvalState: event.approval_state,
        outputSummary: event.output_summary,
        startedAt: event.started_at,
      }));
  }
}
