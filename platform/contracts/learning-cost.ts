import { z } from "zod";

export const LearningCostKindSchema = z.enum([
  "retrieval",
]);

export const LearningCostTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
});

export const LearningCostByKindEntrySchema = z.object({
  kind: LearningCostKindSchema,
  taskCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  totals: LearningCostTotalsSchema,
});

export const LearningCostDailyEntrySchema = z.object({
  date: z.string(),
  taskCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  totals: LearningCostTotalsSchema,
});

export const LearningCostResponseSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  startDate: z.string(),
  endDate: z.string(),
  totals: LearningCostTotalsSchema,
  aggregates: z.object({
    byKind: z.array(LearningCostByKindEntrySchema),
    daily: z.array(LearningCostDailyEntrySchema),
  }),
});

export type LearningCostKind = z.infer<typeof LearningCostKindSchema>;
export type LearningCostTotals = z.infer<typeof LearningCostTotalsSchema>;
export type LearningCostByKindEntry = z.infer<
  typeof LearningCostByKindEntrySchema
>;
export type LearningCostDailyEntry = z.infer<
  typeof LearningCostDailyEntrySchema
>;
export type LearningCostResponse = z.infer<typeof LearningCostResponseSchema>;
