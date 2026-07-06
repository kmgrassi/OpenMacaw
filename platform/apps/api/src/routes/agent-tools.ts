import type { Express } from "express";

import { AgentPolicySettingsResponseSchema } from "../../../../contracts/policy.js";
import {
  AgentToolSettingsResponseSchema,
  AppendToolExamplesRequestSchema,
  ApplyToolPolicyTemplateRequestSchema,
  CreateToolDefinitionRequestSchema,
  ReorderAgentToolsRequestSchema,
  ToolDefinitionListResponseSchema,
  ToolDefinitionResponseSchema,
  UpdateToolDefinitionRequestSchema,
  UpsertAgentToolGrantRequestSchema,
} from "../../../../contracts/tool-definition.js";
import { apiRoute, handleApiRouteError, requestWorkspaceId, requireRouteParam, requireWorkspaceId } from "../http.js";
import { findSetupAgentById } from "../repositories/agents.js";
import {
  appendToolExamples,
  applyToolPolicyTemplateToAgent,
  createTool,
  deleteAgentToolGrant,
  deleteTool,
  getAgentToolSettings,
  listTools,
  setAgentToolGrant,
  updateTool,
} from "../services/agent-tools.js";
import { getAgentPolicySettings } from "../services/policy-resolver.js";
import { getUserScopedSupabase } from "../supabase-client.js";

function handleToolError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "tool_definition_failed",
    message: "Tool definition request failed",
  });
}

