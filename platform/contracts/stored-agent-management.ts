import { z } from "zod";

import {
  AgentTypeSchema,
  PlanningDestinationSchema,
  StoredAgentSchema,
} from "./agents.js";

export const CustomAgentTargetSchema = z.object({
  backendType: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
});

export const LocalModelCodingConfigSchema = z.object({
  enabled: z.boolean(),
  approvalPolicy: z.enum(["on_request", "never"]),
  workspaceWrite: z.boolean(),
  localModelId: z.string().trim().min(1).nullable().optional(),
});

export const StoredAgentCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  type: AgentTypeSchema,
  model: z.string().trim().min(1).nullable().optional(),
  context: z.string().trim().max(20000).nullable().optional(),
  planningDestination: PlanningDestinationSchema.optional(),
  localModelCoding: LocalModelCodingConfigSchema.optional(),
  customTarget: CustomAgentTargetSchema.optional(),
});

export const StoredAgentUpdateRequestSchema =
  StoredAgentCreateRequestSchema.omit({
    workspaceId: true,
  });

export const StoredAgentMutationResponseSchema = z.object({
  agent: StoredAgentSchema,
});

export const StoredAgentGatewayConfigSchema = z.object({
  backend: z
    .object({
      type: z.string().nullable(),
      baseUrl: z.string().nullable(),
      agentId: z.string().nullable(),
    })
    .nullable(),
});

export const StoredAgentGatewayConfigResponseSchema = z.object({
  config: StoredAgentGatewayConfigSchema,
});

export const StoredAgentGatewayConfigUpdateRequestSchema =
  StoredAgentGatewayConfigSchema;

export type StoredAgentCreateRequest = z.infer<
  typeof StoredAgentCreateRequestSchema
>;
export type StoredAgentUpdateRequest = z.infer<
  typeof StoredAgentUpdateRequestSchema
>;
export type StoredAgentMutationResponse = z.infer<
  typeof StoredAgentMutationResponseSchema
>;
export type StoredAgentGatewayConfig = z.infer<
  typeof StoredAgentGatewayConfigSchema
>;
export type StoredAgentGatewayConfigResponse = z.infer<
  typeof StoredAgentGatewayConfigResponseSchema
>;
export type StoredAgentGatewayConfigUpdateRequest = z.infer<
  typeof StoredAgentGatewayConfigUpdateRequestSchema
>;
export type LocalModelCodingConfig = z.infer<
  typeof LocalModelCodingConfigSchema
>;
