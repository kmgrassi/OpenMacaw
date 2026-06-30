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

const AgentLiveStreamEventBaseSchema = z
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

export const AgentLiveToolActivityPayloadSchema = z
  .object({
    vendor: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    inputSummary: z.string().optional(),
    phase: z.enum(["request", "result"]),
    decision: z.string().trim().min(1).nullable().optional(),
    toolCallId: z.string().trim().min(1).optional(),
    success: z.boolean().optional(),
    outputSummary: z.string().optional(),
    rawEvent: z.string().trim().min(1).optional(),
  })
  .passthrough();

export const AgentLiveToolActivityEventSchema =
  AgentLiveStreamEventBaseSchema.extend({
    type: z.literal("tool_activity"),
    payload: AgentLiveToolActivityPayloadSchema,
  });

export const AgentLiveStreamEventSchema = z.union([
  AgentLiveToolActivityEventSchema,
  AgentLiveStreamEventBaseSchema.refine(
    (event) => event.type !== "tool_activity",
    {
      message:
        "tool_activity events must use the normalized tool activity payload",
    },
  ),
]);

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
export type AgentLiveToolActivityPayload = z.infer<
  typeof AgentLiveToolActivityPayloadSchema
>;
