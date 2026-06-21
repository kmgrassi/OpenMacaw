import type { Request, Response } from "express";

import { deriveProviderFromModel } from "../../../../../contracts/agent-helpers.js";
import { defaultRunnerKindForAgentType } from "../../../../../contracts/agent-runner-defaults.js";
import {
  SavedCredentialListResponseSchema,
  type SaveCredentialRequest,
  type UpsertAgentCredentialReferenceRequest,
} from "../../../../../contracts/credentials.js";
import { ModelProviderSchema } from "../../../../../contracts/model-catalog.js";
import type { AuthenticatedApiRouteContext } from "../../http.js";
import { ApiRouteError, errorPayload, handleApiRouteError, requireRouteParam } from "../../http.js";
import {
  getAgentCredentialReferenceRule,
  getRoutingRuleLocalEndpointUrl,
  listRoutingRuleFallbacks,
  upsertAgentCredentialReferenceRule,
  credentialRefFromRoutingRuleFallback,
} from "../../repositories/routing-rules.js";
import { validateCredentialRecord } from "../../services/credential-validation.js";
import { ensureDefaultAgentToolsForAgent } from "../../services/default-agent-tools.js";
import { syncAgentGatewayConfigForExecutionProfile } from "../../services/agent-gateway-config-sync.js";
import { resolveExecutionProfile } from "../../services/execution-profile-resolver.js";
import {
  listSavedCredentialsForAgentFromSupabase,
  saveInlineCredentialForAgentInSupabase,
} from "../../services/saved-credentials.js";
import { buildRequirementStatusFromResolution } from "../../services/setup/builders.js";
import { listWorkspaceCredentialReferenceState } from "../../services/stored-agent-credential-state.js";
import {
  ensureStoredAgentDefaultRouting,
  resolveLocalModelRoutingRule,
  syncCredentialIntoRoutingRuleForAgent,
} from "../../services/stored-agent-routing.js";
import { toolProfileForAgentType } from "../../services/tool-bundles.js";
import { assertCredentialReferenceBelongsToWorkspace, requireStoredAgent } from "./authz.js";
import {
  parseCredentialReferenceRequest,
  parseSaveCredentialRequest,
  requireWorkspaceIdFromRequest,
} from "./request-parsers.js";
import { buildCredentialReferenceResponse, buildSaveCredentialResponse } from "./responses.js";

export async function ensureDefaultRoutingHandler(input: {
  req: Request;
  res: Response;
  accessToken: string;
  userId: string;
}) {
  const { req, res, accessToken, userId } = input;
  const agentId = requireRouteParam(req, "agentId");
  const result = await ensureStoredAgentDefaultRouting({
    agentId,
    accessToken,
    userId,
  });
  const { configured, missing } = buildRequirementStatusFromResolution(result.resolution);
  return res.status(200).json({
    agentId: result.agent.id,
    workspaceId: result.agent.workspaceId,
    changed: result.changed,
    configurationStatus: { configured, missing },
    executionProfile: result.resolution,
  });
}

export async function listStoredAgentCredentials({ req, res, accessToken, userId }: AuthenticatedApiRouteContext) {
  try {
    const workspaceId = requireWorkspaceIdFromRequest(req);
    const agentId = requireRouteParam(req, "id");
    await requireStoredAgent({ accessToken, userId, agentId, workspaceId });
    const credentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
    return res.status(200).json(
      SavedCredentialListResponseSchema.parse({
        credentials: credentials.map(
          ({ secretValue: _secretValue, secretRef: _secretRef, aliases: _aliases, ...credential }) => credential,
        ),
      }),
    );
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "supabase_unreachable",
      message: error instanceof ApiRouteError ? error.message : "Could not read stored credentials from Supabase",
    });
  }
}

export async function getStoredAgentCredentialReference({
  req,
  res,
  accessToken,
  userId,
}: AuthenticatedApiRouteContext) {
  try {
    const workspaceId = requireWorkspaceIdFromRequest(req);
    const agentId = requireRouteParam(req, "id");
    const agent = await requireStoredAgent({ accessToken, userId, agentId, workspaceId });
    const state = await listWorkspaceCredentialReferenceState(workspaceId, userId);
    const rule = await getAgentCredentialReferenceRule({
      agentId: agent.id,
      workspaceId,
    });
    const resolvedProfile = rule
      ? null
      : (
          await resolveExecutionProfile({
            agentId: agent.id,
            requesterUserId: userId,
            skipCredentialCheck: true,
          })
        ).profile;
    const localEndpointUrl = rule
      ? await getRoutingRuleLocalEndpointUrl({
          ruleId: rule.id,
          workspaceId,
        })
      : null;
    const fallbacks = rule
      ? await listRoutingRuleFallbacks({
          ruleId: rule.id,
          workspaceId,
        })
      : [];

    return res.status(200).json(
      buildCredentialReferenceResponse({
        agent,
        workspaceId,
        state,
        rule,
        fallbacks: fallbacks.map((fallback) => ({
          provider: fallback.provider,
          model: fallback.model,
          credentialRef: credentialRefFromRoutingRuleFallback(fallback),
        })),
        localEndpointUrl,
        runnerKind: resolvedProfile?.runnerKind ?? defaultRunnerKindForAgentType(agent.agentType),
        provider: resolvedProfile?.provider ?? agent.provider ?? deriveProviderFromModel(agent.model),
        model: resolvedProfile?.model ?? agent.model,
      }),
    );
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_reference_read_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not read credential reference",
    });
  }
}

