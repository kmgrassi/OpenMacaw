import type { Express, Request, Response } from "express";

import { SnoozeWorkItemRequestSchema, WakeWorkItemRequestSchema } from "../../../../contracts/work-item-snooze.js";
import { ManualWorkItemRequestSchema } from "../../../../contracts/work-items.js";
import type { ApiConfig } from "../config.js";
import { ApiRouteError, apiRoute, errorPayload } from "../http.js";
import { snoozeWorkItemForWorkspace, wakeWorkItemForWorkspace } from "../services/work-item-snooze.js";
import {
  assertWorkspaceMembership,
  claimWebhookDelivery,
  isRecentLinearWebhookTimestamp,
  mapWorkItemIngestResponse,
  normalizeGitHubWebhook,
  normalizeLinearWebhook,
  normalizeManualWorkItem,
  releaseWebhookDeliveryClaim,
  upsertWorkItemFromNormalizedInput,
  verifyGithubSignature,
  verifyLinearSignature,
} from "../services/work-item-ingest.js";
import { deleteWorkItemForWorkspace, listWorkItemsForWorkspace } from "../services/workspace-plans.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

function workspaceRoutingFromConfig(config: ApiConfig) {
  return {
    defaultWorkspaceId: config.workItemDefaultWorkspaceId,
    githubRepoWorkspaceMap: config.githubRepoWorkspaceMap,
    linearProjectWorkspaceMap: config.linearProjectWorkspaceMap,
    linearTeamWorkspaceMap: config.linearTeamWorkspaceMap,
  };
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

export function registerWorkItemRoutes(app: Express, config: ApiConfig) {
  app.get(
    "/api/workspaces/:workspaceId/work-items",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        if (!workspaceId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
        }
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await listWorkItemsForWorkspace(workspaceId));
      },
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/work-items/:workItemId/snooze",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        const workItemId = req.params.workItemId?.trim() ?? "";
        if (!workspaceId || !workItemId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId and workItemId are required");
        }
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        const parsed = SnoozeWorkItemRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid snooze request", parsed.error.flatten());
        }
        if (parsed.data.workspaceId !== workspaceId || parsed.data.workItemId !== workItemId) {
          throw new ApiRouteError(400, "invalid_request", "Request body ids must match route params");
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await snoozeWorkItemForWorkspace({ request: parsed.data, userId }));
      },
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/work-items/:workItemId/wake",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        const workItemId = req.params.workItemId?.trim() ?? "";
        if (!workspaceId || !workItemId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId and workItemId are required");
        }
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        const parsed = WakeWorkItemRequestSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new ApiRouteError(400, "invalid_request", "Invalid wake request", parsed.error.flatten());
        }
        if (parsed.data.workspaceId !== workspaceId || parsed.data.workItemId !== workItemId) {
          throw new ApiRouteError(400, "invalid_request", "Request body ids must match route params");
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await wakeWorkItemForWorkspace({ workspaceId, workItemId, userId }));
      },
    }),
  );

  app.delete(
    "/api/workspaces/:workspaceId/work-items/:workItemId",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = req.params.workspaceId?.trim() ?? "";
        const workItemId = req.params.workItemId?.trim() ?? "";
        if (!workspaceId || !workItemId) {
          throw new ApiRouteError(400, "invalid_request", "workspaceId and workItemId are required");
        }
        if (!userId) {
          throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
        }

        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await deleteWorkItemForWorkspace(workspaceId, workItemId));
      },
    }),
  );

  app.post("/api/work-items", async (req: Request, res: Response) => {
    const parsed = ManualWorkItemRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(errorPayload("invalid_request", "workspaceId and title are required"));
    }

    if (!req.userId) {
      return res.status(401).json(errorPayload("auth_required", "Supabase access token is required"));
    }

    try {
      await assertWorkspaceMembership(req.userId, parsed.data.workspaceId);
      const normalized = normalizeManualWorkItem(parsed.data);
      const created = await upsertWorkItemFromNormalizedInput(normalized);
      return res.status(201).json(mapWorkItemIngestResponse(created));
    } catch (error) {
      return res
        .status(502)
        .json(errorPayload("work_item_create_failed", "Could not persist work item", String(error)));
    }
  });

  app.post("/api/webhooks/github", async (req: RawBodyRequest, res: Response) => {
    if (!config.githubWebhookSecret) {
      return res
        .status(503)
        .json(errorPayload("github_webhook_unconfigured", "GitHub webhook secret is not configured"));
    }

    const signature = req.header("x-hub-signature-256") ?? undefined;
    if (!req.rawBody || !verifyGithubSignature(req.rawBody, config.githubWebhookSecret, signature)) {
      return res.status(401).json(errorPayload("invalid_signature", "GitHub webhook signature verification failed"));
    }

    const eventName = req.header("x-github-event")?.trim() || "";
    if (!eventName) {
      return res.status(400).json(errorPayload("invalid_request", "Missing X-GitHub-Event header"));
    }
    const deliveryId = req.header("x-github-delivery")?.trim() || "";
    if (!deliveryId) {
      return res.status(400).json(errorPayload("invalid_request", "Missing X-GitHub-Delivery header"));
    }

    try {
      const normalized = normalizeGitHubWebhook(
        {
          eventName,
          deliveryId,
          action: typeof req.body?.action === "string" ? req.body.action : null,
          payload: req.body ?? {},
        },
        workspaceRoutingFromConfig(config),
      );

      if (!normalized) {
        return res.status(202).json({ accepted: true, skipped: true, reason: "unsupported_event" });
      }

      const claimed = await claimWebhookDelivery({
        source: "github",
        deliveryId,
        eventName,
        workspaceId: normalized.workspaceId,
        externalId: normalized.externalId,
      });
      if (!claimed) {
        return res.status(202).json({ accepted: true, skipped: true, reason: "duplicate_delivery" });
      }

      try {
        const saved = await upsertWorkItemFromNormalizedInput(normalized);
        return res.status(202).json(mapWorkItemIngestResponse(saved));
      } catch (error) {
        await releaseWebhookDeliveryClaim({ source: "github", deliveryId }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return res
        .status(502)
        .json(errorPayload("github_webhook_failed", "Could not process GitHub webhook", String(error)));
    }
  });

  app.post("/api/webhooks/linear", async (req: RawBodyRequest, res: Response) => {
    if (!config.linearWebhookSecret) {
      return res
        .status(503)
        .json(errorPayload("linear_webhook_unconfigured", "Linear webhook secret is not configured"));
    }

    const signature = req.header("linear-signature") ?? undefined;
    if (!req.rawBody || !verifyLinearSignature(req.rawBody, config.linearWebhookSecret, signature)) {
      return res.status(401).json(errorPayload("invalid_signature", "Linear webhook signature verification failed"));
    }
    const deliveryId = req.header("linear-delivery")?.trim() || "";
    if (!deliveryId) {
      return res.status(400).json(errorPayload("invalid_request", "Missing Linear-Delivery header"));
    }

    if (!isRecentLinearWebhookTimestamp(req.body?.webhookTimestamp)) {
      return res
        .status(401)
        .json(errorPayload("invalid_timestamp", "Linear webhook timestamp is outside the accepted window"));
    }

    try {
      const normalized = normalizeLinearWebhook(
        {
          eventName: req.header("linear-event")?.trim() || "",
          deliveryId,
          payload: req.body ?? {},
        },
        workspaceRoutingFromConfig(config),
      );

      if (!normalized) {
        return res.status(202).json({ accepted: true, skipped: true, reason: "unsupported_event" });
      }

      const claimed = await claimWebhookDelivery({
        source: "linear",
        deliveryId,
        eventName: req.header("linear-event")?.trim() || "",
        workspaceId: normalized.workspaceId,
        externalId: normalized.externalId,
      });
      if (!claimed) {
        return res.status(202).json({ accepted: true, skipped: true, reason: "duplicate_delivery" });
      }

      try {
        const saved = await upsertWorkItemFromNormalizedInput(normalized);
        return res.status(202).json(mapWorkItemIngestResponse(saved));
      } catch (error) {
        await releaseWebhookDeliveryClaim({ source: "linear", deliveryId }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return res
        .status(502)
        .json(errorPayload("linear_webhook_failed", "Could not process Linear webhook", String(error)));
    }
  });
}
