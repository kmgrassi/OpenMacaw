import type { Express } from "express";

import {
  AgentPoliciesResponseSchema,
  CreateSessionPolicyRequestSchema,
  PolicyMutationResponseSchema,
  SessionPoliciesResponseSchema,
  SessionPolicyStateResponseSchema,
  UpsertAgentPolicyRequestSchema,
} from "../../../../contracts/policy.js";
import { apiRoute, errorPayload, handleApiRouteError, requestWorkspaceId, requireRouteParam } from "../http.js";
import {
  createSessionPolicy,
  deleteAgentPolicy,
  deleteSessionPolicy,
  getAgentPolicies,
  getSessionPolicies,
  getSessionPolicyState,
  upsertAgentPolicy,
} from "../services/policies.js";

function handlePolicyError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "policy_request_failed",
    message: "Policy request failed",
  });
}

export function registerPolicyRoutes(app: Express) {
  app.get(
    "/api/agents/:agentId/policies",
    apiRoute({
      requireAuth: true,
      onError: handlePolicyError,
      async handler({ req, res, accessToken, userId }) {
        const result = await getAgentPolicies({
          accessToken,
          userId,
          agentId: requireRouteParam(req, "agentId"),
          workspaceId: requestWorkspaceId(req),
        });
        return res.status(200).json(AgentPoliciesResponseSchema.parse(result));
      },
    }),
  );

  app.put(
    "/api/agents/:agentId/policies/:policyId",
    apiRoute({
      requireAuth: true,
      bodySchema: UpsertAgentPolicyRequestSchema,
      invalidBodyMessage: "Policy request is invalid",
      onError: handlePolicyError,
      async handler({ req, res, accessToken, userId, body }) {
        const policy = await upsertAgentPolicy({
          accessToken,
          userId,
          agentId: requireRouteParam(req, "agentId"),
          policyId: requireRouteParam(req, "policyId"),
          request: body,
        });
        return res.status(200).json(PolicyMutationResponseSchema.parse({ policy }));
      },
    }),
  );

  app.delete(
    "/api/agents/:agentId/policies/:policyId",
    apiRoute({
      requireAuth: true,
      onError: handlePolicyError,
      async handler({ req, res, accessToken, userId }) {
        await deleteAgentPolicy({
          accessToken,
          userId,
          agentId: requireRouteParam(req, "agentId"),
          policyId: requireRouteParam(req, "policyId"),
          workspaceId: requestWorkspaceId(req),
        });
        return res.status(204).send();
      },
    }),
  );

  app.get(
    "/api/sessions/:sessionThreadId/policies",
    apiRoute({
      requireAuth: true,
      onError: handlePolicyError,
      async handler({ req, res, userId }) {
        const workspaceId = requestWorkspaceId(req);
        if (!workspaceId) return res.status(400).json(errorPayload("invalid_request", "workspaceId is required"));
        const result = await getSessionPolicies({
          userId,
          workspaceId,
          sessionThreadId: requireRouteParam(req, "sessionThreadId"),
        });
        return res.status(200).json(SessionPoliciesResponseSchema.parse(result));
      },
    }),
  );

  app.post(
    "/api/sessions/:sessionThreadId/policies",
    apiRoute({
      requireAuth: true,
      bodySchema: CreateSessionPolicyRequestSchema,
      invalidBodyMessage: "Policy request is invalid",
      onError: handlePolicyError,
      async handler({ req, res, userId, body }) {
        const policy = await createSessionPolicy({
          userId,
          sessionThreadId: requireRouteParam(req, "sessionThreadId"),
          request: body,
        });
        return res.status(201).json(PolicyMutationResponseSchema.parse({ policy }));
      },
    }),
  );

  app.delete(
    "/api/sessions/:sessionThreadId/policies/:policyId",
    apiRoute({
      requireAuth: true,
      onError: handlePolicyError,
      async handler({ req, res, userId }) {
        const workspaceId = requestWorkspaceId(req);
        if (!workspaceId) return res.status(400).json(errorPayload("invalid_request", "workspaceId is required"));
        await deleteSessionPolicy({
          userId,
          workspaceId,
          sessionThreadId: requireRouteParam(req, "sessionThreadId"),
          policyId: requireRouteParam(req, "policyId"),
        });
        return res.status(204).send();
      },
    }),
  );

  app.get(
    "/api/sessions/:sessionThreadId/policy-state",
    apiRoute({
      requireAuth: true,
      onError: handlePolicyError,
      async handler({ req, res, userId }) {
        const workspaceId = requestWorkspaceId(req);
        if (!workspaceId) return res.status(400).json(errorPayload("invalid_request", "workspaceId is required"));
        const state = await getSessionPolicyState({
          userId,
          workspaceId,
          sessionThreadId: requireRouteParam(req, "sessionThreadId"),
        });
        return res.status(200).json(SessionPolicyStateResponseSchema.parse({ state }));
      },
    }),
  );
}
