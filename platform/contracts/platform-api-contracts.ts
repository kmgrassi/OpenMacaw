import { z } from "zod";

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
} from "./tool-definition.js";
import {
  AgentLiveInputRequestSchema,
  AgentLiveInputResponseSchema,
  AgentLiveInterruptRequestSchema,
  AgentLiveInterruptResponseSchema,
  AgentLiveStreamQuerySchema,
  AgentLiveStreamEventSchema,
} from "./agent-live-io.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid(),
});

const EmptyResponseSchema = z.object({}).passthrough();

export const PlatformApiContracts = {
  listAgentTools: {
    method: "GET",
    path: "/api/agents/:agentId/tools",
    pathParams: z.object({ agentId: z.string().uuid() }),
    query: WorkspaceQuerySchema,
    response: AgentToolSettingsResponseSchema,
  },
  applyAgentToolTemplate: {
    method: "POST",
    path: "/api/agents/:agentId/tool-templates/:templateId/apply",
    pathParams: z.object({
      agentId: z.string().uuid(),
      templateId: z.string().uuid(),
    }),
    body: ApplyToolPolicyTemplateRequestSchema,
    response: AgentToolSettingsResponseSchema,
  },
  upsertAgentToolGrant: {
    method: "PUT",
    path: "/api/agents/:agentId/tool-grants/:toolId",
    pathParams: z.object({
      agentId: z.string().uuid(),
      toolId: z.string().uuid(),
    }),
    body: UpsertAgentToolGrantRequestSchema,
    response: AgentToolSettingsResponseSchema,
  },
  deleteAgentToolGrant: {
    method: "DELETE",
    path: "/api/agents/:agentId/tool-grants/:toolId",
    pathParams: z.object({
      agentId: z.string().uuid(),
      toolId: z.string().uuid(),
    }),
    query: WorkspaceQuerySchema,
    response: AgentToolSettingsResponseSchema,
  },
  reorderAgentTools: {
    method: "PUT",
    path: "/api/agents/:agentId/tools/order",
    pathParams: z.object({ agentId: z.string().uuid() }),
    body: ReorderAgentToolsRequestSchema,
    response: z.object({ toolIds: z.array(z.string().uuid()) }),
  },
  sendAgentLiveInput: {
    method: "POST",
    path: "/api/agents/:agentId/input",
    pathParams: z.object({ agentId: z.string().uuid() }),
    body: AgentLiveInputRequestSchema,
    response: AgentLiveInputResponseSchema,
  },
  interruptAgentLiveSession: {
    method: "POST",
    path: "/api/agents/:agentId/interrupt",
    pathParams: z.object({ agentId: z.string().uuid() }),
    body: AgentLiveInterruptRequestSchema,
    response: AgentLiveInterruptResponseSchema,
  },
  streamAgentLiveEvents: {
    method: "GET",
    path: "/api/agents/:agentId/stream",
    pathParams: z.object({ agentId: z.string().uuid() }),
    query: AgentLiveStreamQuerySchema,
    response: AgentLiveStreamEventSchema,
  },
  listTools: {
    method: "GET",
    path: "/api/tools",
    query: WorkspaceQuerySchema,
    response: ToolDefinitionListResponseSchema,
  },
  createToolDefinition: {
    method: "POST",
    path: "/api/tools",
    body: CreateToolDefinitionRequestSchema,
    response: ToolDefinitionResponseSchema,
  },
  updateToolDefinition: {
    method: "PUT",
    path: "/api/tools/:toolId",
    pathParams: z.object({ toolId: z.string().uuid() }),
    body: UpdateToolDefinitionRequestSchema,
    response: ToolDefinitionResponseSchema,
  },
  appendToolExamples: {
    method: "POST",
    path: "/api/tools/:toolId/examples",
    pathParams: z.object({ toolId: z.string().uuid() }),
    body: AppendToolExamplesRequestSchema,
    response: ToolDefinitionResponseSchema,
  },
  appendToolExamplesBySlug: {
    method: "POST",
    path: "/api/tools/slug/:slug/examples",
    pathParams: z.object({ slug: z.string().trim().min(1).max(128) }),
    body: AppendToolExamplesRequestSchema,
    response: ToolDefinitionResponseSchema,
  },
  deleteToolDefinition: {
    method: "DELETE",
    path: "/api/tools/:toolId",
    pathParams: z.object({ toolId: z.string().uuid() }),
    query: WorkspaceQuerySchema,
    response: EmptyResponseSchema,
  },
} as const;

export type PlatformApiContracts = typeof PlatformApiContracts;
