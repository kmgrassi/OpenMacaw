import { ApiRouteError } from "../../http.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { revokeLocalRuntimeMachines, unreferencedMachineIdsAfterLocalRuntimeDelete } from "./machines.js";
import { LocalRuntimeMachineIdRowSchema, RoutingRuleIdRowSchema } from "./row-schemas.js";

export async function deleteLocalRuntimeForWorkspace(workspaceId: string, machineId: string) {
  const supabase = getServiceRoleSupabase();

  const { data: machineRow, error: machineError } = await supabase
    .from("local_runtime_machine")
    .select("id")
    .eq("id", machineId)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .single();

  if (machineError || !machineRow) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }
  parseNullableSupabaseRow("read local runtime machine for deletion", LocalRuntimeMachineIdRowSchema, machineRow);

  const { data: machineMatches, error: machineMatchError } = await supabase
    .from("routing_rule_match")
    .select("rule_id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id")
    .eq("value", machineId);

  if (machineMatchError) {
    assertSupabaseSuccess("read routing rules for local runtime machine deletion", machineMatches, machineMatchError);
  }

  const parsedMachineMatches = parseSupabaseRows(
    "read routing rules for local runtime machine deletion",
    RoutingRuleIdRowSchema,
    machineMatches,
  );
  const ruleIds = Array.from(new Set(parsedMachineMatches.map((row) => row.rule_id)));

  if (ruleIds.length > 0) {
    const { error: deleteMatchError } = await supabase.from("routing_rule_match").delete().in("rule_id", ruleIds);
    if (deleteMatchError) {
      assertSupabaseSuccess("delete local runtime routing matches", null, deleteMatchError);
    }
    const { error: deleteRuleError } = await supabase.from("routing_rule").delete().in("id", ruleIds);
    if (deleteRuleError) {
      assertSupabaseSuccess("delete local runtime routing rules", null, deleteRuleError);
    }
  }

  const unreferencedMachineIds = await unreferencedMachineIdsAfterLocalRuntimeDelete({
    supabase,
    workspaceId,
    machineIds: [machineId],
  });

  await revokeLocalRuntimeMachines({
    supabase,
    workspaceId,
    machineIds: unreferencedMachineIds,
  });
}
