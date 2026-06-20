import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { ensureDefaultAgentToolsForAgent } from "../../default-agent-tools.js";
import { asJson, buildModelSettings, learningToolPolicyDefaults } from "../builders.js";
import { getSetupDefaults } from "../defaults.js";
import { workspaceLearningAgentId } from "../identity.js";
import type { AgentRow } from "../types.js";
import { pickClaimableAgent, requireAgentRow } from "./agent-row-helpers.js";
import { DEFAULT_AGENT_SELECT } from "./selects.js";

export const LEARNING_AGENT_NAME = "Learning Agent";

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