export function registerAgentToolRoutes(app: Express) {
  app.get(
    "/api/agents/:agentId/policies",
    apiRoute({
      requireAuth: true,
      onError: handleToolError,
      async handler({ req, res, accessToken }) {
        const agentId = requireRouteParam(req, "agentId");
        const workspaceId = requireWorkspaceId(req);
        const agent = await findSetupAgentById(accessToken, agentId);
        if (!agent || agent.workspace_id !== workspaceId) {
          return res.status(404).json({
            code: "agent_not_found",
            message: "Agent was not found",
          });
        }

        const sessionThreadId =
          typeof req.query.sessionThreadId === "string" && req.query.sessionThreadId.trim() !== ""
            ? req.query.sessionThreadId.trim()
            : null;
        const result = await getAgentPolicySettings({
          agentId,
          workspaceId,
          sessionThreadId,
          supabase: getUserScopedSupabase(accessToken),
        });
        return res.status(200).json(AgentPolicySettingsResponseSchema.parse(result));
      },
    }),
  );

  app.get(
    "/api/agents/:agentId/tools",
    apiRoute({
      requireAuth: true,
      onError: handleToolError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const result = await getAgentToolSettings({
          accessToken,
          userId,
          agentId,
          workspaceId: requestWorkspaceId(req),
        });
        return res.status(200).json(AgentToolSettingsResponseSchema.parse(result));
      },
    }),
  );

  app.post(
    "/api/agents/:agentId/tool-templates/:templateId/apply",
    apiRoute({
      requireAuth: true,
      bodySchema: ApplyToolPolicyTemplateRequestSchema,
      invalidBodyMessage: "workspaceId is required",
      onError: handleToolError,
      async handler({ req, res, body, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const templateId = requireRouteParam(req, "templateId");
        const result = await applyToolPolicyTemplateToAgent({
          accessToken,
          userId,
          agentId,
          templateId,
          workspaceId: body.workspaceId,
        });
        return res.status(200).json(AgentToolSettingsResponseSchema.parse(result));
      },
    }),
  );

  app.put(
    "/api/agents/:agentId/tool-grants/:toolId",
    apiRoute({
      requireAuth: true,
      bodySchema: UpsertAgentToolGrantRequestSchema,
      invalidBodyMessage: "tool grant is invalid",
      onError: handleToolError,
      async handler({ req, res, body, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const toolId = requireRouteParam(req, "toolId");
        const result = await setAgentToolGrant({
          accessToken,
          userId,
          agentId,
          toolId,
          mode: body.mode,
          reason: body.reason ?? null,
          workspaceId: body.workspaceId,
        });
        return res.status(200).json(AgentToolSettingsResponseSchema.parse(result));
      },
    }),
  );

  app.delete(
    "/api/agents/:agentId/tool-grants/:toolId",
    apiRoute({
      requireAuth: true,
      onError: handleToolError,
      async handler({ req, res, accessToken, userId }) {
        const agentId = requireRouteParam(req, "agentId");
        const toolId = requireRouteParam(req, "toolId");
        const result = await deleteAgentToolGrant({
          accessToken,
          userId,
          agentId,
          toolId,
          workspaceId: requestWorkspaceId(req),
        });
        return res.status(200).json(AgentToolSettingsResponseSchema.parse(result));
      },
    }),
  );

  app.put(
    "/api/agents/:agentId/tools/order",
    apiRoute({
      requireAuth: true,
      bodySchema: ReorderAgentToolsRequestSchema,
      invalidBodyMessage: "toolIds is required",
      onError: handleToolError,
      async handler({ res, body }) {
        return res.status(200).json({ toolIds: body.toolIds });
      },
    }),
  );

  app.get(
    "/api/tools",
    apiRoute({
      requireAuth: true,
      onError: handleToolError,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        const tools = await listTools({ userId, workspaceId });
        return res.status(200).json(ToolDefinitionListResponseSchema.parse({ tools }));
      },
    }),
  );

  app.post(
    "/api/tools",
    apiRoute({
      requireAuth: true,
      bodySchema: CreateToolDefinitionRequestSchema,
      invalidBodyMessage: "Tool definition is invalid",
      onError: handleToolError,
      async handler({ res, body, userId }) {
        const tool = await createTool({ userId, request: body });
        return res.status(201).json(ToolDefinitionResponseSchema.parse({ tool }));
      },
    }),
  );

  app.put(
    "/api/tools/:toolId",
    apiRoute({
      requireAuth: true,
      bodySchema: UpdateToolDefinitionRequestSchema,
      invalidBodyMessage: "Tool definition update is invalid",
      onError: handleToolError,
      async handler({ req, res, body, userId }) {
        const toolId = requireRouteParam(req, "toolId");
        const tool = await updateTool({ userId, toolId, request: body });
        return res.status(200).json(ToolDefinitionResponseSchema.parse({ tool }));
      },
    }),
  );

  app.post(
    "/api/tools/:toolId/examples",
    apiRoute({
      requireAuth: true,
      bodySchema: AppendToolExamplesRequestSchema,
      invalidBodyMessage: "Tool examples request is invalid",
      onError: handleToolError,
      async handler({ req, res, body, userId }) {
        const toolId = requireRouteParam(req, "toolId");
        const tool = await appendToolExamples({ userId, toolId, request: body });
        return res.status(200).json(ToolDefinitionResponseSchema.parse({ tool }));
      },
    }),
  );

  app.post(
    "/api/tools/slug/:slug/examples",
    apiRoute({
      requireAuth: true,
      bodySchema: AppendToolExamplesRequestSchema,
      invalidBodyMessage: "Tool examples request is invalid",
      onError: handleToolError,
      async handler({ req, res, body, userId }) {
        const slug = requireRouteParam(req, "slug");
        const tool = await appendToolExamples({ userId, slug, request: body });
        return res.status(200).json(ToolDefinitionResponseSchema.parse({ tool }));
      },
    }),
  );

  app.delete(
    "/api/tools/:toolId",
    apiRoute({
      requireAuth: true,
      onError: handleToolError,
      async handler({ req, res, userId }) {
        const workspaceId = requireWorkspaceId(req);
        await deleteTool({ userId, workspaceId, toolId: requireRouteParam(req, "toolId") });
        return res.status(204).send();
      },
    }),
  );
}
