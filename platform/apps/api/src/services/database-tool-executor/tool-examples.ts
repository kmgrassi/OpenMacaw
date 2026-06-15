import type { Json, TablesUpdate } from "@kmgrassi/supabase-schema";

import { ApiRouteError } from "../../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import type { ToolExecutionContext } from "../tool-execution-client.js";

import { toolIdArg, toolSlugArg, jsonOutput } from "./shared.js";

type ToolExamplesRow = {
  id: string;
  workspace_id: string | null;
  slug: string | null;
  name: string | null;
  examples: Json | null;
};

function exampleArgs(args: Record<string, unknown>): unknown[] {
  if (Array.isArray(args.examples) && args.examples.length > 0) return args.examples;
  if (args.example !== undefined) return [args.example];
  return [];
}

async function visibleToolById(toolId: string, workspaceId: string): Promise<ToolExamplesRow | null> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("id", toolId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("tool query", error);
  if (!data || (data.workspace_id !== null && data.workspace_id !== workspaceId)) return null;
  return data;
}

async function visibleToolBySlug(slug: string, workspaceId: string): Promise<ToolExamplesRow | null> {
  const supabase = getServiceRoleSupabase();
  const { data: workspaceTool, error: workspaceError } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("slug", slug)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (workspaceError) throw normalizeSupabaseError("tool query", workspaceError);
  if (workspaceTool) return workspaceTool;

  const { data: globalTool, error: globalError } = await supabase
    .from("tool")
    .select("id,workspace_id,slug,name,examples")
    .eq("slug", slug)
    .is("workspace_id", null)
    .limit(1)
    .maybeSingle();
  if (globalError) throw normalizeSupabaseError("tool query", globalError);
  return globalTool;
}

async function assertToolAssignedToAgent(agentId: string, workspaceId: string, toolId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("agent_tool_grant")
    .select("id")
    .eq("agent_id", agentId)
    .eq("workspace_id", workspaceId)
    .eq("tool_id", toolId)
    .eq("mode", "include")
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("agent tool grant query", error);
  if (!data) {
    throw new ApiRouteError(403, "tool_not_assigned", "Agents can only update examples for tools assigned to them");
  }
}

export async function appendToolExamples(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
) {
  const agentId = context?.agentId?.trim() || "";
  if (!agentId) throw new ApiRouteError(400, "runtime_context_required", "agent_id is required in runtime context");

  const examples = exampleArgs(args);
  if (examples.length === 0) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "example or examples is required");
  }

  const targetToolId = toolIdArg(args);
  const targetToolSlug = toolSlugArg(args);
  if (!targetToolId && !targetToolSlug) {
    throw new ApiRouteError(400, "invalid_tool_arguments", "tool_id or tool_slug is required");
  }

  const targetTool = targetToolId
    ? await visibleToolById(targetToolId, workspaceId)
    : await visibleToolBySlug(targetToolSlug, workspaceId);
  if (!targetTool) throw new ApiRouteError(404, "tool_not_found", "Tool was not found");

  await assertToolAssignedToAgent(agentId, workspaceId, targetTool.id);

  const existingExamples = Array.isArray(targetTool.examples) ? targetTool.examples : [];
  const updatedExamples = [...existingExamples, ...examples];
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("tool")
    .update({
      examples: updatedExamples as Json,
      updated_at: new Date().toISOString(),
    } satisfies TablesUpdate<"tool">)
    .eq("id", targetTool.id)
    .select("id,workspace_id,slug,name,examples")
    .single();
  if (error) throw normalizeSupabaseError("tool examples update", error);

  return {
    status: 200,
    output: jsonOutput({
      tool: data,
      appendedCount: examples.length,
      exampleCount: updatedExamples.length,
    }),
  };
}
