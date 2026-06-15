import { ApiRouteError } from "../../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";

export async function assertAgentInWorkspace(agentId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase
    .from("agent")
    .select("id,workspace_id")
    .eq("id", agentId)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("agent query", error);
  if (!data) throw new ApiRouteError(404, "agent_not_found", "Agent was not found in the runtime workspace");
}

export async function workspaceAgentIds(workspaceId: string): Promise<string[]> {
  const supabase = getServiceRoleSupabase();
  const { data, error } = await supabase.from("agent").select("id").eq("workspace_id", workspaceId);
  if (error) throw normalizeSupabaseError("agent query", error);
  return (data ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}
