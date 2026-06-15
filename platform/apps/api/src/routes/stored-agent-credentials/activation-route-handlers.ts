import { StoredCredentialActivationResponseSchema } from "../../../../../contracts/credentials.js";
import type { AuthenticatedApiRouteContext } from "../../http.js";
import { ApiRouteError, errorPayload, requireRouteParam } from "../../http.js";
import { assertCodingHandoffReviewable, parseCodingHandoff } from "../../services/planning-handoff.js";
import { requireCodexProfile } from "../../services/stored-agent-runtime.js";
import {
  createStoredCredentialLaunch,
  validateLaunchableStoredCredential,
} from "../../services/stored-agent-credentials/activation.js";
import { resolveExecutionProfile } from "../../services/execution-profile-resolver.js";
import type { LauncherClient } from "../../services/launcher.js";
import { listSavedCredentialsForAgentFromSupabase } from "../../services/saved-credentials.js";
import { requireStoredAgent } from "./authz.js";
import { requireWorkspaceIdFromRequest } from "./request-parsers.js";

export async function launchStoredCredential(context: AuthenticatedApiRouteContext, launcherClient: LauncherClient) {
  const { req, res, accessToken, userId } = context;
  const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
  const workspaceId = requireWorkspaceIdFromRequest(req);
  if (!cwd) {
    return res.status(400).json(errorPayload("invalid_request", "A worker cwd is required"));
  }

  const agentId = requireRouteParam(req, "agentId");
  const credentialId = requireRouteParam(req, "credentialId");
  await requireStoredAgent({ accessToken, userId, agentId, workspaceId });
  const handoff = parseCodingHandoff(req.body ?? {}, false);
  if (handoff) {
    await assertCodingHandoffReviewable({ workspaceId, handoff });
  }

  const executionProfile = await resolveExecutionProfile({ agentId });
  const profile = requireCodexProfile(executionProfile);
  const credentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
  const selected = credentials.find((credential) => credential.id === credentialId);

  if (!selected) {
    throw new ApiRouteError(404, "credential_not_found", "Stored credential was not found");
  }

  const validatedCredential = await validateLaunchableStoredCredential({
    credential: selected,
    workspaceId,
    model: profile.model,
  });
  if (!validatedCredential.validation.ok) {
    return res.status(200).json(
      StoredCredentialActivationResponseSchema.parse({
        credential: validatedCredential.credential,
        validation: validatedCredential.validation,
        launch: {
          attempted: false,
          sessionId: null,
          status: "skipped_validation_failed",
          command: null,
          cwd,
        },
        execution_profile: executionProfile,
      }),
    );
  }

  const launchResult = await createStoredCredentialLaunch({
    agentId,
    credential: selected,
    workspaceId,
    secretValue: validatedCredential.secretValue,
    cwd,
    handoff,
    launcherClient,
  });

  return res.status(200).json(
    StoredCredentialActivationResponseSchema.parse({
      credential: validatedCredential.credential,
      validation: validatedCredential.validation,
      launch: launchResult.launch,
      handoff,
      execution_profile: executionProfile,
    }),
  );
}

export async function activateStoredAgent(context: AuthenticatedApiRouteContext, launcherClient: LauncherClient) {
  const { req, res, accessToken, userId } = context;
  const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
  const workspaceId = requireWorkspaceIdFromRequest(req);
  const agentId = requireRouteParam(req, "agentId");
  await requireStoredAgent({ accessToken, userId, agentId, workspaceId });
  const handoff = parseCodingHandoff(req.body ?? {}, false);
  if (handoff) {
    await assertCodingHandoffReviewable({ workspaceId, handoff });
  }

  const executionProfile = await resolveExecutionProfile({ agentId });
  const profile = requireCodexProfile(executionProfile);
  const credentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
  const selected = credentials.find((credential) => credential.launchableKind === "codex");

  if (!selected) {
    throw new ApiRouteError(404, "credential_not_found", "No launchable stored credential was found for this agent");
  }

  const validatedCredential = await validateLaunchableStoredCredential({
    credential: selected,
    workspaceId,
    model: profile.model,
  });
  if (!validatedCredential.validation.ok) {
    return res.status(400).json(
      errorPayload(
        "credential_validation_failed",
        validatedCredential.validation.message,
        StoredCredentialActivationResponseSchema.parse({
          credential: validatedCredential.credential,
          validation: validatedCredential.validation,
          launch: null,
          execution_profile: executionProfile,
        }),
      ),
    );
  }

  if (!cwd) {
    return res.status(400).json(
      errorPayload(
        "worker_cwd_required",
        "A worker cwd is required to launch after credential validation",
        StoredCredentialActivationResponseSchema.parse({
          credential: validatedCredential.credential,
          validation: validatedCredential.validation,
          launch: null,
          execution_profile: executionProfile,
        }),
      ),
    );
  }

  const launchResult = await createStoredCredentialLaunch({
    agentId,
    credential: selected,
    workspaceId,
    secretValue: validatedCredential.secretValue,
    cwd,
    handoff,
    launcherClient,
  });
  const payload = StoredCredentialActivationResponseSchema.parse({
    credential: validatedCredential.credential,
    validation: validatedCredential.validation,
    launch: launchResult.launch,
    handoff,
    execution_profile: executionProfile,
  });

  return res.status(launchResult.status).json(payload);
}
