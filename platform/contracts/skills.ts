import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const SkillStatusSchema = z.enum(["draft", "approved", "archived"]);

export const SkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/)
  .refine((name) => name !== "claude" && name !== "anthropic", {
    message: "Skill name cannot be claude or anthropic",
  });

export const SkillSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: SkillNameSchema,
  description: z.string().max(1024),
  body: z.string().trim().min(1),
  status: SkillStatusSchema,
  copiedFromSkillId: z.string().uuid().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  sourceRunId: z.string().trim().min(1).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const SkillCreateToolRequestSchema = z
  .object({
    agentId: z.string().uuid(),
    name: SkillNameSchema,
    description: z.string().trim().min(1).max(1024),
    body: z.string().trim().min(1).max(65535),
  })
  .strict();

export const SkillCreateToolResponseSchema = z.object({
  skill: SkillSchema,
});

export type SkillStatus = z.infer<typeof SkillStatusSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillCreateToolRequest = z.infer<
  typeof SkillCreateToolRequestSchema
>;
export type SkillCreateToolResponse = z.infer<
  typeof SkillCreateToolResponseSchema
>;
