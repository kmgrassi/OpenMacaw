import { LocalRuntimeEventsResponseSchema } from "../../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../../http.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { LocalRuntimeEventRowSchema, type LocalRuntimeEventRowRecord } from "./row-schemas.js";

export async function listLocalRuntimeEventsForWorkspace(workspaceId: string, machineId: string, limit: number) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const supabase = getServiceRoleSupabase();
  const narrowedSupabase = narrowSupabase(supabase);

  const { data: machine, error: machineError } = await supabase
    .from("local_runtime_machine")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", machineId)
    .is("revoked_at", null)
    .single();

  if (machineError || !machine) {
    throw new ApiRouteError(404, "local_runtime_machine_not_found", "Local runtime machine was not found");
  }

  const { data: events, error: eventsError } = await narrowedSupabase
    .from<LocalRuntimeEventRowRecord>("local_runtime_event")
    .select("id, machine_id, workspace_id, kind, detail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("machine_id", machineId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (eventsError) {
    assertSupabaseSuccess("list local runtime events", events, eventsError);
  }

  return LocalRuntimeEventsResponseSchema.parse({
    events: parseSupabaseRows(
      "list local runtime events",
      LocalRuntimeEventRowSchema,
      Array.isArray(events) ? events : events ? [events] : null,
    ).map((event) => ({
      id: event.id,
      machineId: event.machine_id,
      workspaceId: event.workspace_id,
      kind: event.kind,
      detail: event.detail,
      createdAt: event.created_at,
    })),
  });
}
