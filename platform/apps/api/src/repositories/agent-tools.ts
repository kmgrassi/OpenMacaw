import type { Tables } from "@kmgrassi/supabase-schema";

import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";

export type ToolRow = Pick<
  Tables<"tool">,
  | "id"
  | "workspace_id"
  | "slug"
  | "name"
  | "description"
  | "parameters"
  | "examples"
  | "function_name"
  | "execution_kind"
  | "runner_kind"
  | "enabled"
  | "created_by_user_id"
>;
export type AgentToolBundleRow = {
  id: string;
  workspace_id: string;
  type: string | null;
  tool_bundles: string[] | null;
};
export type ToolPolicyTemplateRow = {
  id: string;
  workspace_id: string | null;
  slug: string;
  name: string | null;
  description: string | null;
  system_managed: boolean | null;
  enabled: boolean | null;
};
export type ToolPolicyTemplateToolRow = {
  id: string;
  workspace_id: string | null;
  template_id: string;
  tool_id: string;
};
export type AgentToolGrantRow = {
  id: string;
  agent_id: string;
  tool_id: string;
  workspace_id: string;
  mode: string;
  source: string;
  source_tool_template_id: string | null;
  reason: string | null;
  created_by_user_id: string | null;
};

type UntypedSupabaseQuery = PromiseLike<{
  data: unknown;
  error: null;
}> & {
  select(columns: string): UntypedSupabaseQuery;
  eq(column: string, value: unknown): UntypedSupabaseQuery;
  upsert(body: unknown, options?: { onConflict?: string }): UntypedSupabaseQuery;
  delete(): UntypedSupabaseQuery;
};

export const TOOL_SELECT =
  "id,workspace_id,slug,name,description,parameters,examples,function_name,execution_kind,runner_kind,enabled,created_by_user_id" as const;
export const AGENT_TOOL_BUNDLE_SELECT = "id,workspace_id,type,tool_bundles" as const;
export const TOOL_POLICY_TEMPLATE_SELECT = "id,workspace_id,slug,name,description,system_managed,enabled" as const;
export const TOOL_POLICY_TEMPLATE_TOOL_SELECT = "id,workspace_id,template_id,tool_id" as const;
export const AGENT_TOOL_GRANT_SELECT =
  "id,agent_id,tool_id,workspace_id,mode,source,source_tool_template_id,reason,created_by_user_id" as const;

export function serviceRoleDb() {
  return getServiceRoleSupabase() as never as {
    from(table: string): UntypedSupabaseQuery;
  };
}

export async function getVisibleToolRow(toolId: string, workspaceId: string): Promise<ToolRow | null> {
  const rows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).eq("id", toolId).limit(1),
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  return row.workspace_id === null || row.workspace_id === workspaceId ? row : null;
}

export async function getWorkspaceToolRow(toolId: string, workspaceId: string): Promise<ToolRow | null> {
  const rows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).eq("id", toolId).eq("workspace_id", workspaceId).limit(1),
  );
  return rows[0] ?? null;
}

export async function getVisibleToolRowBySlug(slug: string, workspaceId: string): Promise<ToolRow | null> {
  const workspaceRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).eq("slug", slug).eq("workspace_id", workspaceId).limit(1),
  );
  const workspaceRow = workspaceRows[0] ?? null;
  if (workspaceRow) return workspaceRow;

  const globalRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).eq("slug", slug).is("workspace_id", null).limit(1),
  );
  return globalRows[0] ?? null;
}

export async function loadAgentToolBundleRow(agentId: string): Promise<AgentToolBundleRow> {
  const rows = await executeSupabaseRows<AgentToolBundleRow>(
    "agent tool bundle query",
    getServiceRoleSupabase().from("agent").select(AGENT_TOOL_BUNDLE_SELECT).eq("id", agentId).limit(1),
  );
  const agent = rows[0] ?? null;
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }
  return agent;
}

export async function listVisibleToolRows(workspaceId: string): Promise<ToolRow[]> {
  const globalRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).is("workspace_id", null),
  );
  const workspaceRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase().from("tool").select(TOOL_SELECT).eq("workspace_id", workspaceId),
  );
  return Array.from(new Map([...globalRows, ...workspaceRows].map((tool) => [tool.id, tool])).values()).filter(
    (tool) => tool.enabled,
  );
}

export async function listAllVisibleToolRows(workspaceId: string): Promise<ToolRow[]> {
  const globalRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase()
      .from("tool")
      .select(TOOL_SELECT)
      .is("workspace_id", null)
      .order("slug", { ascending: true }),
  );
  const workspaceRows = await executeSupabaseRows<ToolRow>(
    "tool query",
    getServiceRoleSupabase()
      .from("tool")
      .select(TOOL_SELECT)
      .eq("workspace_id", workspaceId)
      .order("slug", { ascending: true }),
  );
  return Array.from(new Map([...globalRows, ...workspaceRows].map((row) => [row.id, row])).values());
}

