import type express from "express";

import {
  ModelCatalogResponseSchema,
  ModelProviderListResponseSchema,
  SaveModelProviderCredentialRequestSchema,
  SaveModelProviderCredentialResponseSchema,
} from "../../../../contracts/model-catalog.js";
import { CredentialProviderSchema } from "../../../../contracts/credentials.js";
import { MODEL_PROVIDER_IDS, type ModelProvider } from "../../../../contracts/provider-registry.js";
import { apiRoute, ApiRouteError, requestWorkspaceId } from "../http.js";
import { saveModelProviderCredentialForWorkspaceInSupabase } from "../services/saved-credentials.js";
import {
  listModelCatalog,
  listModelProviderConnections,
  validateModelProviderCredential,
} from "../services/model-catalog.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { assertWorkspaceAdminAccess } from "../services/workspace-access.js";

function requestAgentId(req: express.Request): string | null {
  const value = req.query.agentId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requestRefresh(req: express.Request): boolean {
  const value = req.query.refresh;
  return value === "1" || value === "true";
}

const MODEL_CREDENTIAL_PROVIDERS = new Set<string>(MODEL_PROVIDER_IDS);

function asModelProvider(provider: string): ModelProvider | null {
  return MODEL_CREDENTIAL_PROVIDERS.has(provider) ? (provider as ModelProvider) : null;
}

async function requireWorkspaceAdmin(userId: string, workspaceId: string) {
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

  await assertWorkspaceAdminAccess(userId, workspaceId, "workspace credentials");
}

export function registerModelCatalogRoutes(app: express.Express) {
  app.get(
    "/api/model-providers",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const workspaceId = requestWorkspaceId(req);
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        const connections = await listModelProviderConnections({
          workspaceId,
          userId,
          refresh: requestRefresh(req),
        });
        return res.json(ModelProviderListResponseSchema.parse(connections));
      },
    }),
  );

  app.post(
    "/api/model-providers/:provider/credentials",
    apiRoute({
      requireAuth: true,
      bodySchema: SaveModelProviderCredentialRequestSchema,
      invalidBodyMessage: "workspaceId and apiKey are required",
      handler: async ({ req, res, body, userId }) => {
        await requireWorkspaceAdmin(userId, body.workspaceId);
        const parsedProvider = CredentialProviderSchema.safeParse(req.params.provider);
        const modelProvider = parsedProvider.success ? asModelProvider(parsedProvider.data) : null;
        if (!parsedProvider.success || !modelProvider) {
          throw new ApiRouteError(400, "invalid_request", "Unsupported model provider");
        }
        const provider = parsedProvider.data;

        const validation = await validateModelProviderCredential({
          provider: modelProvider,
          apiKey: body.apiKey,
          endpoint: body.endpoint,
          apiVersion: body.apiVersion,
        });
        if (!validation.ok) {
          throw new ApiRouteError(
            400,
            "credential_validation_failed",
            validation.error ?? "Provider rejected the API key",
            {
              checkedAt: validation.checkedAt,
            },
          );
        }

        await saveModelProviderCredentialForWorkspaceInSupabase({
          workspaceId: body.workspaceId,
          userId: userId ?? null,
          provider,
          apiKey: body.apiKey,
          endpoint: body.endpoint,
          apiVersion: body.apiVersion,
          validationState: "ok",
          validatedAt: validation.checkedAt,
        });

        const providers = await listModelProviderConnections({
          workspaceId: body.workspaceId,
          userId,
        });
        const providerState = providers.providers.find((candidate) => candidate.id === provider);
        if (!providerState) {
          throw new ApiRouteError(
            500,
            "provider_state_unavailable",
            "Provider credential was saved but state could not be read",
          );
        }

        return res.json(SaveModelProviderCredentialResponseSchema.parse({ provider: providerState }));
      },
    }),
  );

  app.get(
    "/api/models",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const catalog = await listModelCatalog({
          agentId: requestAgentId(req),
          workspaceId: requestWorkspaceId(req),
          userId,
          refresh: requestRefresh(req),
        });
        return res.json(ModelCatalogResponseSchema.parse(catalog));
      },
    }),
  );
}
