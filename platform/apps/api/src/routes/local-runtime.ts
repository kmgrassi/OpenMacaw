import type { Express, Request } from "express";

import { AgentRouteTemplates, LocalRuntimeRouteTemplates } from "../../../../contracts/routes.js";
import {
  AgentLocalRuntimeAssignRequestSchema,
  LocalModelProbeRequestSchema,
  LocalRuntimeRegistrationRequestSchema,
} from "../../../../contracts/local-runtime.js";
import { ApiRouteError, apiRoute, handleApiRouteError, requestWorkspaceId, requireRouteParam } from "../http.js";
import { assignLocalModelToAgent, unassignLocalModelFromAgent } from "../services/local-runtime-helpers.js";
import {
  deleteLocalRuntimeForWorkspace,
  getLocalRuntimeConfigForWorkspace,
  listLocalRuntimeEventsForWorkspace,
  listLocalRuntimesForWorkspace,
  probeLocalModel,
  probeRegisteredLocalRuntimeForWorkspace,
  registerLocalRuntimeForWorkspace,
  rotateLocalRuntimeTokenForWorkspace,
  testLocalRuntimeDispatchForWorkspace,
  type LauncherRequest,
} from "../services/local-runtime-machines.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

function requireWorkspaceId(req: Request) {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
  }
  return workspaceId;
}

async function requireWorkspaceAccess(userId: string, workspaceId: string) {
  const supabase = getServiceRoleSupabase();
  const { data: memberRows, error: memberError } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .limit(1);
  if (memberError) {
    throw memberError;
  }

  if ((memberRows ?? []).length > 0) return;

  const { data: ownedRows, error: ownedError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_user_id", userId)
    .limit(1);
  if (ownedError) {
    throw ownedError;
  }

  if ((ownedRows ?? []).length === 0) {
    throw new ApiRouteError(
      403,
      "workspace_forbidden",
      "Authenticated user is not authorized for the requested workspace",
    );
  }
}

function assertDevOnlyLocalProbe(_req: Request) {
  // Arbitrary endpoint probing only makes sense when the API server and the
  // model host share the same machine during local development. In production,
  // probing a user-supplied loopback URL turns into server-side localhost
  // access against whatever else is bound on the API host.
  assertDevRouteAccess(_req);
}

export function registerLocalRuntimeRoutes(app: Express, launcherRequest: LauncherRequest) {
  app.post(
    AgentRouteTemplates.assignLocalModel,
    apiRoute({
      requireAuth: true,
      bodySchema: AgentLocalRuntimeAssignRequestSchema,
      invalidBodyMessage: "Agent local model assignment request is invalid",
      async handler({ req, res, body, accessToken, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const agentId = requireRouteParam(req, "agentId");
        if (body.agentId && body.agentId !== agentId) {
          throw new ApiRouteError(400, "invalid_request", "Body agentId must match route agentId");
        }

        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        const response = await assignLocalModelToAgent({
          workspaceId,
          machineId: body.machineId,
          localRuntimeId: body.localRuntimeId,
          agentId,
          auth: { accessToken, userId },
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_assign_failed",
          message: "Could not assign local model to agent",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      bodySchema: LocalRuntimeRegistrationRequestSchema,
      invalidBodyMessage: "Local runtime registration request is invalid",
      async handler({ req, res, body, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        const response = await registerLocalRuntimeForWorkspace({
          workspaceId,
          userId,
          request: body,
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_create_failed",
          message: "Could not register local runtime",
        }),
    }),
  );

  app.get(
    LocalRuntimeRouteTemplates.collection,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await listLocalRuntimesForWorkspace(workspaceId));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_list_failed",
          message: "Could not list local runtimes",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.probe,
    apiRoute({
      requireAuth: true,
      bodySchema: LocalModelProbeRequestSchema,
      invalidBodyMessage: "Local runtime probe request is invalid",
      async handler({ req, res, body, userId }) {
        assertDevOnlyLocalProbe(req);
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res.status(200).json(await probeLocalModel(body));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_probe_failed",
          message: "Could not probe local runtime",
        }),
    }),
  );

  app.get(
    LocalRuntimeRouteTemplates.config,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(200)
          .json(await getLocalRuntimeConfigForWorkspace(workspaceId, requireRouteParam(req, "machineId")));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_config_failed",
          message: "Could not regenerate local runtime config",
        }),
    }),
  );

  app.get(
    LocalRuntimeRouteTemplates.events,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 50;
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(200)
          .json(
            await listLocalRuntimeEventsForWorkspace(
              workspaceId,
              requireRouteParam(req, "machineId"),
              Number.isFinite(rawLimit) ? rawLimit : 50,
            ),
          );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_events_failed",
          message: "Could not list local runtime events",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.testDispatch,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(200)
          .json(
            await testLocalRuntimeDispatchForWorkspace(
              workspaceId,
              requireRouteParam(req, "machineId"),
              launcherRequest,
            ),
          );
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_test_dispatch_failed",
          message: "Could not test local runtime dispatch",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.rotateToken,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(201)
          .json(await rotateLocalRuntimeTokenForWorkspace(workspaceId, requireRouteParam(req, "machineId")));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_token_rotate_failed",
          message: "Could not rotate local runtime helper token",
        }),
    }),
  );

  // Probe targets a specific runner (routing rule), not the machine, because
  // only the openai_compatible runner exposes an OpenAI-compatible /models list.
  app.post(
    LocalRuntimeRouteTemplates.runnerProbe,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        return res
          .status(200)
          .json(await probeRegisteredLocalRuntimeForWorkspace(workspaceId, requireRouteParam(req, "runnerId")));
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_probe_failed",
          message: "Could not probe local runtime",
        }),
    }),
  );

  app.delete(
    LocalRuntimeRouteTemplates.item,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        await deleteLocalRuntimeForWorkspace(workspaceId, requireRouteParam(req, "machineId"));
        return res.status(204).end();
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_delete_failed",
          message: "Could not delete local runtime",
        }),
    }),
  );

  app.post(
    LocalRuntimeRouteTemplates.assignRunner,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, accessToken, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
        if (!agentId) {
          throw new ApiRouteError(400, "invalid_request", "agentId is required");
        }

        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        const response = await assignLocalModelToAgent({
          workspaceId,
          localRuntimeId: requireRouteParam(req, "runnerId"),
          agentId,
          auth: { accessToken, userId },
        });
        return res.status(201).json(response);
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_assign_failed",
          message: "Could not assign local runtime to agent",
        }),
    }),
  );

  app.delete(
    LocalRuntimeRouteTemplates.unassignRunner,
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        if (!userId) {
          throw new ApiRouteError(401, "unauthorized", "User ID is required");
        }

        const workspaceId = requireWorkspaceId(req);
        await requireWorkspaceAccess(userId, workspaceId);
        await unassignLocalModelFromAgent({
          workspaceId,
          ruleId: requireRouteParam(req, "runnerId"),
          agentId: requireRouteParam(req, "agentId"),
          userId,
        });
        return res.status(204).end();
      },
      onError: (res, error) =>
        handleApiRouteError(res, error, {
          status: 502,
          code: "local_runtime_unassign_failed",
          message: "Could not remove local runtime assignment",
        }),
    }),
  );
}
