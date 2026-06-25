import { z } from "zod";

export const AgentLiveIoMetadataSchema = z
  .record(z.string(), z.unknown())
  .default({});

export const AgentLiveInputRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().trim().min(1),
  sessionKey: z.string().trim().min(1).nullable().optional(),
  metadata: AgentLiveIoMetadataSchema.optional(),
});

export const AgentLiveInputResponseSchema = z
  .object({
    accepted: z.boolean(),
    agentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionKey: z.string().min(1).nullable().optional(),
    turnId: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export const AgentLiveInterruptRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  sessionKey: z.string().trim().min(1).nullable().optional(),
  reason: z.string().trim().min(1).nullable().optional(),
  metadata: AgentLiveIoMetadataSchema.optional(),
});

export const AgentLiveInterruptResponseSchema = z
  .object({
    interrupted: z.boolean(),
    agentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionKey: z.string().min(1).nullable().optional(),
    turnId: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export const AgentLiveStreamQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  sessionKey: z.string().trim().min(1).nullable().optional(),
});

export const AgentLiveStreamEventTypeSchema = z.enum([
  "text_delta",
  "tool_activity",
  "usage",
  "turn_started",
  "turn_completed",
  "turn_interrupted",
  "error",
]);

export const AgentLiveStreamEventSchema = z
  .object({
    type: AgentLiveStreamEventTypeSchema,
    agentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionKey: z.string().min(1).nullable().optional(),
    turnId: z.string().min(1).nullable().optional(),
    sequence: z.number().int().nonnegative().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

export type AgentLiveInputRequest = z.infer<typeof AgentLiveInputRequestSchema>;
export type AgentLiveInputResponse = z.infer<
  typeof AgentLiveInputResponseSchema
>;
export type AgentLiveInterruptRequest = z.infer<
  typeof AgentLiveInterruptRequestSchema
>;
export type AgentLiveInterruptResponse = z.infer<
  typeof AgentLiveInterruptResponseSchema
>;
export type AgentLiveStreamQuery = z.infer<typeof AgentLiveStreamQuerySchema>;
export type AgentLiveStreamEvent = z.infer<typeof AgentLiveStreamEventSchema>;
