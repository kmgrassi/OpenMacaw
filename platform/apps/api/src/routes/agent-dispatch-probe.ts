// DEV ONLY - Dispatch probes are intended for local manual testing and
// reviewable smoke evidence, not production traffic.
import type { Express } from "express";

import { AgentDispatchProbeRequestSchema } from "../../../../contracts/agent-dispatch-probe.js";
import { apiRoute, handleApiRouteError, requireRouteParam } from "../http.js";
import type { LauncherClient } from "../services/launcher.js";
import { buildAgentDispatchDryRun, runAgentDispatchLive } from "../services/agent-dispatch-probe.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

export function registerAgentDispatchProbeRoutes(app: Express, launcherClient: LauncherClient) {
  app.post(
    "/api/dev/agents/:agentId/dispatch/dry-run",
    apiRoute({
      requireAuth: true,
      bodySchema: AgentDispatchProbeRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      async handler({ req, res, body, accessToken, userId }) {
        assertDevRouteAccess(req, { localhostOnly: true });
        const result = await buildAgentDispatchDryRun({
          accessToken,
          requesterUserId: userId,
          agentId: requireRouteParam(req, "agentId"),
          workspaceId: body.workspaceId,
        });

        return res.status(200).json(result);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "dispatch_dry_run_failed",
          message: "Could not build runtime dispatch dry-run",
        }),
    }),
  );

  app.post(
    "/api/dev/agents/:agentId/dispatch/live",
    apiRoute({
      requireAuth: true,
      bodySchema: AgentDispatchProbeRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      async handler({ req, res, body, accessToken, userId }) {
        assertDevRouteAccess(req, { localhostOnly: true });
        const result = await runAgentDispatchLive({
          accessToken,
          requesterUserId: userId,
          agentId: requireRouteParam(req, "agentId"),
          workspaceId: body.workspaceId,
          launcherClient,
        });

        return res.status(result.status === "matched" ? 200 : 409).json(result);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "dispatch_live_run_failed",
          message: "Could not complete runtime dispatch live-run",
        }),
    }),
  );
}