export async function listVisibleTemplateRows(workspaceId: string): Promise<ToolPolicyTemplateRow[]> {
  const globalRows = await executeSupabaseRows<ToolPolicyTemplateRow>(
    "tool_policy_template query",
    serviceRoleDb().from("tool_policy_template").select(TOOL_POLICY_TEMPLATE_SELECT),
  );
  return globalRows.filter(
    (template) =>
      (template.workspace_id === null || template.workspace_id === workspaceId) && template.enabled !== false,
  );
}

export async function getVisibleTemplateRow(templateId: string, workspaceId: string): Promise<ToolPolicyTemplateRow> {
  const rows = await executeSupabaseRows<ToolPolicyTemplateRow>(
    "tool_policy_template query",
    serviceRoleDb().from("tool_policy_template").select(TOOL_POLICY_TEMPLATE_SELECT),
  );
  const template =
    rows.find(
      (row) =>
        row.id === templateId &&
        (row.workspace_id === null || row.workspace_id === workspaceId) &&
        row.enabled !== false,
    ) ?? null;
  if (!template) {
    throw new ApiRouteError(404, "tool_policy_template_not_found", "Tool policy template was not found");
  }
  return template;
}

export async function listTemplateToolRows(templateId: string): Promise<ToolPolicyTemplateToolRow[]> {
  return executeSupabaseRows<ToolPolicyTemplateToolRow>(
    "tool_policy_template_tool query",
    serviceRoleDb()
      .from("tool_policy_template_tool")
      .select(TOOL_POLICY_TEMPLATE_TOOL_SELECT)
      .eq("template_id", templateId),
  );
}

export async function listAgentToolGrantRows(input: {
  agentId: string;
  workspaceId: string;
}): Promise<AgentToolGrantRow[]> {
  return executeSupabaseRows<AgentToolGrantRow>(
    "agent_tool_grant query",
    serviceRoleDb()
      .from("agent_tool_grant")
      .select(AGENT_TOOL_GRANT_SELECT)
      .eq("agent_id", input.agentId)
      .eq("workspace_id", input.workspaceId),
  );
}

export async function upsertAgentToolGrantRow(input: {
  userId: string | null;
  agentId: string;
  workspaceId: string;
  toolId: string;
  mode: string;
  source: string;
  sourceToolTemplateId?: string | null;
  reason?: string | null;
}): Promise<AgentToolGrantRow[]> {
  return executeSupabaseRows<AgentToolGrantRow>(
    "agent_tool_grant upsert",
    serviceRoleDb()
      .from("agent_tool_grant")
      .upsert(
        {
          agent_id: input.agentId,
          tool_id: input.toolId,
          workspace_id: input.workspaceId,
          mode: input.mode,
          source: input.source,
          source_tool_template_id: input.sourceToolTemplateId ?? null,
          reason: input.reason ?? null,
          created_by_user_id: input.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "agent_id,workspace_id,tool_id" },
      )
      .select(AGENT_TOOL_GRANT_SELECT),
  );
}

export async function deleteAgentToolGrantRows(input: { agentId: string; workspaceId: string; toolId: string }) {
  return executeSupabaseRows<AgentToolGrantRow>(
    "agent_tool_grant delete",
    serviceRoleDb()
      .from("agent_tool_grant")
      .delete()
      .eq("agent_id", input.agentId)
      .eq("workspace_id", input.workspaceId)
      .eq("tool_id", input.toolId)
      .select(AGENT_TOOL_GRANT_SELECT),
  );
}

export async function hasRegisteredLocalCodingTargetRows(workspaceId: string) {
  const machines = await executeSupabaseRows<Pick<Tables<"local_runtime_machine">, "id">>(
    "local_runtime_machine query",
    getServiceRoleSupabase()
      .from("local_runtime_machine")
      .select("id")
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null),
  );
  if (machines.length === 0) return false;
  const activeMachineIds = new Set(machines.map((machine) => machine.id));

  const rules = await executeSupabaseRows<Pick<Tables<"routing_rule">, "id">>(
    "routing_rule query",
    getServiceRoleSupabase()
      .from("routing_rule")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("runner_kind", "local_relay")
      .like("name", "local:%")
      .eq("enabled", true),
  );
  if (rules.length === 0) return false;

  const ruleIds = rules.map((rule) => rule.id);
  const targetMatches = await executeSupabaseRows<
    Pick<Tables<"routing_rule_match">, "rule_id" | "kind" | "key" | "value">
  >(
    "routing_rule_match query",
    getServiceRoleSupabase()
      .from("routing_rule_match")
      .select("rule_id,kind,key,value")
      .eq("workspace_id", workspaceId)
      .in("rule_id", ruleIds)
      .in("kind", ["local_workspace_root", "local_machine"]),
  );

  const matchesByRule = new Map<string, typeof targetMatches>();
  for (const match of targetMatches) {
    const current = matchesByRule.get(match.rule_id) ?? [];
    current.push(match);
    matchesByRule.set(match.rule_id, current);
  }

  return Array.from(matchesByRule.values()).some((matches) => {
    const hasWorkspaceRoot = matches.some(
      (match) => match.kind === "local_workspace_root" && match.key === "path" && match.value.trim(),
    );
    const hasActiveMachine = matches.some(
      (match) => match.kind === "local_machine" && match.key === "id" && activeMachineIds.has(match.value),
    );
    return hasWorkspaceRoot && hasActiveMachine;
  });
}
