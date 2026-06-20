import {
  type CredentialValidationResult,
  SavedCredentialListResponseSchema,
} from "../../../../../contracts/credentials.js";
import { WorkerBridgeSessionRowResponseSchema } from "../../../../../contracts/worker-bridge.js";
import { ApiRouteError } from "../../http.js";
import { validateOpenAiCredential } from "../../provider-validation.js";
import { markCredentialInvalid, persistCredentialValidation } from "../credential-validation.js";
import type { LauncherClient } from "../launcher.js";
import { isLauncherError } from "../launcher-errors.js";
import { codingHandoffEnv } from "../planning-handoff.js";
import type { ResolvedSavedCredential } from "../saved-credentials.js";
import { resolveStoredCredentialSecret } from "../stored-credentials.js";

type CodingHandoff = Parameters<typeof codingHandoffEnv>[0];

function sanitizedCredential(credential: ResolvedSavedCredential) {
  const sanitized = SavedCredentialListResponseSchema.parse({
    credentials: [credential],
  }).credentials[0];
  if (!sanitized) {
    throw new ApiRouteError(502, "credential_sanitize_failed", "Stored credential sanitizer returned no credential");
  }
  return sanitized;
}

function isLauncherAuthFailure(error: unknown) {
  if (!isLauncherError(error) || !error || typeof error !== "object") {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export async function validateLaunchableStoredCredential(input: {
  credential: ResolvedSavedCredential;
  workspaceId: string;
  model: string | null;
}): Promise<{
  credential: ReturnType<typeof sanitizedCredential>;
  secretValue: string;
  validation: CredentialValidationResult;
}> {
  if (input.credential.launchableKind !== "codex") {
    throw new ApiRouteError(400, "credential_not_launchable", "Stored credential cannot launch a Codex worker");
  }

  const secretValue = await resolveStoredCredentialSecret(input.credential);
  if (!secretValue) {
    throw new ApiRouteError(400, "credential_not_launchable", "Stored credential secret could not be resolved");
  }

  const validation = await validateOpenAiCredential(secretValue, input.model);
  if (input.credential.credentialRowId) {
    await persistCredentialValidation({
      credentialId: input.credential.credentialRowId,
      workspaceId: input.workspaceId,
      result: validation,
    });
  }

  return {
    credential: sanitizedCredential(input.credential),
    secretValue,
    validation,
  };
}

export async function createStoredCredentialLaunch(input: {
  agentId: string;
  credential: ResolvedSavedCredential;
  workspaceId: string;
  secretValue: string;
  handoff: CodingHandoff;
  launcherClient: LauncherClient;
}): Promise<{
  status: number;
  launch: {
    attempted: true;
    sessionId: string | null;
    status: string;
    command: string | null;
    cwd: string | null;
  };
}> {
  const credentialRowId = input.credential.credentialRowId?.trim() ?? "";
  if (!credentialRowId) {
    throw new ApiRouteError(
      409,
      "credential_launch_identity_missing",
      "Stored credential launch requires a persisted credential row id",
    );
  }

  let result;
  try {
    result = await input.launcherClient.createWorkerBridgeSession({
      kind: "codex",
      env: codingHandoffEnv(input.handoff),
      credentials: {
        [input.credential.envVar]: {
          source: "inline",
          value: input.secretValue,
        },
      },
      agent_id: input.agentId,
      workspace_id: input.workspaceId,
      credential_id: credentialRowId,
    });
  } catch (error) {
    if (isLauncherAuthFailure(error) && input.credential.credentialRowId) {
      await markCredentialInvalid({
        credentialId: input.credential.credentialRowId,
        workspaceId: input.workspaceId,
      });
    }
    throw error;
  }

  const launchBody = WorkerBridgeSessionRowResponseSchema.parse(result.data);
  return {
    status: result.status,
    launch: {
      attempted: true,
      sessionId: launchBody.data?.id ?? null,
      status: launchBody.data?.status ?? (result.status >= 200 && result.status < 300 ? "started" : "failed"),
      command: launchBody.data?.command ?? null,
      cwd: launchBody.data?.cwd ?? null,
    },
  };
}
