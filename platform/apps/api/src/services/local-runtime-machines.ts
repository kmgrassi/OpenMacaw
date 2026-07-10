import type { LocalRuntimeRegistrationRequest } from "../../../../contracts/local-runtime.js";
import { assertSupabaseSuccess } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { buildLocalExecution } from "./local-runtime/config-snippet.js";
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
} from "./local-runtime/machines.js";
import { getLocalRuntimeMachineDetails } from "./local-runtime/routing-metadata.js";
import {
  defaultMachineDisplayName,
  type InsertedRunner,
  insertedRunnerRows,
  insertRunnerRoutingRules,
} from "./local-runtime/registration.js";
import { createMachineToken, rotateMachineToken } from "./local-runtime/tokens.js";

export { probeLocalModel, probeRegisteredLocalRuntimeForWorkspace } from "./local-runtime/probing.js";
export { deleteLocalRuntimeForWorkspace } from "./local-runtime/deletion.js";
export { listLocalRuntimeEventsForWorkspace } from "./local-runtime/events.js";
export { testLocalRuntimeDispatchForWorkspace } from "./local-runtime/dispatch.js";
export type { LauncherRequest } from "./local-runtime/dispatch.js";

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
