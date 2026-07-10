import type { Express, Response } from "express";
import { validatePlan, type PlanV1 } from "@harper/plan-schema";

import {
  PlanDraftFromPromptRequestSchema,
  PlanDraftFromPromptResponseSchema,
  PlanReviewListResponseSchema,
  PlanRecordSchema,
} from "../../../../contracts/plans.js";
import { WorkItemProjectionSchema } from "../../../../contracts/work-items.js";
import type { ApiConfig } from "../config.js";
import { ApiRouteError, apiRoute, errorPayload, handleApiRouteError, requireRouteParam } from "../http.js";
import { createPlanDraftFromPrompt, PlanDraftValidationError } from "../services/plan-drafts.js";
import { fetchPlanReviewsForWorkspace } from "../services/plan-review.js";
import { createPlanWithWorkItems, PlanGraphValidationError } from "../services/plans.js";
import type { UpstreamResponse } from "../services/upstream.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { deletePlanForWorkspace, listPlansForWorkspace } from "../services/workspace-plans.js";

function handlePlanDraftError(res: Response, error: unknown) {
  if (error instanceof PlanDraftValidationError) {
    return res.status(422).json({ errors: error.errors });
  }

  return handleApiRouteError(res, error, {
    status: 502,
    code: "plan_draft_failed",
    message: "Could not create plan draft",
  });
}

function handlePlanCreateError(res: Response, error: unknown) {
  if (error instanceof PlanGraphValidationError) {
    return res.status(400).json(errorPayload("invalid_plan_graph", error.message, error.details));
  }

  if (error instanceof ApiRouteError) {
    return res.status(error.status).json(errorPayload(error.code, error.message, error.details));
  }

  return handleApiRouteError(res, error, {
    status: 502,
    code: "plan_create_failed",
    message: "Could not persist plan",
  });
}

function handlePlanReviewError(res: Response, error: unknown) {
  if (error instanceof ApiRouteError) {
    return res.status(error.status).json(errorPayload(error.code, error.message, error.details));
  }

  return handleApiRouteError(res, error, {
    status: 502,
    code: "plan_reviews_failed",
    message: "Could not read plan reviews",
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parsePlanCreateBody(body: unknown): { workspaceId: string; plan: PlanV1 } | { errors: unknown[] } {
  const record = asRecord(body);
  const workspaceId = typeof record?.workspaceId === "string" ? record.workspaceId.trim() : "";
  const { workspaceId: _workspaceId, ...planCandidate } = record ?? {};
  const validation = validatePlan(planCandidate);
  const errors: unknown[] = validation.ok ? [] : [...validation.errors];

  if (!workspaceId) {
    errors.unshift({
      path: ["workspaceId"],
      code: "invalid_type",
      message: "workspaceId is required",
    });
  }

  if (errors.length > 0 || !validation.ok) {
    return { errors };
  }

  return { workspaceId, plan: validation.plan };
}

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

export function registerPlanRoutes(
  app: Express,
  config: ApiConfig,
  launcherRequest: (path: string, init?: RequestInit) => Promise<UpstreamResponse>,
) {
  app.get(
    "/api/workspaces/:workspaceId/plans",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireRouteParam(req, "workspaceId");
        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await listPlansForWorkspace(workspaceId));
      },
    }),
  );

  app.delete(
    "/api/workspaces/:workspaceId/plans/:planId",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireRouteParam(req, "workspaceId");
        const planId = requireRouteParam(req, "planId");
        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await deletePlanForWorkspace(workspaceId, planId));
      },
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/plan-reviews",
    apiRoute({
      requireAuth: true,
      onError: handlePlanReviewError,
      async handler({ req, res, userId }) {
        const workspaceId = requireRouteParam(req, "workspaceId");
        await requireWorkspaceAccess(userId, workspaceId);
        const plans = await fetchPlanReviewsForWorkspace(workspaceId);

        return res.status(200).json(PlanReviewListResponseSchema.parse({ plans }));
      },
    }),
  );

  app.post(
    "/api/plans",
    apiRoute({
      requireAuth: true,
      onError: handlePlanCreateError,
      async handler({ res, body, userId }) {
        const parsed = parsePlanCreateBody(body ?? {});
        if ("errors" in parsed) {
          throw new ApiRouteError(400, "invalid_plan", "Plan document is invalid", parsed.errors);
        }

        await requireWorkspaceAccess(userId, parsed.workspaceId);
        const created = await createPlanWithWorkItems({
          ...parsed.plan,
          workspaceId: parsed.workspaceId,
        });
        return res.status(201).json({
          plan: PlanRecordSchema.parse(created.plan),
          workItems: created.workItems.map((workItem) => WorkItemProjectionSchema.parse(workItem)),
        });
      },
    }),
  );

  app.post(
    "/api/plans/draft-from-prompt",
    apiRoute({
      bodySchema: PlanDraftFromPromptRequestSchema,
      invalidBodyMessage: "Plan draft request is invalid",
      requireAuth: true,
      onError: handlePlanDraftError,
      async handler({ res, body, accessToken, userId }) {
        const result = await createPlanDraftFromPrompt({
          accessToken,
          userId,
          request: body,
          launcherRequest,
          requestTimeoutMs: config.orchestratorRequestTimeoutMs,
        });

        return res.status(200).json(PlanDraftFromPromptResponseSchema.parse(result));
      },
    }),
  );
}
