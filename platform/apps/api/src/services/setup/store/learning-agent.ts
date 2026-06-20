import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { ensureDefaultAgentToolsForAgent } from "../../default-agent-tools.js";
import { computeScheduledTaskNextRunAt } from "../../scheduled-tasks.js";
import { asJson, buildModelSettings, learningToolPolicyDefaults } from "../builders.js";
import { getSetupDefaults } from "../defaults.js";
import { workspaceLearningAgentId, workspaceLearningMetaAgentTaskId } from "../identity.js";
import type { AgentRow } from "../types.js";
import { pickClaimableAgent, requireAgentRow } from "./agent-row-helpers.js";
import { DEFAULT_AGENT_SELECT } from "./selects.js";

export const LEARNING_AGENT_NAME = "Learning Agent";

const LEARNING_TASK_KIND = "learning_meta_agent_daily_review";
const LEGACY_LEARNING_TASK_KINDS = new Set(["learning_distillation", "learning_operability_remediation"]);
const LEARNING_TASK_TITLE = "Learning agent transcript review";
const LEARNING_TASK_TIMEZONE = "Etc/UTC";
const LEARNING_TASK_SCHEDULE = { kind: "every", interval: 1, unit: "day", at: "03:30" } as const;
const LEARNING_TASK_DELIVERY = {
  kind: "scheduled_agent_message",
  sessionStrategy: "scheduled_task",
  metadata: {
    kind: LEARNING_TASK_KIND,
    sampling: {
      strategy: "random_recent_run",
      messageWindow: 10,
    },
  },
} as const;

export const DEFAULT_LEARNING_AGENT_INSTRUCTIONS = [
  "Review the transcript sample attached to this scheduled message.",
  "Use agent_run.read when you need more context than the attached transcript sample provides.",
  "Identify durable facts worth remembering, reusable procedures or corrections, and bugs or operability defects.",
  "Report concrete suggested memory, skill, or planning-agent follow-up actions in your response.",
  "Do not claim to have persisted memory, created skills, or handed off work unless a tool call succeeds.",
  "If no transcript sample is attached, say no recent transcript sample was available and take no further action.",
].join("\n");

async function findClaimableWorkspaceLearningAgent(accessToken: string, workspaceId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .select(DEFAULT_AGENT_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("type", "learning")
    .order("updated_at", { ascending: true });

  if (error) throw normalizeSupabaseError("agent query", error);
  return pickClaimableAgent(data as AgentRow[]);
}

function hasPrimaryModelSettings(agent: AgentRow) {
  const settings = agent.model_settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const primary = (settings as Record<string, unknown>).primary;
  return typeof primary === "string" && primary.trim().length > 0;
}

async function updateWorkspaceLearningAgent(accessToken: string, agent: AgentRow, userId: string) {
  const setupDefaults = getSetupDefaults();
  const nextModelSettings = hasPrimaryModelSettings(agent)
    ? agent.model_settings
    : asJson(buildModelSettings(setupDefaults.managerModel));
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .update({
      name: agent.name?.trim() ? agent.name : LEARNING_AGENT_NAME,
      status: setupDefaults.agentStatus,
      model_settings: nextModelSettings,
      tool_policy: asJson(learningToolPolicyDefaults()),
      created_by_user_id: agent.created_by_user_id ?? userId,
    })
    .eq("id", agent.id)
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent update", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "learning_agent_update_failed",
    "Learning agent update returned no row",
  );
}

async function createWorkspaceLearningAgent(accessToken: string, workspaceId: string, userId: string) {
  const setupDefaults = getSetupDefaults();
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .upsert(
      {
        id: workspaceLearningAgentId(workspaceId),
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name: LEARNING_AGENT_NAME,
        type: "learning",
        status: setupDefaults.agentStatus,
        model_settings: asJson(buildModelSettings(setupDefaults.managerModel)),
        tool_policy: asJson(learningToolPolicyDefaults()),
      },
      { onConflict: "id" },
    )
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent upsert", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "learning_agent_create_failed",
    "Learning agent creation returned no row",
  );
}

async function ensureWorkspaceLearningAgentWithServiceRole(input: { workspaceId: string; userId: string | null }) {
  const setupDefaults = getSetupDefaults();
  const supabase = getServiceRoleSupabase();
  const { data: existingRows, error: existingError } = await supabase
    .from("agent")
    .select(DEFAULT_AGENT_SELECT)
    .eq("workspace_id", input.workspaceId)
    .eq("type", "learning")
    .order("updated_at", { ascending: true });

  if (existingError) throw normalizeSupabaseError("agent query", existingError);
  const existingAgent = pickClaimableAgent(existingRows as AgentRow[]);
  if (existingAgent) {
    const nextModelSettings = hasPrimaryModelSettings(existingAgent)
      ? existingAgent.model_settings
      : asJson(buildModelSettings(setupDefaults.managerModel));
    const { data, error } = await supabase
      .from("agent")
      .update({
        name: existingAgent.name?.trim() ? existingAgent.name : LEARNING_AGENT_NAME,
        status: setupDefaults.agentStatus,
        model_settings: nextModelSettings,
        tool_policy: asJson(learningToolPolicyDefaults()),
        created_by_user_id: existingAgent.created_by_user_id ?? input.userId,
      })
      .eq("id", existingAgent.id)
      .select(DEFAULT_AGENT_SELECT);

    if (error) throw normalizeSupabaseError("agent update", error);
    return requireAgentRow(
      data as AgentRow[] | undefined,
      "learning_agent_update_failed",
      "Learning agent update returned no row",
    );
  }

  const { data, error } = await supabase
    .from("agent")
    .upsert(
      {
        id: workspaceLearningAgentId(input.workspaceId),
        workspace_id: input.workspaceId,
        created_by_user_id: input.userId,
        name: LEARNING_AGENT_NAME,
        type: "learning",
        status: setupDefaults.agentStatus,
        model_settings: asJson(buildModelSettings(setupDefaults.managerModel)),
        tool_policy: asJson(learningToolPolicyDefaults()),
      },
      { onConflict: "id" },
    )
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent upsert", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "learning_agent_create_failed",
    "Learning agent creation returned no row",
  );
}

