import type {
  AgentToolBundleName,
  AgentToolGrantMode,
  AgentToolSettingsResponse,
  ResolvedAgentTool,
  ToolDefinition,
} from "../../../../../contracts/tool-definition.js";
import { ApiRouteError } from "../../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";
import {
  AGENT_TOOL_BUNDLE_SELECT,
  deleteAgentToolGrantRows,
  getVisibleToolRow,
  getVisibleToolRowBySlug,
  listVisibleToolRows,
  loadAgentToolBundleRow,
  listAgentToolGrantRows,
  upsertAgentToolGrantRow,
} from "../../repositories/agent-tools.js";
import type { AgentToolBundleRow } from "../../repositories/agent-tools.js";
import { assertAgentAccess } from "./access.js";
import { logAgentToolOverrideAudit } from "./audit.js";
import { toolFromRow, toolMatchesName, toolName } from "./mappers.js";
import { getAgentToolSettings, getResolvedToolsForAgent } from "./settings.js";
import { assertLocalCodingToolsAllowed } from "./validation.js";

const AGENT_TOOL_BUNDLE_NAMES = new Set<AgentToolBundleName>([
  ":planner",
  ":manager",
  ":coding",
  ":repo_read",
  ":repo_write",
]);

function isAgentToolBundleName(value: string): value is AgentToolBundleName {
  return AGENT_TOOL_BUNDLE_NAMES.has(value as AgentToolBundleName);
}

function defaultBundlesForAgentType(agentType: string | null | undefined): AgentToolBundleName[] {
  if (agentType === "planning") return [":planner"];
  if (agentType === "coding") return [":coding"];
  if (agentType === "manager") return [":manager"];
  return [];
}

function normalizeBundleNames(input: readonly string[], agentType: string | null | undefined): AgentToolBundleName[] {
  const rawBundles = input.length > 0 ? input : defaultBundlesForAgentType(agentType);
  const bundles: AgentToolBundleName[] = [];
  for (const bundle of rawBundles) {
    if (!isAgentToolBundleName(bundle)) {
      throw new ApiRouteError(400, "invalid_tool_bundle", `Unsupported tool bundle: ${bundle}`);
    }
    if (!bundles.includes(bundle)) bundles.push(bundle);
  }
  return bundles;
}

async function findVisibleToolByName(input: { toolName: string; workspaceId: string }) {
  const tools = await listVisibleToolRows(input.workspaceId);
  const tool = tools.find((row) => toolMatchesName(row, input.toolName)) ?? null;
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  if (!tool.enabled) {
    throw new ApiRouteError(409, "tool_disabled", "Tool is disabled for assignment");
  }
  return tool;
}

async function assertAgentInWorkspace(agentId: string, workspaceId: string) {
  const rows = await executeSupabaseRows<{ id: string; workspace_id: string | null }>(
    "agent query",
    getServiceRoleSupabase().from("agent").select("id,workspace_id").eq("id", agentId).limit(1),
  );
  const agent = rows[0] ?? null;
  if (!agent || agent.workspace_id !== workspaceId) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found in this workspace");
  }
}

export async function setSystemAgentToolGrant(input: {
  actorAgentId?: string | null;
  agentId: string;
  workspaceId: string;
  toolId?: string | null;
  toolSlug?: string | null;
  mode: AgentToolGrantMode;
  reason: string;
  operation: "create" | "update";
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ApiRouteError(400, "missing_reason", "reason is required for agent_tool_grant changes");
  }

  await assertAgentInWorkspace(input.agentId, input.workspaceId);
  const toolId = input.toolId?.trim() ?? "";
  const toolSlug = input.toolSlug?.trim() ?? "";
  if (!toolId && !toolSlug) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "toolId or toolSlug is required");
  }

  const tool = toolId
    ? await getVisibleToolRow(toolId, input.workspaceId)
    : await getVisibleToolRowBySlug(toolSlug, input.workspaceId);
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  if (!tool.enabled) {
    throw new ApiRouteError(409, "tool_disabled", "Tool is disabled for assignment");
  }

  const existingGrant =
    (await listAgentToolGrantRows({ agentId: input.agentId, workspaceId: input.workspaceId })).find(
      (grant) => grant.tool_id === tool.id,
    ) ?? null;
  if (input.operation === "create" && existingGrant) {
    throw new ApiRouteError(409, "agent_tool_grant_exists", "A grant row already exists for this agent and tool");
  }
  if (input.operation === "update" && !existingGrant) {
    throw new ApiRouteError(404, "agent_tool_grant_not_found", "No grant row exists for this agent and tool");
  }
  if (existingGrant?.source === "system" && existingGrant.mode === input.mode) {
    throw new ApiRouteError(
      409,
      "system_tool_grant_backoff",
      "This system grant was already applied; escalate instead of repeating the same grant",
      { agentId: input.agentId, toolId: tool.id, mode: input.mode },
    );
  }

  const rows = await upsertAgentToolGrantRow({
    userId: null,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    toolId: tool.id,
    mode: input.mode,
    source: "system",
    reason,
  });
  logAgentToolOverrideAudit({
    action: input.mode,
    userId: input.actorAgentId ?? "system",
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    toolName: toolName(tool),
  });
  return { grant: rows[0] ?? null, tool: toolFromRow(tool) };
}

