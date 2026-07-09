import { StoredCredentialActivationResponseSchema } from "../../../../../contracts/credentials.js";
import type { AuthenticatedApiRouteContext } from "../../http.js";
import { errorPayload, requireRouteParam } from "../../http.js";
import type { LauncherClient } from "../../services/launcher.js";
import { parseCodingHandoff } from "../../services/planning-handoff.js";
import { runStoredAgentActivation } from "../../services/stored-agent-activation.js";
import { requireWorkspaceIdFromRequest } from "./request-parsers.js";

export async function launchStoredCredential(context: AuthenticatedApiRouteContext, launcherClient: LauncherClient) {
  const { req, res, accessToken, userId } = context;
  const workspaceId = requireWorkspaceIdFromRequest(req);
  const agentId = requireRouteParam(req, "agentId");
  const credentialId = requireRouteParam(req, "credentialId");
  const handoff = parseCodingHandoff(req.body ?? {}, false);
  const result = await runStoredAgentActivation({
    accessToken,
    userId,
    workspaceId,
    agentId,
    handoff,
    selection: { kind: "credential_id", credentialId },
    validationFailureMode: "skipped_launch",
    launcherClient,
  });

  if (result.kind === "validation_failed") {
    return res.status(200).json(result.payload);
  }

  return res.status(200).json(StoredCredentialActivationResponseSchema.parse(result.payload));
}

export async function activateStoredAgent(context: AuthenticatedApiRouteContext, launcherClient: LauncherClient) {
  const { req, res, accessToken, userId } = context;
  const workspaceId = requireWorkspaceIdFromRequest(req);
  const agentId = requireRouteParam(req, "agentId");
  const handoff = parseCodingHandoff(req.body ?? {}, false);
  const result = await runStoredAgentActivation({
    accessToken,
    userId,
    workspaceId,
    agentId,
    handoff,
    selection: { kind: "first_codex" },
    validationFailureMode: "error",
    launcherClient,
  });

  if (result.kind === "validation_failed") {
    return res
      .status(400)
      .json(errorPayload("credential_validation_failed", result.payload.validation.message, result.payload));
  }

  return res.status(result.status).json(StoredCredentialActivationResponseSchema.parse(result.payload));
}
