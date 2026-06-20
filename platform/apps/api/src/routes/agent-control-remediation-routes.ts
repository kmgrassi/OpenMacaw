import type { Request, Response } from "express";

import { z } from "zod";

import {
  AgentControlMessageRowSchema,
  AgentRemediationResponseSchema,
  CreateAgentRemediationRequestSchema,
} from "../../../../contracts/agent-control.js";
import {
  errorPayload,
  handleApiRouteError,
  handleLauncherError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { assertAgentAccess } from "../services/agent-tools/access.js";
import {
  assertAgentControlAccess,
  createAgentRemediation,
  logAgentRemediationRequested,
  mapAgentControlMessage,
  updateAgentControlMessageDispatchStatus,
} from "../services/agent-control.js";
import { assertRuntimePrepareSupported } from "../services/runtime-prepare.js";
import { buildLauncherStartBody } from "./agent-control-launcher-body.js";

const RecoverAgentRuntimeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  mode: z.enum(["restart_runtime", "stop_runtime", "full_recover"]).default("restart_runtime"),
  reason: z.string().trim().min(1).max(500).optional(),
});

export async function recoverAgentRuntime(req: Request, res: Response, launcherClient: LauncherClient) {
  const parsed = RecoverAgentRuntimeRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(
      errorPayload("invalid_request", "workspaceId and a valid recovery mode are required", {
        issues: parsed.error.issues,
      }),
    );
  }

  try {
    const accessToken = requireAccessToken(req);
    const userId = requireVerifiedUser(req);
    const agentId = requireRouteParam(req, "id");
    const { workspaceId } = await assertAgentAccess({
      accessToken,
      userId,
      agentId,
      workspaceId: parsed.data.workspaceId,
    });

    const orchestrators = await launcherClient.listOrchestrators();
    const matchingOrchestrators = orchestrators.data.filter(
      (orchestrator) => orchestrator.agent_id === agentId && orchestrator.workspace_id === workspaceId,
    );

    const stopped = [];
    const stopErrors = [];
    for (const orchestrator of matchingOrchestrators) {
      try {
        const result = await launcherClient.stopOrchestrator(orchestrator.id);
        stopped.push(result.data.data);
      } catch (error) {
        stopErrors.push({
          id: orchestrator.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (stopErrors.length > 0) {
      return res.status(502).json(
        errorPayload("runtime_recovery_stop_failed", "Could not stop every matching runtime", {
          stopped,
          stopErrors,
        }),
      );
    }

    const shouldRestart = parsed.data.mode === "restart_runtime" || parsed.data.mode === "full_recover";
    let restarted = null;
    if (shouldRestart) {
      const restartBody = {
        workspaceId,
        recovery: {
          mode: parsed.data.mode,
          reason: parsed.data.reason ?? null,
          stopped_orchestrator_ids: stopped.map((orchestrator) => orchestrator.id),
        },
      };
      const startBody = await buildLauncherStartBody({
        accessToken,
        requesterUserId: userId,
        agentId,
        workspaceId,
        requestBody: restartBody,
      });
      restarted = await launcherClient.startAgent(agentId, startBody);
    }

    return res.status(200).json({
      status: "ok",
      agentId,
      workspaceId,
      mode: parsed.data.mode,
      stoppedCount: stopped.length,
      stopped,
      restarted: restarted?.data.data ?? null,
    });
  } catch (error) {
    if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "runtime_recovery_failed",
        message: "Runtime recovery failed",
      });
    }
    return handleLauncherError(res, error);
  }
}

export async function createAgentRemediationRequest(req: Request, res: Response, launcherClient: LauncherClient) {
  const parsed = CreateAgentRemediationRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(
      errorPayload("invalid_request", "workspaceId, observerAgentId, and action are required", {
        issues: parsed.error.issues,
      }),
    );
  }

  let remediationId: string | undefined;

  try {
    const userId = requireVerifiedUser(req);
    const targetAgentId = requireRouteParam(req, "id");
    await assertAgentControlAccess({
      userId,
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
    });

    const remediation = await createAgentRemediation({
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
      action: parsed.data.action,
      reason: parsed.data.reason?.trim() || null,
      metadata: parsed.data.metadata ?? {},
      dispatchStatus: parsed.data.action === "restart" ? "dispatching" : "queued",
      createdByUserId: userId,
    });
    remediationId = remediation.id;

    logAgentRemediationRequested({
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
      action: parsed.data.action,
      remediationId: remediation.id,
      dispatchStatus: remediation.dispatch_status,
    });

    if (parsed.data.action !== "restart") {
      return res.status(202).json(
        AgentRemediationResponseSchema.parse({
          remediation: mapAgentControlMessage(remediation),
          dispatch: {
            attempted: false,
            status: "queued",
            result: null,
          },
        }),
      );
    }

    try {
      const accessToken = requireAccessToken(req);
      const prepared = await assertRuntimePrepareSupported(accessToken, userId, targetAgentId);
      const result = await launcherClient.startAgent(
        targetAgentId,
        await buildLauncherStartBody({
          accessToken,
          requesterUserId: userId,
          agentId: targetAgentId,
          workspaceId: prepared.workspaceId,
          requestBody: {},
        }),
      );

      const optimisticRemediation = AgentControlMessageRowSchema.parse({
        ...remediation,
        status: "accepted",
        dispatch_status: "dispatched",
        metadata: {
          ...remediation.metadata,
          launcher_status: result.status,
        },
      });

      const updated = await updateAgentControlMessageDispatchStatus({
        messageId: remediation.id,
        dispatchStatus: "dispatched",
        status: "accepted",
        metadata: optimisticRemediation.metadata,
      }).catch((error) => {
        process.stdout.write(
          `${JSON.stringify({
            event: "agent_remediation_status_update_failed",
            remediation_id: remediation.id,
            workspace_id: parsed.data.workspaceId,
            target_agent_id: targetAgentId,
            observer_agent_id: parsed.data.observerAgentId,
            dispatch_status: "dispatched",
            error_message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        return null;
      });

      return res.status(202).json(
        AgentRemediationResponseSchema.parse({
          remediation: mapAgentControlMessage(updated ?? optimisticRemediation),
          dispatch: {
            attempted: true,
            status: updated ? "dispatched" : "dispatched_status_update_failed",
            result: result.data,
          },
        }),
      );
    } catch (error) {
      await updateAgentControlMessageDispatchStatus({
        messageId: remediation.id,
        dispatchStatus: "failed",
        status: "failed",
        metadata: {
          ...(parsed.data.metadata ?? {}),
          dispatch_error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => undefined);
      if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
        return handleApiRouteError(res, error, {
          status: 502,
          code: "runtime_prepare_failed",
          message: "Runtime preparation failed",
        });
      }
      return handleLauncherError(res, error);
    }
  } catch (error) {
    if (remediationId) {
      await updateAgentControlMessageDispatchStatus({
        messageId: remediationId,
        dispatchStatus: "failed",
        status: "failed",
      }).catch(() => undefined);
    }
    return handleApiRouteError(res, error, {
      status: 502,
      code: "agent_remediation_create_failed",
      message: "Could not persist agent remediation request",
    });
  }
}
