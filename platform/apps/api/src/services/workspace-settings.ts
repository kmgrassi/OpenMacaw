import {
  DEFAULT_WORKSPACE_SETTINGS_VALUES,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from "../../../../contracts/workspace-settings.js";
import {
  TrackerKindSchema,
  trackerCredentialProvider,
  trackerKindRequiresCredential,
} from "../../../../contracts/tracker-kinds.js";
import { ApiRouteError } from "../http.js";
import { getCredentialRowByIdForWorkspace } from "../repositories/credentials.js";
import {
  getWorkspaceSettingsRow,
  upsertWorkspaceSettingsRow,
  type WorkspaceSettingsRow,
} from "../repositories/workspace-settings.js";

/**
 * Read the effective settings for a workspace. When no row exists in
 * `workspace_settings`, returns the defaults from the contract
 * (matching the DB column defaults). Learning is dark-launched: new
 * workspaces are treated as disabled until an explicit settings row
 * enables it.
 *
 * `updatedAt` and `updatedByUserId` are `null` when no row exists
 * (nothing has ever been written). Once a user toggles, both get
 * populated.
 */
export async function readWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
  const row = await getWorkspaceSettingsRow(workspaceId);
  return projectSettings(workspaceId, row);
}

/**
 * Apply a patch and persist the result. Read-modify-write:
 *   1. Read current settings (or defaults if no row).
 *   2. Overlay patch fields.
 *   3. Upsert the full merged row.
 *
 * The row is created on first patch and updated thereafter. Returns
 * the post-write effective settings.
 */
export async function patchWorkspaceSettings(input: {
  workspaceId: string;
  userId: string | null;
  patch: WorkspaceSettingsPatch;
}): Promise<WorkspaceSettings> {
  const current = await readWorkspaceSettings(input.workspaceId);
  const trackerKind = input.patch.trackerKind ?? current.trackerKind;
  const trackerCredentialId =
    input.patch.trackerCredentialId !== undefined ? input.patch.trackerCredentialId : current.trackerCredentialId;

  // Only validate tracker credential when the patch actually touches a
  // tracker field. Otherwise a PATCH that only flips `learningEnabled`
  // would fail when the previously selected credential has since been
  // deleted, blocking unrelated settings updates. Explicit null counts
  // as a real change (e.g. clearing the credential), so we check key
  // presence rather than value truthiness.
  const touchesTracker = "trackerKind" in input.patch || "trackerCredentialId" in input.patch;
  if (touchesTracker) {
    await validateTrackerCredential({
      workspaceId: input.workspaceId,
      trackerKind,
      trackerCredentialId,
    });
  }

  const merged = {
    learningEnabled: input.patch.learningEnabled ?? current.learningEnabled,
    trackerKind,
    trackerCredentialId,
  };

  const row = await upsertWorkspaceSettingsRow({
    workspaceId: input.workspaceId,
    learningEnabled: merged.learningEnabled,
    trackerKind: merged.trackerKind,
    trackerCredentialId: merged.trackerCredentialId,
    updatedByUserId: input.userId ?? null,
  });

  return projectSettings(input.workspaceId, row);
}

function projectSettings(workspaceId: string, row: WorkspaceSettingsRow | null): WorkspaceSettings {
  if (!row) {
    return {
      workspaceId,
      learningEnabled: DEFAULT_WORKSPACE_SETTINGS_VALUES.learningEnabled,
      trackerKind: DEFAULT_WORKSPACE_SETTINGS_VALUES.trackerKind,
      trackerCredentialId: DEFAULT_WORKSPACE_SETTINGS_VALUES.trackerCredentialId,
      updatedAt: null,
      updatedByUserId: null,
    };
  }

  const trackerKind = TrackerKindSchema.catch(DEFAULT_WORKSPACE_SETTINGS_VALUES.trackerKind).parse(row.tracker_kind);

  return {
    workspaceId: row.workspace_id,
    learningEnabled: row.learning_enabled,
    trackerKind,
    trackerCredentialId: row.tracker_credential_id,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  };
}

async function validateTrackerCredential(input: {
  workspaceId: string;
  trackerKind: WorkspaceSettings["trackerKind"];
  trackerCredentialId: string | null;
}) {
  if (!trackerKindRequiresCredential(input.trackerKind)) {
    return;
  }

  if (!input.trackerCredentialId) {
    throw new ApiRouteError(
      400,
      "missing_credential_for_kind",
      `${input.trackerKind} tracker settings require a workspace credential`,
    );
  }

  const credential = await getCredentialRowByIdForWorkspace(input.trackerCredentialId, input.workspaceId);
  if (!credential) {
    throw new ApiRouteError(400, "invalid_credential", "Tracker credential must belong to the requested workspace");
  }

  const expectedProvider = trackerCredentialProvider(input.trackerKind);
  if (expectedProvider && credential.provider !== expectedProvider) {
    throw new ApiRouteError(400, "invalid_credential", `Tracker credential must use provider ${expectedProvider}`);
  }
}
