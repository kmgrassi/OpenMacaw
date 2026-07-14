import type { Express } from "express";

import {
  CredentialRevocationReportRequestSchema,
  CredentialRevocationReportResponseSchema,
} from "../../../../contracts/credentials.js";
import { apiRoute, ApiRouteError } from "../http.js";
import { getCredentialRowByIdForWorkspace } from "../repositories/credentials.js";
import { markCredentialInvalid } from "../services/credential-validation.js";
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

export function registerCredentialValidationRoutes(app: Express) {
  app.post(
    "/api/credentials/:credentialId/revocation",
    apiRoute({
      requireAuth: true,
      bodySchema: CredentialRevocationReportRequestSchema,
      invalidBodyMessage: "workspaceId and credentialId are required",
      handler: async ({ req, res, body, userId }) => {
        if (req.params.credentialId !== body.credentialId) {
          throw new ApiRouteError(400, "invalid_request", "credentialId route param must match request body");
        }

        await requireWorkspaceAccess(userId, body.workspaceId);

        const credential = await getCredentialRowByIdForWorkspace(body.credentialId, body.workspaceId);
        if (!credential) {
          throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
        }

        const updated = await markCredentialInvalid({
          credentialId: body.credentialId,
          workspaceId: body.workspaceId,
        });
        if (!updated) {
          throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
        }

        return res.status(200).json(
          CredentialRevocationReportResponseSchema.parse({
            credentialId: updated.id,
            validationState: "invalid",
            validatedAt: updated.validated_at ?? new Date().toISOString(),
          }),
        );
      },
    }),
  );
}
