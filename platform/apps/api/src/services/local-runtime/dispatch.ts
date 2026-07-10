import { LocalRuntimeTestDispatchResponseSchema } from "../../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../../http.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { getLocalRuntimeMachineDetails } from "./routing-metadata.js";
import {
  LocalRuntimeMachineRowSchema,
  LocalRuntimeModelRowSchema,
  RoutingRuleMatchRowSchema,
  type LocalRuntimeModelRowRecord,
} from "./row-schemas.js";
import { helperOnline } from "./config-snippet.js";
import {
  localOrchestratorRuntimeTarget,
  resolveRuntimeTargetForAgent,
  RuntimeTargetError,
  type RuntimeTarget,
} from "../runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "../upstream.js";

export type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

const RUNTIME_DIAGNOSTICS_TIMEOUT_MS = 5_000;
const RUNTIME_DIAGNOSTICS_BODY_SNIPPET_LIMIT = 600;

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
    ? `${trimmed.slice(0, RUNTIME_DIAGNOSTICS_BODY_SNIPPET_LIMIT)}...`
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
