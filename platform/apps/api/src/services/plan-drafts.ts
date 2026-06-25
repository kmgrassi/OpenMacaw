import type { PlanBody } from "../../../../contracts/plans.js";
import {
  PlanBodySchema,
  type PlanDraftFromPromptRequest,
  type PlanDraftFromPromptResponse,
} from "../../../../contracts/plans.js";
import { z } from "zod";
import { ApiRouteError } from "../http.js";
import { getDefaultAgentStatusForWorkspace, listSetupAuthState } from "./setup.js";
import { redactOutboundPromptForWorkspace } from "./prompt-redaction.js";
import { resolveRuntimeTargetForAgent } from "./runtime-target.js";
import { createUpstreamRequester, type UpstreamResponse } from "./upstream.js";

type LauncherRequest = (path: string, init?: RequestInit) => Promise<UpstreamResponse>;

type DraftPlanOptions = {
  accessToken: string;
  userId: string;
  request: PlanDraftFromPromptRequest;
  launcherRequest: LauncherRequest;
  requestTimeoutMs: number;
};

export type PlanValidationError = {
  path: string;
  message: string;
  code?: string;
};

export class PlanDraftValidationError extends Error {
  readonly errors: PlanValidationError[];

  constructor(errors: PlanValidationError[], message = "Planner produced an invalid plan draft") {
    super(message);
    this.name = "PlanDraftValidationError";
    this.errors = errors;
  }
}

const RuntimeValidationErrorEnvelopeSchema = z.union([
  z.object({ errors: z.array(z.unknown()) }),
  z.object({
    error: z.object({
      details: z.array(z.unknown()),
    }),
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey<Key extends string>(
  value: unknown,
  key: Key,
): value is Record<Key, unknown> & Record<string, unknown> {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toValidationErrors(error: { issues: Array<{ path: PropertyKey[]; message: string; code: string }> }) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `/${issue.path.map(String).join("/")}` : "/",
    message: issue.message,
    code: issue.code,
  }));
}

function extractRuntimeValidationErrors(body: unknown): PlanValidationError[] | null {
  const parsedEnvelope = RuntimeValidationErrorEnvelopeSchema.safeParse(body);
  if (!parsedEnvelope.success) return null;

  const errors = "errors" in parsedEnvelope.data ? parsedEnvelope.data.errors : parsedEnvelope.data.error.details;

  return errors.map((entry) => {
    if (!isRecord(entry)) {
      return { path: "/", message: String(entry) };
    }

    return {
      path: stringField(entry.path) ?? stringField(entry.instancePath) ?? "/",
      message: stringField(entry.message) ?? "Invalid plan draft",
      code: stringField(entry.code) ?? stringField(entry.keyword),
    };
  });
}

function extractDraftPlan(body: unknown): unknown {
  if (hasOwnKey(body, "draft")) return body.draft;
  if (hasOwnKey(body, "plan")) return body.plan;
  if (!hasOwnKey(body, "data")) return body;
  if (hasOwnKey(body.data, "draft")) return body.data.draft;
  if (hasOwnKey(body.data, "plan")) return body.data.plan;
  return body;
}

function validateDraftPlan(candidate: unknown): PlanBody {
  const parsed = PlanBodySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanDraftValidationError(toValidationErrors(parsed.error));
  }
  return parsed.data;
}

export async function createPlanDraftFromPrompt({
  accessToken,
  userId,
  request,
  launcherRequest,
  requestTimeoutMs,
}: DraftPlanOptions): Promise<PlanDraftFromPromptResponse> {
  const authState = await listSetupAuthState(accessToken, userId);
  const workspace = authState.workspaces.find((candidate) => candidate.id === request.workspaceId) ?? null;
  if (!workspace) {
    throw new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user");
  }

  const planningAgent = await getDefaultAgentStatusForWorkspace(accessToken, userId, request.workspaceId, "planning");
  if (!planningAgent?.agentId || !planningAgent.configured) {
    throw new ApiRouteError(409, "planning_agent_unconfigured", "A configured default planning agent is required", {
      missing: planningAgent?.missing ?? ["agent"],
    });
  }

  const planningAgentId = planningAgent.agentId;
  let redactedPrompt: string;
  try {
    redactedPrompt = (
      await redactOutboundPromptForWorkspace({
        prompt: request.prompt,
        planningAgentId,
        workspaceId: request.workspaceId,
        userId,
      })
    ).prompt;
  } catch (error) {
    throw new ApiRouteError(
      502,
      "credential_redaction_failed",
      "Could not prepare prompt for planner runtime",
      error instanceof Error ? error.message : String(error),
    );
  }

  const target = await resolveRuntimeTargetForAgent(planningAgentId, launcherRequest);
  const runtimeRequest = createUpstreamRequester(target.baseUrl, requestTimeoutMs);
  const response = await runtimeRequest("/api/v1/plans/draft-from-prompt", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      workspace_id: request.workspaceId,
      prompt: redactedPrompt,
      default_runner: request.defaultRunner,
      default_model: request.defaultModel,
      dry_run: true,
    }),
  });

  if (response.status === 422) {
    throw new PlanDraftValidationError(
      extractRuntimeValidationErrors(response.body) ?? [
        { path: "/", message: "Planner produced an invalid plan draft" },
      ],
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiRouteError(
      response.status >= 500 ? 502 : response.status,
      "planner_runtime_failed",
      "Planner runtime failed",
      {
        runtime_status: response.status,
        runtime_error: response.body,
      },
    );
  }

  return {
    draft: validateDraftPlan(extractDraftPlan(response.body)),
  };
}
