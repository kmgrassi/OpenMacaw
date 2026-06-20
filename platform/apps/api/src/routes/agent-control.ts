import type { Express, Request, Response } from "express";
import {
  handleApiRouteError,
  handleLauncherError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { createStructuredAgentMessage, getAgentMessages } from "./agent-control-message-routes.js";
import { createAgentRemediationRequest, recoverAgentRuntime } from "./agent-control-remediation-routes.js";
import { registerWorkerBridgeRoutes } from "./worker-bridge-routes.js";
import { attachRuntimeDispatchContext, buildRuntimeDispatchContext } from "../services/runtime-dispatch-context.js";
import { assertRuntimePrepareSupported } from "../services/runtime-prepare.js";

export function registerAgentControlRoutes(app: Express, launcherClient: LauncherClient) {
  app.get("/api/agents/:id", async (req: Request, res: Response) => {
    try {
      const result = await launcherClient.getAgent(requireRouteParam(req, "id"));
      return res.status(200).json(result);
    } catch (error) {
      return handleLauncherError(res, error);
    }
  });

  app.post("/api/agents/:id/start", async (req: Request, res: Response) => {
    try {
      const agentId = requireRouteParam(req, "id");
      const prepared = await assertRuntimePrepareSupported(requireAccessToken(req), requireVerifiedUser(req), agentId);

      if (prepared.localRuntime) {
        return res.status(200).json({
          status: "ready",
          agentId: prepared.agentId,
          agentType: prepared.agentType,
          workspaceId: prepared.workspaceId,
          localRuntime: true,
        });
      }

      const dispatchContext = await buildRuntimeDispatchContext({
        accessToken: requireAccessToken(req),
        requesterUserId: requireVerifiedUser(req),
        agentId,
        requestBody: req.body ?? {},
      });
      const result = await launcherClient.startAgent(
        agentId,
        attachRuntimeDispatchContext(req.body ?? {}, dispatchContext),
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
        return handleApiRouteError(res, error, {
          status: 502,
          code: "runtime_prepare_failed",
          message: "Runtime preparation failed",
        });
      }
      return handleLauncherError(res, error);
    }
  });

  app.post("/api/agents/:id/runtime/recover", async (req: Request, res: Response) => {
    return await recoverAgentRuntime(req, res, launcherClient);
  });

  app.post("/api/agents/:id/messages", async (req: Request, res: Response) => {
    return await createStructuredAgentMessage(req, res);
  });

  app.get("/api/agents/:id/messages", async (req: Request, res: Response) => {
    return await getAgentMessages(req, res);
  });

  app.post("/api/agents/:id/remediations", async (req: Request, res: Response) => {
    return await createAgentRemediationRequest(req, res, launcherClient);
  });

  registerWorkerBridgeRoutes(app, launcherClient);
}
