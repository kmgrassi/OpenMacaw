import type { Tables, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import type { getServiceRoleSupabase } from "../../supabase-client.js";
import { revokeActiveMachineTokens } from "./tokens.js";
import {
  LocalRuntimeMachineIdRowSchema,
  LocalRuntimeMachineValueRowSchema,
  RoutingRuleMatchRowSchema,
  type RoutingRuleMatchRowRecord,
} from "./row-schemas.js";

import type { LocalRuntimeRegistrationRunnerKind } from "../../../../../contracts/local-runtime.js";

const OPENAI_COMPATIBLE_MACHINE_RUNNER_KINDS = ["openai_compatible", "local_model_coding", "planner"] as const;
const OPENCLAW_MACHINE_RUNNER_KINDS = ["openclaw"] as const;

/** Resolve the machine.runner_kinds set the helper will advertise for a given runtime-family. */
export function machineRunnerKindsForRegistrationKind(kind: LocalRuntimeRegistrationRunnerKind): readonly string[] {
  return kind === "openclaw" ? OPENCLAW_MACHINE_RUNNER_KINDS : OPENAI_COMPATIBLE_MACHINE_RUNNER_KINDS;
}

/** Union of machine.runner_kinds across all selected runtime families. */
export function machineRunnerKindsForRegistration(kinds: readonly LocalRuntimeRegistrationRunnerKind[]): string[] {
  return Array.from(new Set(kinds.flatMap((kind) => [...machineRunnerKindsForRegistrationKind(kind)])));
}

type SupabaseClient = ReturnType<typeof getServiceRoleSupabase>;
type RoutingRuleMatchRow = RoutingRuleMatchRowRecord;

function mergeRunnerKinds(existing: string[], adding: readonly string[]) {
  return Array.from(new Set([...existing, ...adding]));
}

export async function ensureLocalRuntimeMachineForRegistration(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  displayName: string;
  runnerKinds: readonly string[];
}) {
  const { data: existingMachine, error: existingMachineError } = await input.supabase
    .from("local_runtime_machine")
    .select("id, display_name, runner_kinds")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .eq("display_name", input.displayName)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  if (existingMachineError) {
    assertSupabaseSuccess("find existing local runtime machine", existingMachine, existingMachineError);
  }

  await revokeOtherWorkspaceMachines({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    exceptMachineId: existingMachine?.id ?? null,
  });

  if (existingMachine) {
    const runnerKinds = mergeRunnerKinds(existingMachine.runner_kinds, input.runnerKinds);
    if (runnerKinds.length !== existingMachine.runner_kinds.length) {
      const { error } = await input.supabase
        .from("local_runtime_machine")
        .update({
          runner_kinds: runnerKinds,
        } satisfies TablesUpdate<"local_runtime_machine">)
        .eq("id", existingMachine.id)
        .eq("workspace_id", input.workspaceId);

      if (error) {
        assertSupabaseSuccess("update local runtime machine runner kinds", null, error);
      }
    }

    return {
      machineId: existingMachine.id,
      machineDisplayName: existingMachine.display_name,
      createdMachine: false,
    };
  }

  const { data: machine, error } = await input.supabase
    .from("local_runtime_machine")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      display_name: input.displayName,
      runner_kinds: [...input.runnerKinds],
    } satisfies TablesInsert<"local_runtime_machine">)
    .select("id, display_name")
    .single();

  assertSupabaseSuccess("create machine identity for local runtime", machine, error);

  return {
    machineId: machine.id,
    machineDisplayName: machine.display_name,
    createdMachine: true,
  };
}

