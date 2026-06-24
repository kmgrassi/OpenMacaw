import type {
  LocalRuntimeRegistrationRunnerKind,
  LocalToolCallCapability,
} from "../../../../../contracts/local-runtime.js";
import { z } from "zod";
import { ApiRouteError } from "../../http.js";
import { SupabaseRowParseError, parseSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { normalizeToolCallCapability } from "./config-snippet.js";
import {
  LocalRuntimeMachineRowSchema,
  LocalRuntimeRoutingRuleRowSchema,
  RoutingRuleIdRowSchema,
  RoutingRuleMatchRowSchema,
  type RoutingRuleMatchRowRecord,
} from "./row-schemas.js";

export type RoutingRuleMatchRow = RoutingRuleMatchRowRecord;

/**
 * Runner kinds that the registration flow writes to `routing_rule.runner_kind`.
 * Every registered runner dispatches through the helper-daemon relay, so the
 * flow only writes `local_relay`, with the runtime family stored in
 * `routing_rule.provider` (`openclaw` vs. an openai_compatible provider).
 */
export const REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS = ["local_relay"] as const;

/**
 * Routing-rule name prefix used exclusively by the local-runtime registration
 * flow. Used to distinguish registration-created rules from
 * credential-reference rules (which use the `agent:` prefix), since both can
 * carry `runner_kind = "local_relay"`.
 */
export const LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX = "local:";

export function isLocalRuntimeRegistrationRuleName(name: string | null | undefined): boolean {
  return Boolean(name?.startsWith(LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX));
}

export type LocalRuntimeRunnerDetails = {
  ruleId: string;
  kind: LocalRuntimeRegistrationRunnerKind;
  runnerKind: "local_relay";
  diagnosticRunnerKind: LocalRuntimeRegistrationRunnerKind;
  endpoint: string;
  model: string | null;
  provider: string;
  apiKey: string | null;
  toolCallCapability: LocalToolCallCapability | null;
};

export type LocalRuntimeMachineDetails = {
  machineId: string;
  machineDisplayName: string;
  workspaceRoot: string | null;
  runners: LocalRuntimeRunnerDetails[];
};

export async function getLocalRuntimeMachineDetails(
  workspaceId: string,
  machineId: string,
): Promise<LocalRuntimeMachineDetails> {
  const supabase = getServiceRoleSupabase();

  const { data: machine, error: machineError } = await supabase
    .from("local_runtime_machine")
    .select("id, display_name, last_seen_at, revoked_at, runner_kinds, advertised_runner_kinds, status")
    .eq("workspace_id", workspaceId)
    .eq("id", machineId)
    .is("revoked_at", null)
    .single();

  if (machineError || !machine) {
    throw new ApiRouteError(404, "local_runtime_machine_not_found", "Local runtime machine was not found");
  }
  const parsedMachine = parseSupabaseRow("read local runtime machine details", LocalRuntimeMachineRowSchema, machine);

  const { data: machineMatches, error: machineMatchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id")
    .eq("value", machineId);

  if (machineMatchesError) {
    assertSupabaseSuccess("read routing rules for local runtime machine", machineMatches, machineMatchesError);
  }

  const parsedMachineMatches = parseSupabaseRows(
    "read routing rules for local runtime machine",
    RoutingRuleIdRowSchema,
    machineMatches,
  );
  const ruleIds = Array.from(new Set(parsedMachineMatches.map((row) => row.rule_id)));
  if (ruleIds.length === 0) {
    throw new ApiRouteError(409, "local_runtime_incomplete", "Local runtime machine has no routing rules");
  }

  const { data: rules, error: rulesError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind, machine_id, last_error, last_error_at")
    .eq("workspace_id", workspaceId)
    .in("id", ruleIds)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS]);

  if (rulesError) {
    assertSupabaseSuccess("read routing rules for local runtime machine", rules, rulesError);
  }
  const parsedRules = parseSupabaseRows(
    "read routing rules for local runtime machine",
    LocalRuntimeRoutingRuleRowSchema,
    rules,
  );

  const { data: matches, error: matchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", workspaceId)
    .in("rule_id", ruleIds);

  if (matchesError) {
    assertSupabaseSuccess("read routing rule matches for local runtime machine", matches, matchesError);
  }

  const matchesByRule = new Map<string, RoutingRuleMatchRow[]>();
  for (const row of parseSupabaseRows(
    "read routing rule matches for local runtime machine",
    RoutingRuleMatchRowSchema,
    matches,
  )) {
    const current = matchesByRule.get(row.rule_id) ?? [];
    current.push(row);
    matchesByRule.set(row.rule_id, current);
  }

  // Workspace root is shared across the machine — the first rule that records
  // one wins. The registration flow only ever writes it once.
  let workspaceRoot: string | null = null;
  const runners: LocalRuntimeRunnerDetails[] = [];
  for (const rule of parsedRules) {
    const ruleMatches = matchesByRule.get(rule.id) ?? [];
    const endpoint = requireMatchValue(
      ruleMatches,
      "local_endpoint",
      "url",
      "read routing rule matches for local runtime machine",
    );
    const registrationKind = registrationKindForRule(rule);
    const ruleWorkspaceRoot = matchValue(ruleMatches, "local_workspace_root", "path");
    if (ruleWorkspaceRoot && !workspaceRoot) {
      workspaceRoot = ruleWorkspaceRoot;
    }
    runners.push({
      ruleId: rule.id,
      kind: registrationKind,
      runnerKind: "local_relay",
      diagnosticRunnerKind: registrationKind,
      endpoint,
      model: rule.model ?? null,
      provider: rule.provider ?? (registrationKind === "openclaw" ? "openclaw" : "openai_compatible"),
      apiKey: null,
      toolCallCapability:
        registrationKind === "openclaw"
          ? null
          : normalizeToolCallCapability(matchValue(ruleMatches, "local_model_capability", "tool_call")),
    });
  }

  if (runners.length === 0) {
    throw new ApiRouteError(409, "local_runtime_incomplete", "Local runtime machine has no usable runners");
  }

  return {
    machineId: parsedMachine.id,
    machineDisplayName: parsedMachine.display_name,
    workspaceRoot,
    runners,
  };
}

export type LocalRuntimeRuleDetails = {
  id: string;
  endpoint: string;
  model: string;
  provider: string;
  machineId: string;
  machineDisplayName: string;
  machineLastSeenAt: string | null;
  machineRunnerKinds: string[];
  machineAdvertisedRunnerKinds: string[];
  workspaceRoot: string | null;
  toolCallCapability: LocalToolCallCapability | null;
  registrationRunnerKind: LocalRuntimeRegistrationRunnerKind;
};

export function matchValue(matches: RoutingRuleMatchRow[], kind: string, key?: string) {
  return (
    matches.find((match) => match.kind === kind && (key === undefined || match.key === key))?.value?.trim() || null
  );
}

export function requireMatchValue(matches: RoutingRuleMatchRow[], kind: string, key: string, context: string) {
  const value = matches.find((match) => match.kind === kind && match.key === key)?.value;
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success) {
    throw new SupabaseRowParseError(context, parsed.error);
  }
  return parsed.data;
}

export function registrationKindForRule(rule: {
  runner_kind: string;
  provider: string | null;
}): LocalRuntimeRegistrationRunnerKind {
  return rule.provider === "openclaw" ? "openclaw" : "openai_compatible";
}

export async function getLocalRuntimeRuleDetails(
  workspaceId: string,
  ruleId: string,
): Promise<LocalRuntimeRuleDetails> {
  const supabase = getServiceRoleSupabase();

  const { data: rule, error: ruleError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind, machine_id, last_error, last_error_at")
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`)
    .single();

  if (ruleError || !rule) {
    throw new ApiRouteError(404, "local_runtime_not_found", "Local runtime was not found");
  }
  const parsedRule = parseSupabaseRow("read local runtime rule details", LocalRuntimeRoutingRuleRowSchema, rule);

  const registrationKind = registrationKindForRule(parsedRule);

  const { data: matches, error: matchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", workspaceId)
    .eq("rule_id", ruleId);

  if (matchesError) {
    assertSupabaseSuccess("load local runtime routing metadata", matches, matchesError);
  }

  const ruleMatches = parseSupabaseRows("load local runtime routing metadata", RoutingRuleMatchRowSchema, matches);
  const endpoint = requireMatchValue(ruleMatches, "local_endpoint", "url", "load local runtime routing metadata");
  const machineId = requireMatchValue(ruleMatches, "local_machine", "id", "load local runtime routing metadata");

  const { data: machine, error: machineError } = await supabase
    .from("local_runtime_machine")
    .select("id, display_name, last_seen_at, revoked_at, runner_kinds, advertised_runner_kinds, status")
    .eq("workspace_id", workspaceId)
    .eq("id", machineId)
    .is("revoked_at", null)
    .single();

  if (machineError || !machine) {
    throw new ApiRouteError(404, "local_runtime_machine_not_found", "Local runtime machine was not found");
  }
  const parsedMachine = parseSupabaseRow(
    "read local runtime machine for rule details",
    LocalRuntimeMachineRowSchema,
    machine,
  );

  return {
    id: parsedRule.id,
    endpoint,
    model: parsedRule.model ?? "",
    provider: parsedRule.provider ?? (registrationKind === "openclaw" ? "openclaw" : "openai_compatible"),
    machineId,
    machineDisplayName: parsedMachine.display_name,
    machineLastSeenAt: parsedMachine.last_seen_at,
    machineRunnerKinds: parsedMachine.runner_kinds,
    machineAdvertisedRunnerKinds: parsedMachine.advertised_runner_kinds ?? [],
    workspaceRoot: matchValue(ruleMatches, "local_workspace_root", "path"),
    toolCallCapability:
      registrationKind === "openclaw"
        ? null
        : normalizeToolCallCapability(matchValue(ruleMatches, "local_model_capability", "tool_call")),
    registrationRunnerKind: registrationKind,
  };
}
