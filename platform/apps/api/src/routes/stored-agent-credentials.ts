import type { Express } from "express";

import {
  SaveCredentialRequestSchema,
  StoredAgentActivationRequestSchema,
  StoredCredentialLaunchRequestSchema,
  UpsertAgentCredentialReferenceRequestSchema,
} from "../../../../contracts/credentials.js";
import { StoredAgentRouteTemplates } from "../../../../contracts/routes.js";
import { ApiRouteError, apiRoute, handleApiRouteError, handleLauncherError } from "../http.js";
import { isLauncherError } from "../services/launcher-errors.js";
import type { LauncherClient } from "../services/launcher.js";
import { activateStoredAgent, launchStoredCredential } from "./stored-agent-credentials/activation-route-handlers.js";
import {
  ensureDefaultRoutingHandler,
  getStoredAgentCredentialReference,
  listStoredAgentCredentials,
  saveStoredAgentCredential,
  saveStoredAgentCredentialReference,
} from "./stored-agent-credentials/credential-route-handlers.js";

function handlePlanningHandoffOrRouteError(
  res: Parameters<typeof handleApiRouteError>[0],
  error: unknown,
  fallback: { status: number; code: string; message: string },
) {
  if (error instanceof ApiRouteError) {
    const isPlanningHandoffError =
      error.code === "planning_handoff_required" ||
      error.code === "invalid_planning_handoff" ||
      error.code === "plan_not_found";
    return handleApiRouteError(
      res,
      isPlanningHandoffError
        ? new ApiRouteError(400, "planning_handoff_failed", "Planning handoff validation failed", error.details)
        : error,
      fallback,
    );
  }

  return handleApiRouteError(res, error, fallback);
}

export function registerStoredAgentCredentialRoutes(app: Express, launcherClient: LauncherClient) {
  app.post(
    StoredAgentRouteTemplates.ensureDefaultRouting,
    apiRoute({
      requireAuth: true,
      handler: ({ req, res, accessToken, userId }) => ensureDefaultRoutingHandler({ req, res, accessToken, userId }),
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "stored_agent_default_routing_failed",
          message: "Could not ensure default routing for stored agent",
        }),
    }),
  );

  app.get(
    StoredAgentRouteTemplates.credentials,
    apiRoute({
      requireAuth: true,
      handler: (context) => listStoredAgentCredentials(context),
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "supabase_unreachable",
          message: "Could not read stored credentials from Supabase",
        }),
    }),
  );

  app.get(
    StoredAgentRouteTemplates.credentialReference,
    apiRoute({
      requireAuth: true,
      handler: (context) => getStoredAgentCredentialReference(context),
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "credential_reference_read_failed",
          message: "Could not read credential reference",
        }),
    }),
  );

  app.put(
    StoredAgentRouteTemplates.credentialReference,
    apiRoute({
      requireAuth: true,
      bodySchema: UpsertAgentCredentialReferenceRequestSchema,
      invalidBodyMessage: "Credential reference request is invalid",
      handler: (context) => saveStoredAgentCredentialReference(context),
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: error instanceof ApiRouteError ? error.status : 502,
          code: error instanceof ApiRouteError ? error.code : "credential_reference_save_failed",
          message: error instanceof ApiRouteError ? error.message : "Could not save credential reference",
        }),
    }),
  );

  app.post(
    StoredAgentRouteTemplates.credentials,
    apiRoute({
      requireAuth: true,
      bodySchema: SaveCredentialRequestSchema,
      invalidBodyMessage: "workspaceId, provider, and apiKey are required",
      handler: (context) => saveStoredAgentCredential(context),
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "credential_save_failed",
          message: "Could not persist stored credential",
        }),
    }),
  );

  app.post(
    StoredAgentRouteTemplates.credentialLaunch,
    apiRoute({
      requireAuth: true,
      bodySchema: StoredCredentialLaunchRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      handler: (context) => launchStoredCredential(context, launcherClient),
      onError: (res, error) => {
        if (isLauncherError(error)) {
          return handleLauncherError(res, error);
        }
        return handlePlanningHandoffOrRouteError(res, error, {
          status: 502,
          code: "worker_launch_failed",
          message: "Could not launch worker from stored credential",
        });
      },
    }),
  );

  app.post(
    StoredAgentRouteTemplates.activate,
    apiRoute({
      requireAuth: true,
      bodySchema: StoredAgentActivationRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      handler: (context) => activateStoredAgent(context, launcherClient),
      onError: (res, error) => {
        if (isLauncherError(error)) {
          return handleLauncherError(res, error);
        }
        return handlePlanningHandoffOrRouteError(res, error, {
          status: 502,
          code: "agent_activation_failed",
          message: "Could not validate credentials and launch worker",
        });
      },
    }),
  );
}