export async function ensureLocalMachineMatchesForWorkspace(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineId: string;
}) {
  const supabase = narrowSupabase(input.supabase);

  const { data: rules, error: rulesError } = await supabase
    .from<Tables<"routing_rule">>("routing_rule")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("runner_kind", "local_relay")
    .like("name", "local:%")
    .eq("enabled", true);

  if (rulesError) {
    assertSupabaseSuccess("list local runtime rules for machine metadata repair", rules, rulesError);
  }

  const ruleIds = parseSupabaseRows(
    "list local runtime rules for machine metadata repair",
    LocalRuntimeMachineIdRowSchema,
    Array.isArray(rules) ? rules : rules ? [rules] : null,
  ).map((rule) => rule.id);
  if (ruleIds.length === 0) return;

  const { data: matches, error: matchesError } = await supabase
    .from<RoutingRuleMatchRow>("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", input.workspaceId)
    .in("rule_id", ruleIds)
    .in("kind", ["local_workspace_root", "local_machine"]);

  if (matchesError) {
    assertSupabaseSuccess("list local runtime rule metadata for machine repair", matches, matchesError);
  }

  const matchesByRule = new Map<string, RoutingRuleMatchRow[]>();
  for (const match of parseSupabaseRows(
    "list local runtime rule metadata for machine repair",
    RoutingRuleMatchRowSchema,
    Array.isArray(matches) ? matches : matches ? [matches] : null,
  )) {
    const current = matchesByRule.get(match.rule_id) ?? [];
    current.push(match);
    matchesByRule.set(match.rule_id, current);
  }

  const missingMachineMatches = ruleIds
    .filter((ruleId) => {
      const ruleMatches = matchesByRule.get(ruleId) ?? [];
      const hasWorkspaceRoot = ruleMatches.some(
        (match) => match.kind === "local_workspace_root" && match.key === "path" && match.value?.trim(),
      );
      const hasMachineMatch = ruleMatches.some(
        (match) => match.kind === "local_machine" && match.key === "id" && match.value?.trim(),
      );
      return hasWorkspaceRoot && !hasMachineMatch;
    })
    .map(
      (ruleId) =>
        ({
          workspace_id: input.workspaceId,
          rule_id: ruleId,
          kind: "local_machine",
          key: "id",
          value: input.machineId,
        }) satisfies TablesInsert<"routing_rule_match">,
    );

  if (missingMachineMatches.length === 0) return;

  const { error: insertError } = await input.supabase.from("routing_rule_match").insert(missingMachineMatches);

  if (insertError) {
    assertSupabaseSuccess("repair local runtime machine metadata", null, insertError);
  }
}

export async function deleteLocalRuntimeMachine(input: { supabase: SupabaseClient; machineId: string }) {
  await input.supabase.from("local_runtime_machine").delete().eq("id", input.machineId);
}

export async function revokeLocalRuntimeMachines(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineIds: string[];
}) {
  const machineIds = Array.from(new Set(input.machineIds.filter((id) => id.trim().length > 0)));
  if (machineIds.length === 0) return;

  const revokedAt = new Date().toISOString();

  await revokeActiveMachineTokens({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    machineIds,
    revokedAt,
  });

  const { error } = await input.supabase
    .from("local_runtime_machine")
    .update({ revoked_at: revokedAt } satisfies TablesUpdate<"local_runtime_machine">)
    .eq("workspace_id", input.workspaceId)
    .in("id", machineIds)
    .is("revoked_at", null);

  if (error) {
    assertSupabaseSuccess("revoke local runtime machines", null, error);
  }
}

async function revokeOtherWorkspaceMachines(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  exceptMachineId: string | null;
}) {
  const { data: machines, error } = await narrowSupabase(input.supabase)
    .from<Tables<"local_runtime_machine">>("local_runtime_machine")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .is("revoked_at", null);

  if (error) {
    assertSupabaseSuccess("list active local runtime machines for revocation", machines, error);
  }

  const machineIds = parseSupabaseRows(
    "list active local runtime machines for revocation",
    LocalRuntimeMachineIdRowSchema,
    Array.isArray(machines) ? machines : machines ? [machines] : null,
  )
    .map((machine) => machine.id)
    .filter((id) => id !== input.exceptMachineId);

  await revokeLocalRuntimeMachines({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    machineIds,
  });
}

export async function unreferencedMachineIdsAfterLocalRuntimeDelete(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineIds: string[];
}) {
  const machineIds = Array.from(new Set(input.machineIds.filter((id) => id.trim().length > 0)));
  if (machineIds.length === 0) return [];

  const { data: remainingMatches, error } = await narrowSupabase(input.supabase)
    .from<Tables<"routing_rule_match">>("routing_rule_match")
    .select("value")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id")
    .in("value", machineIds);

  if (error) {
    assertSupabaseSuccess("read remaining local runtime machine references", remainingMatches, error);
  }

  const referencedMachineIds = new Set(
    parseSupabaseRows(
      "read remaining local runtime machine references",
      LocalRuntimeMachineValueRowSchema,
      Array.isArray(remainingMatches) ? remainingMatches : remainingMatches ? [remainingMatches] : null,
    )
      .map((match) => match.value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return machineIds.filter((machineId) => !referencedMachineIds.has(machineId));
}
