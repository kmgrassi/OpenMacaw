import type { LocalRuntimeRegistrationRequest } from "../../../../contracts/local-runtime.js";
import {
  LocalRuntimeEventsResponseSchema,
  LocalRuntimeTestDispatchResponseSchema,
} from "../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../http.js";
import { narrowSupabase } from "../lib/narrow-supabase.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { buildLocalExecution, helperOnline } from "./local-runtime/config-snippet.js";
import {
  buildLocalRuntimeConfigResponse,
  buildRegistrationConfig,
  sharedWorkspaceRootFromRegistration,
} from "./local-runtime/config-response.js";
import { toLocalRuntimeRegistrationResponse, type RunnerRow } from "./local-runtime/mappers.js";
import { listRegisteredLocalRuntimesForWorkspace } from "./local-runtime/listing.js";
import {
  deleteLocalRuntimeMachine,
  ensureLocalMachineMatchesForWorkspace,
  ensureLocalRuntimeMachineForRegistration,
  machineRunnerKindsForRegistration,
  revokeLocalRuntimeMachines,
  unreferencedMachineIdsAfterLocalRuntimeDelete,
} from "./local-runtime/machines.js";
import { getLocalRuntimeMachineDetails } from "./local-runtime/routing-metadata.js";
import {
  LocalRuntimeEventRowSchema,
  LocalRuntimeMachineIdRowSchema,
  LocalRuntimeMachineRowSchema,
  LocalRuntimeModelRowSchema,
  RoutingRuleIdRowSchema,
  RoutingRuleMatchRowSchema,
  type LocalRuntimeEventRowRecord,
  type LocalRuntimeModelRowRecord,
} from "./local-runtime/row-schemas.js";
import {
  localOrchestratorRuntimeTarget,
  resolveRuntimeTargetForAgent,
  RuntimeTargetError,
  type RuntimeTarget,
} from "./runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "./upstream.js";
import {
  defaultMachineDisplayName,
  type InsertedRunner,
  insertedRunnerRows,
  insertRunnerRoutingRules,
} from "./local-runtime/registration.js";
import { createMachineToken, rotateMachineToken } from "./local-runtime/tokens.js";

export { probeLocalModel, probeRegisteredLocalRuntimeForWorkspace } from "./local-runtime/probing.js";

export type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

type RegisterLocalRuntimeInput = {
  workspaceId: string;
  userId: string;
  request: LocalRuntimeRegistrationRequest;
};

export async function registerLocalRuntimeForWorkspace({ workspaceId, userId, request }: RegisterLocalRuntimeInput) {
  const supabase = getServiceRoleSupabase();
  const displayName = request.machineDisplayName?.trim() || defaultMachineDisplayName(request.runners);
  const registrationKinds = request.runners.map((runner) => runner.kind);
  const machineRunnerKinds = machineRunnerKindsForRegistration(registrationKinds);

  const { machineId, machineDisplayName, createdMachine } = await ensureLocalRuntimeMachineForRegistration({
    supabase,
    workspaceId,
    userId,
    displayName,
    runnerKinds: machineRunnerKinds,
  });

  const { plaintextToken, error: tokenError } = await createMachineToken({ supabase, machineId, workspaceId });

  if (tokenError) {
    if (createdMachine) {
      await deleteLocalRuntimeMachine({ supabase, machineId });
    }
    assertSupabaseSuccess("create machine token for local runtime", null, tokenError);
  }

  let inserted: InsertedRunner[];
  try {
    inserted = await insertRunnerRoutingRules({
      supabase,
      workspaceId,
      machineId,
      runners: request.runners,
    });
  } catch (error) {
    await supabase.from("local_runtime_token").delete().eq("machine_id", machineId);
    if (createdMachine) {
      await supabase.from("local_runtime_machine").delete().eq("id", machineId);
    }
    throw error;
  }

  await ensureLocalMachineMatchesForWorkspace({ supabase, workspaceId, machineId });

  const sharedWorkspaceRoot = sharedWorkspaceRootFromRegistration(request.runners);

  const runners: RunnerRow[] = insertedRunnerRows(inserted);

  return toLocalRuntimeRegistrationResponse({
    machine: { id: machineId, displayName: machineDisplayName },
    token: plaintextToken,
    config: buildRegistrationConfig({
      machineId,
      displayName,
      workspaceRoot: sharedWorkspaceRoot,
      workspaceId,
      token: plaintextToken,
      runners: request.runners,
    }),
    localExecution: buildLocalExecution({
      machine: {
        id: machineId,
        display_name: machineDisplayName,
        last_seen_at: null,
        revoked_at: null,
        runner_kinds: machineRunnerKinds,
        advertised_runner_kinds: [],
        status: "offline",
      },
      workspaceRoot: sharedWorkspaceRoot,
    }),
    runners,
  });
}

export async function getLocalRuntimeConfigForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  return buildLocalRuntimeConfigResponse({
    workspaceId,
    machineId: details.machineId,
    machineDisplayName: details.machineDisplayName,
    workspaceRoot: details.workspaceRoot,
    token: null,
    tokenAvailable: false,
    runners: details.runners,
  });
}

export async function rotateLocalRuntimeTokenForWorkspace(workspaceId: string, machineId: string) {
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  const supabase = getServiceRoleSupabase();
  const plaintextToken = await rotateMachineToken({ supabase, workspaceId, machineId: details.machineId });

  return buildLocalRuntimeConfigResponse({
    workspaceId,
    machineId: details.machineId,
    machineDisplayName: details.machineDisplayName,
    workspaceRoot: details.workspaceRoot,
    token: plaintextToken,
    tokenAvailable: true,
    runners: details.runners,
  });
}

export async function listLocalRuntimesForWorkspace(workspaceId: string) {
  return listRegisteredLocalRuntimesForWorkspace(workspaceId);
}

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

export async function testLocalRuntimeDispatchForWorkspace(
  workspaceId: string,
  machineId: string,
  launcherRequest: LauncherRequest,
) {
  const supabase = getServiceRoleSupabase();
  const narrowedSupabase = narrowSupabase(supabase);
  const details = await getLocalRuntimeMachineDetails(workspaceId, machineId);
  const runner = details.runners.find((candidate) => candidate.kind === "openai_compatible") ?? details.runners[0];
  if (!runner) {
    throw new ApiRouteError(409, "local_runtime_incomplete", "Local runtime machine has no usable runners");
  }

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
  const parsedMachine = parseNullableSupabaseRow(
    "read local runtime machine for test dispatch",
    LocalRuntimeMachineRowSchema,
    machine,
  );
  const helperConnected = helperOnline(parsedMachine?.last_seen_at);

  const { data: models, error: modelsError } = await narrowedSupabase
    .from<LocalRuntimeModelRowRecord>("local_runtime_model")
    .select("id, machine_id, runner_kind, model, provider, capabilities, last_advertised_at")
    .eq("machine_id", machineId);

  if (modelsError) {
    assertSupabaseSuccess("list local runtime models for test dispatch", models, modelsError);
  }

  const advertisedModels = parseSupabaseRows(
    "list local runtime models for test dispatch",
    LocalRuntimeModelRowSchema,
    Array.isArray(models) ? models : models ? [models] : null,
  );
  const modelAdvertised = advertisedModels.some(
    (model) =>
      model.model === runner.model && (model.runner_kind === runner.runnerKind || model.runner_kind === runner.kind),
  );

  if (!helperConnected || !modelAdvertised) {
    return LocalRuntimeTestDispatchResponseSchema.parse({
      machineId,
      helperConnected,
      modelAdvertised,
      dispatchSucceeded: false,
      error: {
        code: !helperConnected ? "helper_disconnected" : "model_unavailable",
        message: !helperConnected ? "Helper is not connected." : "Model is not advertised by this helper.",
        detail: {
          rawMessage: `${runner.diagnosticRunnerKind}:${runner.model ?? ""}`,
        },
      },
    });
  }

  return LocalRuntimeTestDispatchResponseSchema.parse(
    await runRuntimeDiagnostics({
      workspaceId,
      machineId,
      runner,
      machineRuleIds: details.runners.map((candidate) => candidate.ruleId),
      launcherRequest,
    }),
  );
}

const RUNTIME_DIAGNOSTICS_TIMEOUT_MS = 5_000;
const RUNTIME_DIAGNOSTICS_BODY_SNIPPET_LIMIT = 600;