function metadataKind(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function deliveryKind(delivery: unknown) {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const kind = (delivery as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function learningTaskMatches(row: { metadata?: unknown; delivery?: unknown }, enabled: boolean) {
  const kind = metadataKind(row.metadata);
  if (kind === LEARNING_TASK_KIND) return true;
  if (enabled) return false;
  return LEGACY_LEARNING_TASK_KINDS.has(kind ?? "") || LEGACY_LEARNING_TASK_KINDS.has(deliveryKind(row.delivery) ?? "");
}

function isDuplicateKeyError(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "23505";
}

export async function setLearningMetaAgentScheduledTaskEnabled(input: {
  workspaceId: string;
  enabled: boolean;
  now?: Date;
}) {
  const supabase = getServiceRoleSupabase();
  const { data: existing, error: existingError } = await supabase
    .from("scheduled_task")
    .select("id, delivery, metadata")
    .eq("workspace_id", input.workspaceId);

  if (existingError) throw normalizeSupabaseError("learning scheduled_task query", existingError);
  const taskIds = (existing ?? [])
    .filter((row) => learningTaskMatches(row as { metadata?: unknown; delivery?: unknown }, input.enabled))
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (taskIds.length === 0) return;

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const nextRunAt = input.enabled
    ? computeScheduledTaskNextRunAt(LEARNING_TASK_SCHEDULE, LEARNING_TASK_TIMEZONE, now)
    : null;
  const { error } = await supabase
    .from("scheduled_task")
    .update({
      enabled: input.enabled,
      next_run_at: nextRunAt,
      updated_at: timestamp,
    })
    .in("id", taskIds);

  if (error) throw normalizeSupabaseError("learning scheduled_task update", error);
}

export async function ensureLearningMetaAgentScheduledTask(input: {
  workspaceId: string;
  userId: string | null;
  agentId: string;
  enabled?: boolean;
  now?: Date;
}) {
  const supabase = getServiceRoleSupabase();
  const { data: existing, error: existingError } = await supabase
    .from("scheduled_task")
    .select("id, metadata")
    .eq("workspace_id", input.workspaceId)
    .eq("agent_id", input.agentId);

  if (existingError) throw normalizeSupabaseError("scheduled_task query", existingError);
  if ((existing ?? []).some((row) => metadataKind((row as { metadata?: unknown }).metadata) === LEARNING_TASK_KIND)) {
    return;
  }

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const { error } = await supabase.from("scheduled_task").insert({
    id: workspaceLearningMetaAgentTaskId(input.workspaceId, input.agentId),
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    source_work_item_id: null,
    created_by_user_id: input.userId ?? null,
    title: LEARNING_TASK_TITLE,
    instructions: DEFAULT_LEARNING_AGENT_INSTRUCTIONS,
    enabled: input.enabled ?? true,
    schedule: LEARNING_TASK_SCHEDULE,
    timezone: LEARNING_TASK_TIMEZONE,
    next_run_at: computeScheduledTaskNextRunAt(LEARNING_TASK_SCHEDULE, LEARNING_TASK_TIMEZONE, now),
    last_run_at: null,
    last_run_status: null,
    last_error: null,
    delivery: LEARNING_TASK_DELIVERY,
    metadata: { kind: LEARNING_TASK_KIND, source: "workspace_learning_meta_agent_seed" },
    updated_at: timestamp,
  });

  if (isDuplicateKeyError(error)) return;
  if (error) throw normalizeSupabaseError("scheduled_task insert", error);
}

export async function ensureWorkspaceLearningAgent(accessToken: string, workspaceId: string, userId: string) {
  const claimableAgent = await findClaimableWorkspaceLearningAgent(accessToken, workspaceId);
  const learningAgent = claimableAgent
    ? await updateWorkspaceLearningAgent(accessToken, claimableAgent, userId)
    : await createWorkspaceLearningAgent(accessToken, workspaceId, userId);

  await ensureDefaultAgentToolsForAgent({
    agentId: learningAgent.id,
    workspaceId: learningAgent.workspace_id,
    agentType: learningAgent.type,
    userId,
  });

  return learningAgent;
}

export async function ensureLearningMetaAgentScheduleForWorkspace(input: {
  workspaceId: string;
  userId: string | null;
}) {
  const agent = await ensureWorkspaceLearningAgentWithServiceRole(input);
  const actorUserId = input.userId ?? agent.created_by_user_id;
  if (actorUserId) {
    await ensureDefaultAgentToolsForAgent({
      agentId: agent.id,
      workspaceId: agent.workspace_id,
      agentType: agent.type,
      userId: actorUserId,
    });
  }
  await ensureLearningMetaAgentScheduledTask({
    workspaceId: input.workspaceId,
    userId: actorUserId ?? null,
    agentId: agent.id,
  });
  await setLearningMetaAgentScheduledTaskEnabled({
    workspaceId: input.workspaceId,
    enabled: true,
  });
  return agent;
}

export { LEARNING_TASK_KIND };
