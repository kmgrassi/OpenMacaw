import { getServiceRoleSupabase, getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { computeScheduledTaskNextRunAt } from "../../scheduled-tasks.js";
import { asJson, routerToolPolicyDefaults } from "../builders.js";
import { getSetupDefaults } from "../defaults.js";
import { workspaceRouterAgentId, workspaceRouterOptimizationTaskId } from "../identity.js";
import type { AgentRow } from "../types.js";
import { pickClaimableAgent, requireAgentRow } from "./agent-row-helpers.js";
import { DEFAULT_AGENT_SELECT } from "./selects.js";

const ROUTER_TASK_KIND = "router_optimization";
const ROUTER_TASK_TITLE = "Router optimization";
const ROUTER_TASK_TIMEZONE = "Etc/UTC";
const ROUTER_TASK_SCHEDULE = { kind: "every", interval: 12, unit: "hour" } as const;
const ROUTER_TASK_DELIVERY = {
  kind: "scheduled_agent_message",
  sessionStrategy: "scheduled_task",
  metadata: { kind: ROUTER_TASK_KIND },
} as const;

export const DEFAULT_ROUTER_OPTIMIZATION_INSTRUCTIONS = [
  "Review provider failures, cutover outcomes, and local-model availability since the last run.",
  "Rewrite routing-rule primaries and fallback chains only when the data shows a better route.",
  "Optimize for task success first, then prefer cheaper or local models where the configured model-tier floor allows.",
  "Explain every routing change in the routing_rule.update reason field.",
  "Change nothing when the evidence does not justify a routing update.",
].join("\n");

async function findClaimableWorkspaceRouterAgent(accessToken: string, workspaceId: string) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .select(DEFAULT_AGENT_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("type", "router")
    .order("updated_at", { ascending: true });

  if (error) throw normalizeSupabaseError("agent query", error);
  return pickClaimableAgent(data as AgentRow[]);
}

async function updateWorkspaceRouterAgent(accessToken: string, agent: AgentRow, userId: string) {
  const setupDefaults = getSetupDefaults();
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .update({
      name: agent.name?.trim() ? agent.name : "Router Agent",
      status: setupDefaults.agentStatus,
      tool_policy: asJson(routerToolPolicyDefaults()),
      created_by_user_id: agent.created_by_user_id ?? userId,
    })
    .eq("id", agent.id)
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent update", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "router_agent_update_failed",
    "Router agent update returned no row",
  );
}

async function createWorkspaceRouterAgent(accessToken: string, workspaceId: string, userId: string) {
  const setupDefaults = getSetupDefaults();
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .upsert(
      {
        id: workspaceRouterAgentId(workspaceId),
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name: "Router Agent",
        type: "router",
        status: setupDefaults.agentStatus,
        model_settings: asJson({}),
        tool_policy: asJson(routerToolPolicyDefaults()),
      },
      { onConflict: "id" },
    )
    .select(DEFAULT_AGENT_SELECT);

  if (error) throw normalizeSupabaseError("agent upsert", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "router_agent_create_failed",
    "Router agent creation returned no row",
  );
}

function metadataKind(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function isDuplicateKeyError(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "23505";
}

export async function ensureRouterOptimizationScheduledTask(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  now?: Date;
}) {
  const supabase = getServiceRoleSupabase();
  const { data: existing, error: existingError } = await supabase
    .from("scheduled_task")
    .select("id, metadata")
    .eq("workspace_id", input.workspaceId)
    .eq("agent_id", input.agentId);

  if (existingError) throw normalizeSupabaseError("scheduled_task query", existingError);
  if ((existing ?? []).some((row) => metadataKind((row as { metadata?: unknown }).metadata) === ROUTER_TASK_KIND)) {
    return;
  }

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const { error } = await supabase.from("scheduled_task").insert({
    id: workspaceRouterOptimizationTaskId(input.workspaceId, input.agentId),
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    source_work_item_id: null,
    created_by_user_id: input.userId,
    title: ROUTER_TASK_TITLE,
    instructions: DEFAULT_ROUTER_OPTIMIZATION_INSTRUCTIONS,
    enabled: true,
    schedule: ROUTER_TASK_SCHEDULE,
    timezone: ROUTER_TASK_TIMEZONE,
    next_run_at: computeScheduledTaskNextRunAt(ROUTER_TASK_SCHEDULE, ROUTER_TASK_TIMEZONE, now),
    last_run_at: null,
    last_run_status: null,
    last_error: null,
    delivery: ROUTER_TASK_DELIVERY,
    metadata: { kind: ROUTER_TASK_KIND },
    updated_at: timestamp,
  });

  if (isDuplicateKeyError(error)) return;
  if (error) throw normalizeSupabaseError("scheduled_task insert", error);
}

export async function ensureWorkspaceRouterAgent(accessToken: string, workspaceId: string, userId: string) {
  const claimableAgent = await findClaimableWorkspaceRouterAgent(accessToken, workspaceId);
  const agent = claimableAgent
    ? await updateWorkspaceRouterAgent(accessToken, claimableAgent, userId)
    : await createWorkspaceRouterAgent(accessToken, workspaceId, userId);

  await ensureRouterOptimizationScheduledTask({
    workspaceId,
    userId,
    agentId: agent.id,
  });

  return agent;
}