async function agentIdAssignedToMachineRules(workspaceId: string, ruleIds: string[]): Promise<string | null> {
  if (ruleIds.length === 0) return null;
  const supabase = getServiceRoleSupabase();

  const { data: matches, error: matchesError } = await supabase
    .from("routing_rule_match")
    .select("rule_id, kind, key, value")
    .eq("workspace_id", workspaceId)
    .eq("kind", "agent_id")
    .in("rule_id", ruleIds);

  if (matchesError) {
    assertSupabaseSuccess("read agent assignments for local runtime machine", matches, matchesError);
  }

  const parsed = parseSupabaseRows(
    "read agent assignments for local runtime machine",
    RoutingRuleMatchRowSchema,
    matches,
  );
  return (
    parsed.map((match) => match.value?.trim()).find((value): value is string => Boolean(value && value.length > 0)) ??
    null
  );
}

function diagnosticsFailure(machineId: string, code: string, message: string, detail: Record<string, unknown> | null) {
  return {
    machineId,
    helperConnected: true,
    modelAdvertised: true,
    dispatchSucceeded: false,
    error: { code, message, detail },
  };
}

function upstreamBodySnippet(body: unknown): string | null {
  const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > RUNTIME_DIAGNOSTICS_BODY_SNIPPET_LIMIT
    ? `${trimmed.slice(0, RUNTIME_DIAGNOSTICS_BODY_SNIPPET_LIMIT)}…`
    : trimmed;
}

async function runRuntimeDiagnostics(input: {
  workspaceId: string;
  machineId: string;
  runner: {
    runnerKind: string;
    diagnosticRunnerKind: string;
    model: string | null;
  };
  machineRuleIds: string[];
  launcherRequest: LauncherRequest;
}) {
  // The probe must hit the orchestrator that terminates this workspace's
  // helper relay socket. Resolve it through the same runtime target
  // resolution chat dispatch uses — agent-scoped when the machine is already
  // assigned to an agent — so the doctor panel tests the path messages will
  // actually take.
  let target: RuntimeTarget;
  try {
    const agentId = await agentIdAssignedToMachineRules(input.workspaceId, input.machineRuleIds);
    target = agentId
      ? await resolveRuntimeTargetForAgent(agentId, input.launcherRequest)
      : localOrchestratorRuntimeTarget({ workspaceId: input.workspaceId });
  } catch (error) {
    if (error instanceof RuntimeTargetError) {
      return diagnosticsFailure(input.machineId, error.code, error.message, null);
    }
    throw error;
  }

  const diagnosticsPath = "/api/v1/local-runtime/health";
  const params = new URLSearchParams({
    workspace_id: input.workspaceId,
    machine_id: input.machineId,
    target_runner_kind: input.runner.diagnosticRunnerKind,
  });
  if (input.runner.model) {
    params.set("model", input.runner.model);
  }

  // The orchestrator's /api/v1/local-runtime/* endpoints sit behind
  // RequireServiceRoleBearer; without the bearer they return 401. (The
  // launcher serves the same path unauthenticated and ignores the header.)
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (serviceRoleKey) {
    headers.authorization = `Bearer ${serviceRoleKey}`;
  }

  const runtimeRequest = createUpstreamRequester(target.baseUrl, RUNTIME_DIAGNOSTICS_TIMEOUT_MS);
  let response: UpstreamResponse;
  try {
    response = await runtimeRequest(`${diagnosticsPath}?${params.toString()}`, { method: "GET", headers });
  } catch (error) {
    return diagnosticsFailure(
      input.machineId,
      "runtime_unreachable",
      "Could not reach the runtime diagnostics endpoint.",
      {
        endpoint: `${target.baseUrl}${diagnosticsPath}`,
        dialError: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const body =
    typeof response.body === "object" && response.body !== null ? (response.body as Record<string, unknown>) : null;
  const ok = response.status >= 200 && response.status < 300 && body?.ok === true;
  if (ok) {
    return {
      machineId: input.machineId,
      helperConnected: true,
      modelAdvertised: true,
      dispatchSucceeded: true,
      error: null,
    };
  }

  const reason = [body?.reason, body?.status].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const rawMessage = upstreamBodySnippet(response.body);
  return diagnosticsFailure(
    input.machineId,
    reason ?? "runtime_diagnostic_failed",
    "Runtime diagnostics did not report the local runtime path as ready.",
    {
      httpStatus: response.status,
      endpoint: `${target.baseUrl}${diagnosticsPath}`,
      ...(rawMessage ? { rawMessage } : {}),
    },
  );
}

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
