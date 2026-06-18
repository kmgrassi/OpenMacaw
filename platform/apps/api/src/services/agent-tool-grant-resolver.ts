import type { Database, Json } from "@kmgrassi/supabase-schema";

import { narrowSupabase } from "../lib/narrow-supabase.js";
import { normalizeSupabaseError, type ApiSupabaseClient } from "../supabase-client.js";

export type AgentToolGrantMode = "include" | "exclude";
export type AgentToolGrantSource = "template" | "manual" | "system" | "migration";

type ToolRow = Database["public"]["Tables"]["tool"]["Row"];
type AgentToolGrantTableRow = Database["public"]["Tables"]["agent_tool_grant"]["Row"];

export type GrantResolverToolRow = Pick<
  ToolRow,
  | "id"
  | "workspace_id"
  | "slug"
  | "name"
  | "description"
  | "parameters"
  | "examples"
  | "function_name"
  | "type"
  | "execution_kind"
  | "runner_kind"
  | "enabled"
  | "created_by_user_id"
> & {
  parameters: Json | null;
  examples: Json | null;
};

export type AgentToolGrantRow = Omit<AgentToolGrantTableRow, "mode" | "source"> & {
  mode: AgentToolGrantMode;
  source: AgentToolGrantSource;
};

export type ResolvedAgentToolGrant = {
  tool: GrantResolverToolRow;
  grant: AgentToolGrantRow;
  enabledForAgent: boolean;
};

export type AgentToolGrantResolution = {
  availableTools: GrantResolverToolRow[];
  grants: AgentToolGrantRow[];
  resolvedTools: ResolvedAgentToolGrant[];
};

const TOOL_SELECT =
  "id,workspace_id,slug,name,description,parameters,examples,function_name,type,execution_kind,runner_kind,enabled,created_by_user_id" as const;
const AGENT_TOOL_GRANT_SELECT =
  "id,agent_id,tool_id,workspace_id,mode,source,source_tool_template_id,reason,created_by_user_id,created_at,updated_at" as const;

function sortToolRows<Row extends { slug: string | null; name: string | null }>(rows: Row[]) {
  return [...rows].sort(
    (left, right) =>
      (left.slug ?? "").localeCompare(right.slug ?? "") || (left.name ?? "").localeCompare(right.name ?? ""),
  );
}

function rowsFromResult<Row>(data: Row[] | Row | null): Row[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

async function listVisibleToolRows(input: { workspaceId: string; supabase: ApiSupabaseClient }) {
  const supabase = narrowSupabase(input.supabase);
  const [globalResult, workspaceResult] = await Promise.all([
    supabase.from<GrantResolverToolRow>("tool").select(TOOL_SELECT).is("workspace_id", null),
    supabase.from<GrantResolverToolRow>("tool").select(TOOL_SELECT).eq("workspace_id", input.workspaceId),
  ]);

  if (globalResult.error) throw normalizeSupabaseError("tool query", globalResult.error);
  if (workspaceResult.error) throw normalizeSupabaseError("tool query", workspaceResult.error);

  const globalRows = rowsFromResult(globalResult.data);
  const workspaceRows = rowsFromResult(workspaceResult.data);

  return sortToolRows(
    Array.from(
      new Map([...globalRows, ...workspaceRows].filter((tool) => tool.enabled).map((tool) => [tool.id, tool])).values(),
    ),
  );
}

async function listAgentToolGrants(input: { agentId: string; workspaceId: string; supabase: ApiSupabaseClient }) {
  const result = await narrowSupabase(input.supabase)
    .from<AgentToolGrantRow>("agent_tool_grant")
    .select(AGENT_TOOL_GRANT_SELECT)
    .eq("agent_id", input.agentId)
    .eq("workspace_id", input.workspaceId);
  if (result.error) throw normalizeSupabaseError("agent_tool_grant query", result.error);
  return rowsFromResult(result.data);
}

function isEnabledGrant(grant: AgentToolGrantRow) {
  return grant.mode === "include";
}

export async function resolveAgentToolGrants(input: {
  agentId: string;
  workspaceId: string;
  supabase: ApiSupabaseClient;
}): Promise<AgentToolGrantResolution> {
  const [availableTools, grants] = await Promise.all([
    listVisibleToolRows({ workspaceId: input.workspaceId, supabase: input.supabase }),
    listAgentToolGrants({ agentId: input.agentId, workspaceId: input.workspaceId, supabase: input.supabase }),
  ]);

  const toolsById = new Map(availableTools.map((tool) => [tool.id, tool]));
  const resolvedTools = grants
    .map((grant) => {
      const tool = toolsById.get(grant.tool_id);
      if (!tool) return null;
      return {
        tool,
        grant,
        enabledForAgent: isEnabledGrant(grant),
      };
    })
    .filter((resolution): resolution is ResolvedAgentToolGrant => resolution !== null)
    .sort(
      (left, right) =>
        (left.tool.slug ?? "").localeCompare(right.tool.slug ?? "") ||
        (left.tool.name ?? "").localeCompare(right.tool.name ?? ""),
    );

  return {
    availableTools,
    grants,
    resolvedTools,
  };
}
