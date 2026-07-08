import {
  StoredCredentialActivationResponseSchema,
  type CodingHandoffRequest,
  type StoredCredentialActivationResponse,
} from "../../../../contracts/credentials.js";
import { requireStoredAgent } from "../routes/stored-agent-credentials/authz.js";
import { ApiRouteError } from "../http.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import type { LauncherClient } from "./launcher.js";
import { assertCodingHandoffReviewable } from "./planning-handoff.js";
import { listSavedCredentialsForAgentFromSupabase, type ResolvedSavedCredential } from "./saved-credentials.js";
import { requireCodexProfile } from "./stored-agent-runtime.js";
import {
  createStoredCredentialLaunch,
  validateLaunchableStoredCredential,
} from "./stored-agent-credentials/activation.js";

type SelectedCredentialInput =
  | {
      kind: "credential_id";
      credentialId: string;
    }
  | {
      kind: "first_codex";
    };

type ValidationFailureMode = "skipped_launch" | "error";

export type StoredAgentActivationOutcome =
  | {
      kind: "validation_failed";
      payload: StoredCredentialActivationResponse;
    }
  | {
      kind: "launched";
      status: number;
      payload: StoredCredentialActivationResponse;
    };

function selectCredential(
  credentials: ResolvedSavedCredential[],
  selection: SelectedCredentialInput,
): ResolvedSavedCredential {
  if (selection.kind === "credential_id") {
    const selected = credentials.find((credential) => credential.id === selection.credentialId);
    if (!selected) {
      throw new ApiRouteError(404, "credential_not_found", "Stored credential was not found");
    }
    return selected;
  }

  const selected = credentials.find((credential) => credential.launchableKind === "codex");
  if (!selected) {
    throw new ApiRouteError(404, "credential_not_found", "No launchable stored credential was found for this agent");
  }
  return selected;
}

function validationFailurePayload(input: {
  credential: StoredCredentialActivationResponse["credential"];
  validation: StoredCredentialActivationResponse["validation"];
  executionProfile: Awaited<ReturnType<typeof resolveExecutionProfile>>;
  mode: ValidationFailureMode;
}): StoredCredentialActivationResponse {
  return StoredCredentialActivationResponseSchema.parse({
    credential: input.credential,
    validation: input.validation,
    launch:
      input.mode === "skipped_launch"
        ? {
            attempted: false,
            sessionId: null,
            status: "skipped_validation_failed",
            command: null,
            cwd: null,
          }
        : null,
    execution_profile: input.executionProfile,
  });
}

export async function runStoredAgentActivation(input: {
  accessToken: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  handoff: CodingHandoffRequest | null;
  selection: SelectedCredentialInput;
  validationFailureMode: ValidationFailureMode;
  launcherClient: LauncherClient;
}): Promise<StoredAgentActivationOutcome> {
  await requireStoredAgent({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });

  if (input.handoff) {
    await assertCodingHandoffReviewable({
      workspaceId: input.workspaceId,
      handoff: input.handoff,
    });
  }

  const executionProfile = await resolveExecutionProfile({ agentId: input.agentId });
  const profile = requireCodexProfile(executionProfile);
  const credentials = await listSavedCredentialsForAgentFromSupabase(input.agentId, input.workspaceId);
  const selected = selectCredential(credentials, input.selection);
  const validatedCredential = await validateLaunchableStoredCredential({
    credential: selected,
    workspaceId: input.workspaceId,
    model: profile.model,
  });

  if (!validatedCredential.validation.ok) {
    return {
      kind: "validation_failed",
      payload: validationFailurePayload({
        credential: validatedCredential.credential,
        validation: validatedCredential.validation,
        executionProfile,
        mode: input.validationFailureMode,
      }),
    };
  }

  const launchResult = await createStoredCredentialLaunch({
    agentId: input.agentId,
    credential: selected,
    workspaceId: input.workspaceId,
    secretValue: validatedCredential.secretValue,
    handoff: input.handoff,
    launcherClient: input.launcherClient,
  });

  return {
    kind: "launched",
    status: launchResult.status,
    payload: StoredCredentialActivationResponseSchema.parse({
      credential: validatedCredential.credential,
      validation: validatedCredential.validation,
      launch: launchResult.launch,
      handoff: input.handoff,
      execution_profile: executionProfile,
    }),
  };
}
