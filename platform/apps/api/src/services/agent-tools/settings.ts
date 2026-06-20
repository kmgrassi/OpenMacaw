import type {
  AgentToolBundleName,
  AgentToolSettingsResponse,
  ResolvedAgentTool,
  ToolDefinition,
} from "../../../../../contracts/tool-definition.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { resolveAgentToolGrants } from "../agent-tool-grant-resolver.js";
import {
  listAgentToolGrantRows,
  listVisibleTemplateRows,
  listVisibleToolRows,
} from "../../repositories/agent-tools.js";
import { assertAgentAccess } from "./access.js";
import {
  grantMode,
  resolvedToolFromGrant,
  sortedGrants,
  sortedResolvedTools,
  sortedTemplates,
  sortedTools,
  toolFromRow,
} from "./mappers.js";
import { MEMORY_TOOLS } from "../learning/memory-tool.js";

function grantSourceToResolvedSource(mode: "include" | "exclude") {
  return mode;
}

function runtimeSystemTool(tool: (typeof MEMORY_TOOLS)[number]): ResolvedAgentTool {
  return {
    ...tool,
    name: tool.functionName,
    workspaceId: null,
    source: "system",
    enabledForAgent: true,
  } as ResolvedAgentTool;
}

export async function getResolvedToolsForAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<{ bundles: AgentToolBundleName[]; tools: ResolvedAgentTool[] }> {
  const { workspaceId } = await assertAgentAccess(input);
  const resolution = await resolveAgentToolGrants({
    agentId: input.agentId,
    workspaceId,
    supabase: getServiceRoleSupabase(),
  });
  const systemTools: ResolvedAgentTool[] = MEMORY_TOOLS.map(runtimeSystemTool);

  return {
    bundles: [],
    tools: sortedResolvedTools([
      ...resolution.resolvedTools.map((resolved) => ({
        ...toolFromRow(resolved.tool),
        source: grantSourceToResolvedSource(resolved.grant.mode),
        enabledForAgent: resolved.enabledForAgent,
      })),
      ...systemTools,
    ]),
  };
}

export async function getAgentToolSettings(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<AgentToolSettingsResponse> {
  const { workspaceId } = await assertAgentAccess(input);
  const [templates, availableToolRows, grants] = await Promise.all([
    listVisibleTemplateRows(workspaceId),
    listVisibleToolRows(workspaceId),
    listAgentToolGrantRows({ agentId: input.agentId, workspaceId }),
  ]);
  const toolsById = new Map(availableToolRows.map((tool) => [tool.id, tool]));
  const resolvedTools = grants
    .filter((grant) => grantMode(grant.mode) === "include")
    .map((grant) => {
      const tool = toolsById.get(grant.tool_id);
      return tool ? resolvedToolFromGrant({ row: tool, grant }) : null;
    })
    .filter((tool): tool is ResolvedAgentTool => Boolean(tool));

  return {
    templates: sortedTemplates(templates),
    availableTools: sortedTools(availableToolRows),
    grants: sortedGrants(grants),
    tools: sortedResolvedTools(resolvedTools),
  };
}

export async function getToolsForAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<ToolDefinition[]> {
  const resolved = await getResolvedToolsForAgent(input);
  return resolved.tools
    .filter((tool) => tool.enabledForAgent)
    .map(({ source: _source, enabledForAgent: _enabledForAgent, ...tool }) => tool);
}
