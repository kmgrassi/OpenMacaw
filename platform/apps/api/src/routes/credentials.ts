import type { Express } from "express";

import {
  CreateCredentialRequestSchema,
  CreateCredentialResponseSchema,
  SavedCredentialListResponseSchema,
  type CredentialProvider,
} from "../../../../contracts/credentials.js";
import { MODEL_PROVIDER_IDS, type ModelProvider } from "../../../../contracts/provider-registry.js";
import { ApiRouteError, apiRoute } from "../http.js";
import { upsertCredentialAlias } from "../repositories/credentials.js";
import { validateModelProviderCredential } from "../services/model-catalog.js";
import { syncCredentialIntoRoutingRuleForAgent } from "../services/stored-agent-routing.js";
import {
  saveInlineCredentialForAgentInSupabase,
  saveModelProviderCredentialForWorkspaceInSupabase,
  saveOpenAICodexAccessTokenCredentialForAgent,
} from "../services/saved-credentials.js";
import { listWorkspaceCredentialReferenceState } from "../services/stored-agent-credential-state.js";
import { requireStoredAgent } from "./stored-agent-credentials/authz.js";

const MODEL_CREDENTIAL_PROVIDERS = new Set<string>(MODEL_PROVIDER_IDS);

function asModelProvider(provider: CredentialProvider): ModelProvider | null {
  return MODEL_CREDENTIAL_PROVIDERS.has(provider) ? (provider as ModelProvider) : null;
}

export function registerCredentialRoutes(app: Express) {
  app.get(
    "/api/credentials",
    apiRoute({
      requireAuth: true,
      handler: async ({ req, res, userId }) => {
        const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }

        const state = await listWorkspaceCredentialReferenceState(workspaceId, userId ?? null);
        return res.status(200).json(
          SavedCredentialListResponseSchema.parse({
            credentials: state.credentials,
          }),
        );
      },
    }),
  );

  app.post(
    "/api/credentials",
    apiRoute({
      requireAuth: true,
      bodySchema: CreateCredentialRequestSchema,
      invalidBodyMessage: "Credential scope and key are required",
      handler: async ({ body, res, userId, accessToken }) => {
        const { key, scope } = body;
        if (scope.kind === "user") {
          throw new ApiRouteError(
            400,
            "unsupported_credential_scope",
            "Personal credentials are not supported by the current credential schema",
          );
        }
        if (key.format !== "api_key" && !(key.format === "oauth" && scope.kind === "agent")) {
          throw new ApiRouteError(
            400,
            "unsupported_credential_format",
            "Credential format is not supported for this scope",
          );
        }

        const agent =
          scope.kind === "agent"
            ? await requireStoredAgent({
                accessToken,
                userId,
                agentId: scope.agentId,
                workspaceId: scope.workspaceId,
              })
            : null;

        let saved;
        if (key.format === "oauth" && scope.kind === "agent") {
          saved = await saveOpenAICodexAccessTokenCredentialForAgent({
            agentId: scope.agentId,
            workspaceId: scope.workspaceId,
            accessToken: key.access,
            expiresAt: key.expiresAt,
            identity: key.identity ?? {},
          });
        } else if (key.format === "api_key" && scope.kind === "agent") {
          const provider = asModelProvider(key.provider);
          if (!provider) {
            throw new ApiRouteError(
              400,
              "unsupported_credential_provider",
              "Agent credentials must use a model provider",
            );
          }
          const validation = await validateModelProviderCredential({
            provider,
            apiKey: key.secret,
            endpoint: key.endpoint,
            apiVersion: key.apiVersion,
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
          saved = await saveInlineCredentialForAgentInSupabase({
            agentId: scope.agentId,
            workspaceId: scope.workspaceId,
            provider: key.provider,
            apiKey: key.secret,
            validationState: "ok",
            validatedAt: validation.checkedAt,
          });
        } else if (key.format === "api_key" && scope.kind === "workspace") {
          const provider = asModelProvider(key.provider);
          const validation = provider
            ? await validateModelProviderCredential({
                provider,
                apiKey: key.secret,
                endpoint: key.endpoint,
                apiVersion: key.apiVersion,
              })
            : {
                ok: true,
                checkedAt: null,
                error: null,
              };
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
          saved = await saveModelProviderCredentialForWorkspaceInSupabase({
            workspaceId: scope.workspaceId,
            userId: userId ?? null,
            provider: key.provider,
            apiKey: key.secret,
            endpoint: key.endpoint,
            apiVersion: key.apiVersion,
            validationState: validation.checkedAt ? "ok" : "unknown",
            validatedAt: validation.checkedAt,
          });
        } else {
          saved = null;
        }
        if (!saved) {
          throw new ApiRouteError(
            400,
            "unsupported_credential_scope",
            "Credential scope is not supported for this credential format",
          );
        }

        if (body.alias?.trim() && saved.credentialRowId) {
          await upsertCredentialAlias({
            workspaceId: scope.workspaceId,
            alias: body.alias.trim(),
            credentialId: saved.credentialRowId,
          });
        }

        if (scope.kind === "agent" && saved.credentialRowId && agent?.workspaceId) {
          await syncCredentialIntoRoutingRuleForAgent({
            agent: {
              id: agent.id,
              workspaceId: agent.workspaceId,
              agentType: agent.agentType,
              model: agent.model,
              provider: agent.provider,
            },
            credentialId: saved.credentialRowId,
            provider: saved.provider ?? key.provider,
            userId,
          });
        }

        return res.status(200).json(
          CreateCredentialResponseSchema.parse({
            credential: {
              id: saved.id,
              credentialRowId: saved.credentialRowId,
              agentId: saved.agentId,
              workspaceId: saved.workspaceId,
              provider: saved.provider,
              label: saved.label,
              envVar: saved.envVar,
              updatedAt: saved.updatedAt,
              validationState: saved.validationState,
              validatedAt: saved.validatedAt,
              launchableKind: saved.launchableKind,
            },
          }),
        );
      },
    }),
  );
}
