import { LocalRuntimeListResponseSchema } from "../../../../../contracts/local-runtime.js";
import { parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import {
  buildLocalExecution,
  LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
  normalizeToolCallCapability,
} from "./config-snippet.js";
import { toLocalRuntimeListItem, type RunnerRow } from "./mappers.js";
import {
  LocalRuntimeAgentRowSchema,
  LocalRuntimeMachineRowSchema,
  LocalRuntimeModelRowSchema,
  LocalRuntimeRoutingRuleListRowSchema,
  RoutingRuleMatchRowSchema,
} from "./row-schemas.js";
import {
  LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX,
  matchValue,
  requireMatchValue,
  registrationKindForRule,
  REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS,
} from "./routing-metadata.js";

export async function listRegisteredLocalRuntimesForWorkspace(workspaceId: string) {
  const supabase = getServiceRoleSupabase();

  const { data: rules, error: rulesError } = await supabase
    .from("routing_rule")
    .select("id, model, provider, runner_kind, name, machine_id, last_error, last_error_at")
    .eq("workspace_id", workspaceId)
    .in("runner_kind", [...REGISTERED_LOCAL_RUNTIME_RUNNER_KINDS])
    .like("name", `${LOCAL_RUNTIME_REGISTRATION_RULE_NAME_PREFIX}%`);

  if (rulesError) {
    assertSupabaseSuccess("list local runtime routing rules", rules, rulesError);
  }
  const parsedRules = parseSupabaseRows(
    "list local runtime routing rules",
    LocalRuntimeRoutingRuleListRowSchema,
    rules,
  );

  if (parsedRules.length === 0) {
    return LocalRuntimeListResponseSchema.parse({
      runtimes: [],
      heartbeatIntervalMs: LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
    });
  }

  const ruleIds = parsedRules.map((rule) => rule.id);
  const { data: matches, error: matchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", workspaceId)
    .in("rule_id", ruleIds);

  if (matchesError) {
    assertSupabaseSuccess("list local runtime routing metadata", matches, matchesError);
  }

  const ruleMatches = parseSupabaseRows("list local runtime routing metadata", RoutingRuleMatchRowSchema, matches);
  const matchesByRule = new Map<string, typeof ruleMatches>();
  for (const row of ruleMatches) {
    const current = matchesByRule.get(row.rule_id) ?? [];
    current.push(row);
    matchesByRule.set(row.rule_id, current);
  }

  const machineIdsFromRules = new Map<string, string>();
  for (const rule of parsedRules) {
    const machineId = rule.machine_id ?? matchValue(matchesByRule.get(rule.id) ?? [], "local_machine", "id");
    if (machineId) {
      machineIdsFromRules.set(rule.id, machineId);
    }
  }

  const machineIds = Array.from(new Set(machineIdsFromRules.values()));
  const { data: machines, error: machinesError } =
    machineIds.length > 0
      ? await supabase
          .from("local_runtime_machine")
          .select("id, display_name, last_seen_at, revoked_at, runner_kinds, advertised_runner_kinds, status")
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .in("id", machineIds)
      : { data: [], error: null };

  if (machinesError) {
    assertSupabaseSuccess("list local runtime machines", machines, machinesError);
  }
  const parsedMachines = parseSupabaseRows("list local runtime machines", LocalRuntimeMachineRowSchema, machines);
  const machinesById = new Map(parsedMachines.map((machine) => [machine.id, machine]));
  const activeMachineIds = Array.from(machinesById.keys());

  const { data: liveModels, error: liveModelsError } =
    activeMachineIds.length > 0
      ? await supabase
          .from("local_runtime_model" as never)
          .select("id, machine_id, runner_kind, model, provider, capabilities, last_advertised_at")
          .in("machine_id", activeMachineIds)
      : { data: [], error: null };

  if (liveModelsError) {
    assertSupabaseSuccess("list local runtime live models", liveModels, liveModelsError);
  }
  const parsedLiveModels = parseSupabaseRows("list local runtime live models", LocalRuntimeModelRowSchema, liveModels);

  const agentIds = Array.from(
    new Set(
      ruleMatches
        .filter((match) => match.kind === "agent_id")
        .map((match) => match.value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const { data: agents, error: agentsError } =
    agentIds.length > 0
      ? await supabase.from("agent").select("id, name").eq("workspace_id", workspaceId).in("id", agentIds)
      : { data: [], error: null };

  if (agentsError) {
    assertSupabaseSuccess("list assigned local runtime agents", agents, agentsError);
  }
  const parsedAgents = parseSupabaseRows("list assigned local runtime agents", LocalRuntimeAgentRowSchema, agents);

  const agentsById = new Map(parsedAgents.map((agent) => [agent.id, agent]));
  const liveModelsByMachine = new Map<string, typeof parsedLiveModels>();
  for (const model of parsedLiveModels) {
    const current = liveModelsByMachine.get(model.machine_id) ?? [];
    current.push(model);
    liveModelsByMachine.set(model.machine_id, current);
  }

  const runnersByMachine = new Map<string, RunnerRow[]>();
  const workspaceRootByMachine = new Map<string, string>();
  const lastErrorByMachine = new Map<string, { message: string; at: string | null }>();
  for (const rule of parsedRules) {
    const machineId = rule.machine_id ?? machineIdsFromRules.get(rule.id);
    if (!machineId) continue;
    if (!machinesById.has(machineId)) continue;
    const ruleMatchesForRule = matchesByRule.get(rule.id) ?? [];
    const endpoint = requireMatchValue(
      ruleMatchesForRule,
      "local_endpoint",
      "url",
      "list local runtime routing metadata",
    );
    const registrationKind = registrationKindForRule(rule);
    const assignedAgentIds = ruleMatchesForRule
      .filter((match) => match.kind === "agent_id")
      .map((match) => match.value?.trim())
      .filter((value): value is string => Boolean(value));
    const workspaceRoot = matchValue(ruleMatchesForRule, "local_workspace_root", "path");
    if (workspaceRoot && !workspaceRootByMachine.has(machineId)) {
      workspaceRootByMachine.set(machineId, workspaceRoot);
    }
    if (rule.last_error) {
      const current = lastErrorByMachine.get(machineId);
      if (!current || String(rule.last_error_at ?? "") > String(current.at ?? "")) {
        lastErrorByMachine.set(machineId, { message: rule.last_error, at: rule.last_error_at });
      }
    }
    const liveModelsForRunner = (liveModelsByMachine.get(machineId) ?? [])
      .filter((model) => model.runner_kind === rule.runner_kind || model.runner_kind === registrationKind)
      .map((model) => ({
        id: model.id,
        machineId: model.machine_id,
        runnerKind: model.runner_kind,
        model: model.model,
        provider: model.provider,
        capabilities: model.capabilities,
        lastAdvertisedAt: model.last_advertised_at,
      }));
    const runner: RunnerRow = {
      id: rule.id,
      kind: registrationKind,
      runnerKind: "local_relay",
      endpoint,
      model: rule.model ?? null,
      provider: rule.provider ?? (registrationKind === "openclaw" ? "openclaw" : "openai_compatible"),
      lastError: rule.last_error,
      lastErrorAt: rule.last_error_at,
      models: liveModelsForRunner,
      toolCallCapability:
        registrationKind === "openclaw"
          ? null
          : normalizeToolCallCapability(matchValue(ruleMatchesForRule, "local_model_capability", "tool_call")),
      agents: assignedAgentIds.map((id) => ({
        agentId: id,
        agentName: agentsById.get(id)?.name ?? id,
      })),
    };
    const list = runnersByMachine.get(machineId) ?? [];
    list.push(runner);
    runnersByMachine.set(machineId, list);
  }

  const runtimes = Array.from(runnersByMachine.entries()).map(([machineId, runners]) => {
    const machine = machinesById.get(machineId) ?? null;
    const models = (liveModelsByMachine.get(machineId) ?? []).map((model) => ({
      id: model.id,
      machineId: model.machine_id,
      runnerKind: model.runner_kind,
      model: model.model,
      provider: model.provider,
      capabilities: model.capabilities,
      lastAdvertisedAt: model.last_advertised_at,
    }));
    const lastError = lastErrorByMachine.get(machineId)?.message ?? null;
    const localExecution = buildLocalExecution({
      machine,
      workspaceRoot: workspaceRootByMachine.get(machineId) ?? null,
    });
    return toLocalRuntimeListItem({
      machineId,
      machineDisplayName: machine?.display_name ?? machineId,
      localExecution,
      status: localExecution.status,
      models,
      lastError,
      runners,
    });
  });

  return LocalRuntimeListResponseSchema.parse({
    runtimes,
    heartbeatIntervalMs: LOCAL_RUNTIME_HEARTBEAT_INTERVAL_MS,
  });
}
