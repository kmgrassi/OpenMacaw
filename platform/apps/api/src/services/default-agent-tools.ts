import type { Tables } from "@kmgrassi/supabase-schema";
import type { ToolProfile } from "../../../../contracts/execution-profile.js";
import { narrowSupabase } from "../lib/narrow-supabase.js";
import { logEvent } from "../logger.js";
import { executeSupabaseRows, getServiceRoleSupabase, type ApiSupabaseClient } from "../supabase-client.js";
import { toolProfileForAgentType, toolSlugsForToolProfile } from "./tool-bundles.js";

type ToolPolicyTemplateSlug = "planner" | "manager" | "learning" | "coding" | "local_model_coding" | "router";

type ToolPolicyTemplateRow = {
  id: string;
  workspace_id: string | null;
  slug: string;
  enabled: boolean;
};
type ToolPolicyTemplateToolRow = {
  template_id: string;
  tool_id: string;
};
type AgentToolGrantRow = {
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
type ToolRow = Pick<Tables<"tool">, "id" | "workspace_id" | "slug" | "enabled">;

const TOOL_POLICY_TEMPLATE_SELECT = "id,workspace_id,slug,enabled" as const;
const TOOL_POLICY_TEMPLATE_TOOL_SELECT = "template_id,tool_id" as const;
const AGENT_TOOL_GRANT_SELECT =
  "id,agent_id,tool_id,workspace_id,mode,source,source_tool_template_id,reason,created_by_user_id" as const;
const TOOL_SELECT = "id,workspace_id,slug,enabled" as const;

function defaultTemplateSlugForAgent(input: {
  agentType: string | null | undefined;
  toolProfile?: ToolProfile | null | undefined;
  runnerKind?: string | null | undefined;
  localModelCodingEnabled?: boolean | null | undefined;
}): ToolPolicyTemplateSlug | null {
  const toolProfile = input.toolProfile ?? input.agentType;
  const localModelCodingEnabled = input.runnerKind === "local_model_coding" || Boolean(input.localModelCodingEnabled);
  if (toolProfile === "coding" && localModelCodingEnabled) return "local_model_coding";
  if (toolProfile === "planning") return "planner";
  if (toolProfile === "coding") return "coding";
  if (toolProfile === "manager") return "manager";
  if (toolProfile === "learning") return "learning";
  if (toolProfile === "router") return "router";
  return null;
}

function visibleTool(tool: ToolRow, workspaceId: string): tool is ToolRow & { slug: string } {
  return Boolean(tool.slug) && tool.enabled && (tool.workspace_id === null || tool.workspace_id === workspaceId);
}

function preferredTemplate(
  templates: ToolPolicyTemplateRow[],
  slug: ToolPolicyTemplateSlug,
  workspaceId: string,
): ToolPolicyTemplateRow | null {
  const visibleTemplates = templates.filter(
    (template) =>
      template.slug === slug &&
      template.enabled &&
      (template.workspace_id === null || template.workspace_id === workspaceId),
  );
  return visibleTemplates.find((template) => template.workspace_id === workspaceId) ?? visibleTemplates[0] ?? null;
}

export async function ensureDefaultAgentToolsForAgent(input: {
  agentId: string;
  workspaceId: string | null | undefined;
  agentType: string | null | undefined;
  toolProfile?: ToolProfile | null | undefined;
  runnerKind?: string | null | undefined;
  localModelCodingEnabled?: boolean | null | undefined;
  userId: string;
  supabase?: ApiSupabaseClient;
}): Promise<{ changed: boolean; assignedToolSlugs: string[]; missingToolSlugs: string[] }> {
  const workspaceId = input.workspaceId?.trim();
  const templateSlug = defaultTemplateSlugForAgent(input);
  if (!workspaceId || !templateSlug) {
    return { changed: false, assignedToolSlugs: [], missingToolSlugs: [] };
  }

  const supabase = input.supabase ?? getServiceRoleSupabase();
  const queryClient = narrowSupabase(supabase as ApiSupabaseClient);
  const templates = await executeSupabaseRows<ToolPolicyTemplateRow>(
    "default agent tool template query",
    queryClient.from("tool_policy_template").select(TOOL_POLICY_TEMPLATE_SELECT).eq("slug", templateSlug),
  );
  const template = preferredTemplate(templates, templateSlug, workspaceId);
  const canonicalToolSlugs = toolSlugsForToolProfile({
    toolProfile: input.toolProfile ?? toolProfileForAgentType(input.agentType),
    runnerKind: input.runnerKind,
    localModelCodingEnabled: input.localModelCodingEnabled,
  });

  if (!template) {
    logEvent({
      event: "default_agent_tool_template_missing",
      level: "warn",
      agent_id: input.agentId,
      workspace_id: workspaceId,
      agent_type: input.agentType,
      template_slug: templateSlug,
    });
    if (canonicalToolSlugs.length === 0) {
      return { changed: false, assignedToolSlugs: [], missingToolSlugs: [] };
    }
  }

  const templateTools = template
    ? await executeSupabaseRows<ToolPolicyTemplateToolRow>(
        "default agent tool template membership query",
        queryClient
          .from("tool_policy_template_tool")
          .select(TOOL_POLICY_TEMPLATE_TOOL_SELECT)
          .eq("template_id", template.id),
      )
    : [];

  if (templateTools.length === 0 && canonicalToolSlugs.length === 0) {
    return { changed: false, assignedToolSlugs: [], missingToolSlugs: [] };
  }

  const templateToolIds = templateTools.map((templateTool) => templateTool.tool_id);
  const templateToolsById =
    templateToolIds.length > 0
      ? await executeSupabaseRows<ToolRow>(
          "default agent tool template tools query",
          queryClient.from("tool").select(TOOL_SELECT).in("id", templateToolIds),
        )
      : [];
  const canonicalTools =
    canonicalToolSlugs.length > 0
      ? await executeSupabaseRows<ToolRow>(
          "default agent canonical tools query",
          queryClient.from("tool").select(TOOL_SELECT).in("slug", canonicalToolSlugs),
        )
      : [];

  const tools = uniqueToolsById([...templateToolsById, ...canonicalTools]);
  const visibleTools = tools.filter((tool) => visibleTool(tool, workspaceId));
  const toolsById = new Map(templateToolsById.map((tool) => [tool.id, tool]));
  const visibleToolSlugs = new Set(visibleTools.map((tool) => tool.slug));
  const visibleToolIds = new Set(visibleTools.map((tool) => tool.id));
  const missingToolSlugs = uniqueStrings([
    ...templateToolIds
      .filter((toolId) => !visibleToolIds.has(toolId))
      .map((toolId) => toolsById.get(toolId)?.slug ?? toolId),
    ...canonicalToolSlugs.filter((slug) => !visibleToolSlugs.has(slug)),
  ]);

  const existingGrants = await executeSupabaseRows<AgentToolGrantRow>(
    "default agent tool grants query",
    queryClient
      .from("agent_tool_grant")
      .select(AGENT_TOOL_GRANT_SELECT)
      .eq("agent_id", input.agentId)
      .eq("workspace_id", workspaceId),
  );
  const existingToolIds = new Set(existingGrants.map((grant) => grant.tool_id));
  const missingGrants = visibleTools.filter((tool) => !existingToolIds.has(tool.id));
  if (missingGrants.length === 0) {
    return { changed: false, assignedToolSlugs: [], missingToolSlugs };
  }

  const rowsToInsert = missingGrants.map((tool) => ({
    agent_id: input.agentId,
    tool_id: tool.id,
    workspace_id: workspaceId,
    mode: "include",
    source: "template",
    source_tool_template_id: template?.id ?? null,
    reason: template
      ? `applied default ${templateSlug} tool policy template`
      : `applied canonical default ${templateSlug} tool policy`,
    created_by_user_id: input.userId,
    updated_at: new Date().toISOString(),
  }));

  await executeSupabaseRows<AgentToolGrantRow>(
    "default agent tool grants upsert",
    queryClient
      .from("agent_tool_grant")
      .upsert(rowsToInsert, { onConflict: "agent_id,workspace_id,tool_id" })
      .select(AGENT_TOOL_GRANT_SELECT),
  );

  const assignedToolSlugs = missingGrants.map((tool) => tool.slug).sort();
  logEvent({
    event: "default_agent_tool_template_applied",
    agent_id: input.agentId,
    workspace_id: workspaceId,
    agent_type: input.agentType,
    template_slug: templateSlug,
    assigned_tool_slugs: assignedToolSlugs,
  });

  return { changed: true, assignedToolSlugs, missingToolSlugs };
}

function uniqueToolsById(tools: ToolRow[]): ToolRow[] {
  return Array.from(new Map(tools.map((tool) => [tool.id, tool])).values());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
