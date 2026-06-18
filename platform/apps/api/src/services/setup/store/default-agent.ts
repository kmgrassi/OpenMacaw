import type { DefaultAgentRole } from "../../../../../../contracts/setup.js";
import { findSetupAgentById } from "../../../repositories/agents.js";
import { getUserScopedSupabase, normalizeSupabaseError } from "../../../supabase-client.js";
import { asJson, buildModelSettings, defaultAgentName, plannerToolPolicyDefaults } from "../builders.js";
import { getSetupDefaults } from "../defaults.js";
import { personalDefaultAgentId } from "../identity.js";
import type { AgentRow, DefaultAssignmentRow } from "../types.js";
import { pickClaimableAgent, requireAgentRow } from "./agent-row-helpers.js";
import { writeGatewayConfigForDefaultAgent } from "./gateway-config-writer.js";
import { DEFAULT_AGENT_SELECT, DEFAULT_ASSIGNMENT_SELECT } from "./selects.js";

export async function getDefaultAssignment(
  accessToken: string,
  workspaceId: string,
  userId: string,
  role: DefaultAgentRole,
) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent_default_assignment")
    .select(DEFAULT_ASSIGNMENT_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("role", role)
    .limit(1);

  if (error) throw normalizeSupabaseError("agent_default_assignment query", error);
  return (data[0] as DefaultAssignmentRow | undefined) ?? null;
}

export async function upsertDefaultAssignment(
  accessToken: string,
  workspaceId: string,
  userId: string,
  role: DefaultAgentRole,
  agentId: string,
  provisioningSource: string,
) {
  const { error } = await getUserScopedSupabase(accessToken)
    .from("agent_default_assignment")
    .upsert(
      {
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        role,
        provisioning_source: provisioningSource,
      },
      { onConflict: "workspace_id,user_id,role" },
    )
    .select(DEFAULT_ASSIGNMENT_SELECT);
  if (error) throw normalizeSupabaseError("agent_default_assignment upsert", error);
}

async function findClaimableDefaultAgent(
  accessToken: string,
  workspaceId: string,
  userId: string,
  role: DefaultAgentRole,
) {
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .select(DEFAULT_AGENT_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("created_by_user_id", userId)
    .eq("type", role)
    .order("updated_at", { ascending: true });

  if (error) throw normalizeSupabaseError("agent query", error);
  return pickClaimableAgent(data as AgentRow[]);
}

async function createDefaultAgent(accessToken: string, workspaceId: string, userId: string, role: DefaultAgentRole) {
  const setupDefaults = getSetupDefaults();
  const { data, error } = await getUserScopedSupabase(accessToken)
    .from("agent")
    .upsert(
      {
        id: personalDefaultAgentId(workspaceId, userId, role),
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name: defaultAgentName(role),
        type: role,
        status: setupDefaults.agentStatus,
        model_settings: asJson(
          role === "planning" && setupDefaults.demoPlanningLocalProfile.enabled
            ? buildModelSettings(setupDefaults.demoPlanningLocalProfile.model)
            : {},
        ),
        tool_policy: asJson(role === "planning" ? plannerToolPolicyDefaults() : {}),
      },
      { onConflict: "id" },
    )
    .select(DEFAULT_AGENT_SELECT);
  if (error) throw normalizeSupabaseError("agent upsert", error);
  return requireAgentRow(
    data as AgentRow[] | undefined,
    "default_agent_create_failed",
    "Default agent creation returned no row",
  );
}

export async function ensureDefaultAgent(
  accessToken: string,
  workspaceId: string,
  userId: string,
  role: DefaultAgentRole,
) {
  const setupDefaults = getSetupDefaults();
  const assignment = await getDefaultAssignment(accessToken, workspaceId, userId, role);
  if (assignment) {
    const assignedAgent = await findSetupAgentById(accessToken, assignment.agent_id);
    if (assignedAgent) return assignedAgent;
  }

  const claimableAgent = await findClaimableDefaultAgent(accessToken, workspaceId, userId, role);
  if (claimableAgent) {
    await upsertDefaultAssignment(
      accessToken,
      workspaceId,
      userId,
      role,
      claimableAgent.id,
      setupDefaults.claimedAgentProvisioningSource,
    );
    return claimableAgent;
  }

  const createdAgent = await createDefaultAgent(accessToken, workspaceId, userId, role);
  if (role === "planning" && setupDefaults.demoPlanningLocalProfile.enabled) {
    await writeGatewayConfigForDefaultAgent(
      accessToken,
      userId,
      createdAgent,
      role,
      setupDefaults.demoPlanningLocalProfile.provider,
      setupDefaults.demoPlanningLocalProfile.model,
      setupDefaults.demoPlanningLocalProfile.runnerKind,
    );
  }
  await upsertDefaultAssignment(
    accessToken,
    workspaceId,
    userId,
    role,
    createdAgent.id,
    setupDefaults.defaultAgentProvisioningSource,
  );
  return createdAgent;
}
