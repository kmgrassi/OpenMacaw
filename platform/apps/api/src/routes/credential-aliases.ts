import type { Express } from "express";

import {
  CredentialAliasListResponseSchema,
  UpsertCredentialAliasRequestSchema,
  UpsertCredentialAliasResponseSchema,
} from "../../../../contracts/credentials.js";
import { ApiRouteError, apiRoute, errorPayload, handleApiRouteError, requestWorkspaceId } from "../http.js";
import {
  getCredentialRowByIdForWorkspace,
  isValidCredentialAlias,
  normalizeCredentialAlias,
  upsertCredentialAlias,
} from "../repositories/credentials.js";
import { aliasResponse, listWorkspaceCredentialReferenceState } from "../services/stored-agent-credential-state.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

async function requireWorkspaceAccess(userId: string, workspaceId: string) {
  try {
    await assertWorkspaceMembership(userId, workspaceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) {
      throw new ApiRouteError(
        403,
        "workspace_forbidden",
        "Authenticated user is not authorized for the requested workspace",
      );
    }
    throw error;
  }
}

export function registerCredentialAliasRoutes(app: Express) {
  app.get(
    "/api/credential-aliases",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const workspaceId = requestWorkspaceId(req);
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        await requireWorkspaceAccess(userId, workspaceId);
        const state = await listWorkspaceCredentialReferenceState(workspaceId, userId);
        return res.status(200).json(CredentialAliasListResponseSchema.parse({ aliases: state.aliases }));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "credential_alias_read_failed",
          message: "Could not read credential aliases",
        }),
    }),
  );

  app.put(
    "/api/credential-aliases/:alias",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const parsed = UpsertCredentialAliasRequestSchema.safeParse({
          ...(req.body ?? {}),
          alias: req.params.alias,
        });
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId, alias, and credentialId are required");
        }
        const normalizedAlias = normalizeCredentialAlias(parsed.data.alias);
        if (!isValidCredentialAlias(normalizedAlias)) {
          throw new ApiRouteError(
            400,
            "invalid_request",
            "Credential alias must be 1-64 lowercase letters, numbers, dashes, or underscores",
          );
        }

        await requireWorkspaceAccess(userId, parsed.data.workspaceId);
        const credential = await getCredentialRowByIdForWorkspace(parsed.data.credentialId, parsed.data.workspaceId);
        if (!credential) {
          return res.status(404).json(errorPayload("credential_not_found", "Credential was not found"));
        }

        const alias = await upsertCredentialAlias(parsed.data);
        if (!alias) {
          throw new ApiRouteError(502, "credential_alias_save_failed", "Credential alias was not saved");
        }

        const state = await listWorkspaceCredentialReferenceState(parsed.data.workspaceId, userId);
        return res.status(200).json(
          UpsertCredentialAliasResponseSchema.parse({
            alias: aliasResponse(alias, state.credentialByRowId),
          }),
        );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "credential_alias_save_failed",
          message: "Could not save credential alias",
        }),
    }),
  );
}
