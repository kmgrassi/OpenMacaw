import { z } from "zod";
import { TrackerKindSchema } from "./tracker-kinds.js";

/**
 * Per-workspace settings, stored in the `workspace_settings` table
 * (one row per workspace, PK on `workspace_id`).
 *
 * v1 fields:
 *   - learningEnabled: gates the learning sidecar's
 *     reflection / memory persistence for this workspace.
 *   - trackerKind / trackerCredentialId: controls the workspace-scoped
 *     work tracker adapter used by the runtime.
 *
 * ## Dark-launch, opt-in semantics
 *
 * The DB defines column defaults (e.g. `learning_enabled boolean
 * default false`). The platform service reads the row when present
 * and falls back to defaults defined here when the row is absent —
 * which is the common case for new workspaces (rows are created
 * lazily on first user write).
 *
 * Future flags join the schema as new fields. Each new field needs a
 * corresponding harper-server migration that adds the column with a
 * default value, plus an entry in `DEFAULT_WORKSPACE_SETTINGS` here
 * that matches the column default.
 */

export const WorkspaceSettingsSchema = z.object({
  workspaceId: z.string().uuid(),
  learningEnabled: z.boolean(),
  trackerKind: TrackerKindSchema,
  trackerCredentialId: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

/**
 * Opt-in baselines that match the DB column defaults. The service
 * uses this when no row exists for a workspace; we surface the same
 * defaults to the client so the UI shows the right "current" state
 * before any write has happened.
 */
export const DEFAULT_WORKSPACE_SETTINGS_VALUES = {
  learningEnabled: false,
  trackerKind: "database",
  trackerCredentialId: null,
} as const;

/**
 * PATCH body. Every field is optional. Missing fields keep their
 * stored value. The service deep-applies the patch over the current
 * settings before writing back.
 */
export const WorkspaceSettingsPatchSchema = z
  .object({
    learningEnabled: z.boolean().optional(),
    trackerKind: TrackerKindSchema.optional(),
    trackerCredentialId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "At least one settings field must be provided",
  });

export type WorkspaceSettingsPatch = z.infer<
  typeof WorkspaceSettingsPatchSchema
>;

export const WorkspaceSettingsResponseSchema = z.object({
  settings: WorkspaceSettingsSchema,
});

export type WorkspaceSettingsResponse = z.infer<
  typeof WorkspaceSettingsResponseSchema
>;
