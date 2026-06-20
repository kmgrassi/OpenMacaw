import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const SKILL_STATUSES = ["draft", "approved", "archived"] as const;

export const SkillStatusSchema = z.enum(SKILL_STATUSES);

export const SkillSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().min(1).max(1024),
  body: z.string().min(1),
  status: SkillStatusSchema,
  copiedFromSkillId: z.string().uuid().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  sourceRunId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const SkillListQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  status: SkillStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const SkillListResponseSchema = z.object({
  skills: z.array(SkillSchema),
});

export const SkillUpdateRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    description: z.string().trim().min(1).max(1024).optional(),
    body: z.string().trim().min(1).optional(),
    status: SkillStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one skill field is required",
  });

export const SkillResponseSchema = z.object({
  skill: SkillSchema,
});

export type SkillStatus = z.infer<typeof SkillStatusSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillListQuery = z.infer<typeof SkillListQuerySchema>;
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;
export type SkillUpdateRequest = z.infer<typeof SkillUpdateRequestSchema>;
export type SkillResponse = z.infer<typeof SkillResponseSchema>;