export async function setAgentToolGrant(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolId: string;
  mode: AgentToolGrantMode;
  reason?: string | null;
  workspaceId?: string | null;
}): Promise<AgentToolSettingsResponse> {
  const { agent, workspaceId } = await assertAgentAccess(input);
  const tool = await getVisibleToolRow(input.toolId, workspaceId);
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  if (!tool.enabled) {
    throw new ApiRouteError(409, "tool_disabled", "Tool is disabled for assignment");
  }
  if (input.mode === "include") {
    await assertLocalCodingToolsAllowed({ workspaceId, tools: [tool], agentToolPolicy: agent.tool_policy });
  }

  await upsertAgentToolGrantRow({
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolId: tool.id,
    mode: input.mode,
    source: "manual",
    reason: input.reason ?? null,
  });
  logAgentToolOverrideAudit({
    action: input.mode,
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolName: toolName(tool),
  });
  return getAgentToolSettings(input);
}

export async function deleteAgentToolGrant(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolId: string;
  workspaceId?: string | null;
}): Promise<AgentToolSettingsResponse> {
  const { workspaceId } = await assertAgentAccess(input);
  await deleteAgentToolGrantRows({ agentId: input.agentId, workspaceId, toolId: input.toolId });
  logAgentToolOverrideAudit({
    action: "exclude",
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolName: input.toolId,
  });
  return getAgentToolSettings(input);
}

export async function addToolOverrideToAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolName: string;
  workspaceId?: string | null;
}): Promise<{ bundles: AgentToolBundleName[]; tools: ResolvedAgentTool[] }> {
  const { agent, workspaceId } = await assertAgentAccess(input);
  const tool = await findVisibleToolByName({ toolName: input.toolName, workspaceId });
  await assertLocalCodingToolsAllowed({ workspaceId, tools: [tool], agentToolPolicy: agent.tool_policy });
  await upsertAgentToolGrantRow({
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolId: tool.id,
    mode: "include",
    source: "manual",
  });
  logAgentToolOverrideAudit({
    action: "include",
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolName: toolName(tool),
  });
  return getResolvedToolsForAgent(input);
}

export async function removeToolOverrideFromAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolName: string;
  workspaceId?: string | null;
}): Promise<{ bundles: AgentToolBundleName[]; tools: ResolvedAgentTool[] }> {
  const { workspaceId } = await assertAgentAccess(input);
  const tool = await findVisibleToolByName({ toolName: input.toolName, workspaceId });
  await upsertAgentToolGrantRow({
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolId: tool.id,
    mode: "exclude",
    source: "manual",
  });
  logAgentToolOverrideAudit({
    action: "exclude",
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolName: toolName(tool),
  });
  return getResolvedToolsForAgent(input);
}

export async function replaceAgentToolBundles(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  bundles: AgentToolBundleName[];
  workspaceId?: string | null;
}): Promise<{ bundles: AgentToolBundleName[]; tools: ResolvedAgentTool[] }> {
  const { workspaceId } = await assertAgentAccess(input);
  const agent = await loadAgentToolBundleRow(input.agentId);
  const bundles = normalizeBundleNames(input.bundles, agent.type);
  await executeSupabaseRows<AgentToolBundleRow>(
    "agent tool_bundles update",
    getServiceRoleSupabase()
      .from("agent")
      .update({ tool_bundles: bundles, updated_at: new Date().toISOString() } as never)
      .eq("id", input.agentId)
      .eq("workspace_id", workspaceId)
      .select(AGENT_TOOL_BUNDLE_SELECT),
  );
  logAgentToolOverrideAudit({
    action: "replace_bundles",
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    bundles,
  });
  return getResolvedToolsForAgent(input);
}

export async function assignToolToAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolId: string;
  workspaceId?: string | null;
}): Promise<ToolDefinition> {
  const { agent, workspaceId } = await assertAgentAccess(input);
  const tool = await getVisibleToolRow(input.toolId, workspaceId);
  if (!tool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found");
  }
  if (!tool.enabled) {
    throw new ApiRouteError(409, "tool_disabled", "Tool is disabled for assignment");
  }
  await assertLocalCodingToolsAllowed({ workspaceId, tools: [tool], agentToolPolicy: agent.tool_policy });

  await upsertAgentToolGrantRow({
    userId: input.userId,
    agentId: input.agentId,
    workspaceId,
    toolId: input.toolId,
    mode: "include",
    source: "manual",
  });

  return toolFromRow(tool);
}

export async function unassignToolFromAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  toolId: string;
  workspaceId?: string | null;
}) {
  const { workspaceId } = await assertAgentAccess(input);
  const deleted = await deleteAgentToolGrantRows({ agentId: input.agentId, workspaceId, toolId: input.toolId });

  if (deleted.length === 0) {
    throw new ApiRouteError(404, "agent_tool_not_found", "Tool assignment was not found");
  }
}
