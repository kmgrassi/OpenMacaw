import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

export async function assertWorkspaceAdminAccess(userId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();

  const { data: memberRow, error: memberError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (memberError) {
    throw memberError;
  }

  if (memberRow?.role === "owner" || memberRow?.role === "admin") {
    return;
  }

  const { data: ownedRow, error: ownedError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_user_id", userId)
    .limit(1)
    .maybeSingle();
  if (ownedError) {
    throw ownedError;
  }

  if (ownedRow?.id) {
    return;
  }

  throw new ApiRouteError(
    403,
    "workspace_admin_required",
    "Authenticated user must be a workspace admin to manage local runtimes",
  );
}