async function upsertCredentialReference(
  req: Request,
  request: UpsertAgentCredentialReferenceRequest,
  auth: Pick<AuthenticatedApiRouteContext, "accessToken" | "userId">,
) {
  const agentId = requireRouteParam(req, "id");
  const agent = await requireStoredAgent({
    accessToken: auth.accessToken,
    userId: auth.userId,
    agentId,
    workspaceId: request.workspaceId,
  });
  await assertCredentialReferenceBelongsToWorkspace({
    workspaceId: request.workspaceId,
    credentialRef: request.credentialRef,
  });
  for (const fallback of request.fallbacks) {
    await assertCredentialReferenceBelongsToWorkspace({
      workspaceId: request.workspaceId,
      credentialRef: fallback.credentialRef,
    });
  }

  const requestedRunnerKind = request.runnerKind ?? defaultRunnerKindForAgentType(agent.agentType);
  const localModelRule =
    requestedRunnerKind === "local_model_coding"
      ? await resolveLocalModelRoutingRule({
          workspaceId: request.workspaceId,
          localModelId: request.localModelId,
          localEndpointUrl: request.localEndpointUrl,
        })
      : null;
  const rule = await upsertAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: request.workspaceId,
    runnerKind: requestedRunnerKind,
    provider: localModelRule?.provider ?? request.provider ?? agent.provider ?? deriveProviderFromModel(agent.model),
    model: localModelRule?.model ?? request.model ?? agent.model,
    credentialRef: request.credentialRef,
    fallbacks: request.fallbacks,
    modelTierFloor: request.modelTierFloor,
    localEndpointUrl: localModelRule?.endpointUrl ?? request.localEndpointUrl ?? null,
  });
  if (rule.runner_kind === "local_model_coding") {
    await ensureDefaultAgentToolsForAgent({
      agentId: agent.id,
      workspaceId: request.workspaceId,
      agentType: agent.agentType,
      toolProfile: toolProfileForAgentType(agent.agentType),
      runnerKind: rule.runner_kind,
      userId: auth.userId,
    });
  }
  await syncAgentGatewayConfigForExecutionProfile({
    accessToken: auth.accessToken,
    userId: auth.userId,
    agentId: agent.id,
  });
  const state = await listWorkspaceCredentialReferenceState(request.workspaceId, auth.userId);
  const localEndpointUrl =
    localModelRule?.endpointUrl ??
    (await getRoutingRuleLocalEndpointUrl({
      ruleId: rule.id,
      workspaceId: request.workspaceId,
    }));
  const fallbacks = await listRoutingRuleFallbacks({
    ruleId: rule.id,
    workspaceId: request.workspaceId,
  });

  return buildCredentialReferenceResponse({
    agent,
    workspaceId: request.workspaceId,
    state,
    rule,
    fallbacks: fallbacks.map((fallback) => ({
      provider: fallback.provider,
      model: fallback.model,
      credentialRef: credentialRefFromRoutingRuleFallback(fallback),
    })),
    localEndpointUrl,
    runnerKind: rule.runner_kind,
    provider: agent.provider,
    model: rule.model ?? agent.model,
  });
}

export async function saveStoredAgentCredentialReference({
  req,
  res,
  accessToken,
  userId,
}: AuthenticatedApiRouteContext) {
  try {
    const request = parseCredentialReferenceRequest(req);
    const response = await upsertCredentialReference(req, request, { accessToken, userId });
    return res.status(200).json(response);
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_reference_save_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not save credential reference",
    });
  }
}

async function syncSavedCredentialIntoRouting(
  input: SaveCredentialRequest & {
    accessToken: string;
    agentId: string;
    credentialRowId?: string | null;
    userId?: string | null;
  },
) {
  if (!input.credentialRowId) {
    return;
  }
  const agent = await requireStoredAgent({
    accessToken: input.accessToken,
    userId: input.userId ?? "",
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });
  if (!agent.workspaceId) return;

  await syncCredentialIntoRoutingRuleForAgent({
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      agentType: agent.agentType,
      model: agent.model,
      provider: agent.provider,
    },
    credentialId: input.credentialRowId,
    provider: input.provider,
  });
}

export async function saveStoredAgentCredential({ req, res, accessToken, userId }: AuthenticatedApiRouteContext) {
  try {
    const request = parseSaveCredentialRequest(req);
    const agentId = requireRouteParam(req, "id");
    await requireStoredAgent({
      accessToken,
      userId,
      agentId,
      workspaceId: request.workspaceId,
    });
    if (!ModelProviderSchema.safeParse(request.provider).success) {
      return res
        .status(400)
        .json(errorPayload("unsupported_credential_provider", "Agent credentials must use a model provider"));
    }

    const validation = await validateCredentialRecord({
      raw: {
        provider: request.provider,
      },
      provider: request.provider,
      apiKey: request.apiKey,
    });
    if (!validation.ok) {
      return res.status(400).json(
        errorPayload("credential_validation_failed", validation.message, {
          validation,
        }),
      );
    }

    const saved = await saveInlineCredentialForAgentInSupabase({
      agentId,
      workspaceId: request.workspaceId,
      provider: request.provider,
      apiKey: request.apiKey,
      validationState: "ok",
      validatedAt: validation.checkedAt,
    });

    await syncSavedCredentialIntoRouting({
      accessToken,
      ...request,
      agentId,
      credentialRowId: saved.credentialRowId,
      userId,
    });
    await syncAgentGatewayConfigForExecutionProfile({
      accessToken,
      userId,
      agentId,
    });

    return res.status(200).json(buildSaveCredentialResponse(saved));
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: error instanceof ApiRouteError ? error.status : 502,
      code: error instanceof ApiRouteError ? error.code : "credential_save_failed",
      message: error instanceof ApiRouteError ? error.message : "Could not persist stored credential",
    });
  }
}
