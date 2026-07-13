import type { Express, Request } from "express";

import {
  AgentDashboardEventsResponseSchema,
  AgentDashboardResponseSchema,
  AgentDashboardRunsResponseSchema,
  AgentDashboardVersionResponseSchema,
  AgentToolCallEventCreateRequestSchema,
  AgentToolCallEventCreateResponseSchema,
  BrokerRunHistoryResponseSchema,
  BrokerTaskListRequestSchema,
  BrokerTaskListResponseSchema,
  GatewayConfigStateResponseSchema,
  LatestBrokerRunResponseSchema,
  RUN_HISTORY_PAGE_SIZE,
} from "../../../../contracts/agent-dashboard.js";
import { AgentDashboardRouteTemplates } from "../../../../contracts/routes.js";
import {
  apiRoute,
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  requestWorkspaceId,
  requireRouteParam,
} from "../http.js";
import {
  createAgentToolCallEvent,
  getAgentDashboardVersion,
  getBrokerRunHistory,
  getBrokerTasks,
  getGatewayConfigState,
  getLatestBrokerRun,
} from "../services/agent-dashboard.js";

function requestPage(req: Request) {
  const raw = typeof req.query.page === "string" ? Number(req.query.page) : undefined;
  return Number.isFinite(raw ?? NaN) ? Math.max(0, Math.trunc(raw ?? 0)) : 0;
}

function handleDashboardError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  if (error instanceof ApiRouteError) {
    return handleApiRouteError(res, error, {
      status: 500,
      code: "agent_dashboard_failed",
      message: "Could not load agent dashboard",
    });
  }

  return res.status(502).json(errorPayload("agent_dashboard_failed", "Could not load agent dashboard", String(error)));
}

export function registerAgentDashboardRoutes(app: Express) {
  app.get(
    AgentDashboardRouteTemplates.item,
    apiRoute({
      requireAuth: true,
      onError: handleDashboardError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const latestRun = await getLatestBrokerRun({
          accessToken,
          userId,
          agentId,
        });
        const [tasks, configState] = await Promise.all([
          latestRun
            ? getBrokerTasks({
                accessToken,
                userId,
                agentId,
                runIds: [latestRun.runId],
              })
            : Promise.resolve([]),
          getGatewayConfigState({
            accessToken,
            userId,
            agentId,
            workspaceId: requestWorkspaceId(req),
          }),
        ]);

        return res.status(200).json(AgentDashboardResponseSchema.parse({ latestRun, tasks, configState }));
      },
    }),
  );

  app.get(
    AgentDashboardRouteTemplates.latestRun,
    apiRoute({
      requireAuth: true,
      onError: handleDashboardError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const run = await getLatestBrokerRun({
          accessToken,
          userId,
          agentId,
        });

        return res.status(200).json(LatestBrokerRunResponseSchema.parse({ run }));
      },
    }),
  );

  app.get(
    AgentDashboardRouteTemplates.runs,
    apiRoute({
      requireAuth: true,
      onError: handleDashboardError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const page = requestPage(req);
        const result = await getBrokerRunHistory({
          accessToken,
          userId,
          agentId,
          page,
        });

        if (req.query.shape === "page") {
          return res.status(200).json(
            AgentDashboardRunsResponseSchema.parse({
              ...result,
              page,
              pageSize: RUN_HISTORY_PAGE_SIZE,
            }),
          );
        }

        return res.status(200).json(BrokerRunHistoryResponseSchema.parse(result));
      },
    }),
  );

  app.post(
    AgentDashboardRouteTemplates.tasks,
    apiRoute({
      requireAuth: true,
      bodySchema: BrokerTaskListRequestSchema,
      invalidBodyMessage: "runIds are required",
      onError: handleDashboardError,
      async handler({ req, res, body, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const tasks = await getBrokerTasks({
          accessToken,
          userId,
          agentId,
          runIds: body.runIds,
        });

        return res.status(200).json(BrokerTaskListResponseSchema.parse({ tasks }));
      },
    }),
  );

  app.post(
    AgentDashboardRouteTemplates.toolEvents,
    apiRoute({
      requireAuth: true,
      bodySchema: AgentToolCallEventCreateRequestSchema,
      invalidBodyMessage: "tool event payload is invalid",
      onError: handleDashboardError,
      async handler({ req, res, body, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const event = await createAgentToolCallEvent({
          accessToken,
          userId,
          agentId,
          event: body,
        });

        return res.status(201).json(AgentToolCallEventCreateResponseSchema.parse({ event }));
      },
    }),
  );

  app.get(
    AgentDashboardRouteTemplates.gatewayConfigState,
    apiRoute({
      requireAuth: true,
      onError: handleDashboardError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const state = await getGatewayConfigState({
          accessToken,
          userId,
          agentId,
          workspaceId: requestWorkspaceId(req),
        });

        return res.status(200).json(GatewayConfigStateResponseSchema.parse({ state }));
      },
    }),
  );

  app.get(
    AgentDashboardRouteTemplates.events,
    apiRoute({
      requireAuth: true,
      async handler({ res }) {
        return res.status(200).json(AgentDashboardEventsResponseSchema.parse({ events: [] }));
      },
    }),
  );

  app.get(
    AgentDashboardRouteTemplates.version,
    apiRoute({
      requireAuth: true,
      onError: handleDashboardError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const version = await getAgentDashboardVersion({
          accessToken,
          userId,
          agentId,
          workspaceId: requestWorkspaceId(req),
        });

        return res.status(200).json(AgentDashboardVersionResponseSchema.parse(version));
      },
    }),
  );
}
