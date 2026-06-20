import { beforeEach, describe, expect, it, vi } from "vitest";

import { patchWorkspaceSettings, readWorkspaceSettings } from "./workspace-settings.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";

const { ensureLearningMetaAgentScheduleForWorkspace, setLearningMetaAgentScheduledTaskEnabled } = vi.hoisted(() => ({
  ensureLearningMetaAgentScheduleForWorkspace: vi.fn(),
  setLearningMetaAgentScheduledTaskEnabled: vi.fn(),
}));

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

vi.mock("./setup/store/learning-agent.js", () => ({
  ensureLearningMetaAgentScheduleForWorkspace,
  setLearningMetaAgentScheduledTaskEnabled,
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";

type WorkspaceSettingsRow = {
  workspace_id: string;
  learning_enabled: boolean;
  tracker_kind?: string | null;
  tracker_credential_id?: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
};

function setupMockDatabase(initial: WorkspaceSettingsRow[] = [], credentials: Array<Record<string, unknown>> = []) {
  const db = {
    workspace_settings: [...initial] as Array<Record<string, unknown>>,
    credential: [...credentials] as Array<Record<string, unknown>>,
  };

  const client = createMockSupabaseClient(db);
  vi.mocked(getServiceRoleSupabase).mockReturnValue(client as never);

  return db;
}

describe("readWorkspaceSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureLearningMetaAgentScheduleForWorkspace.mockResolvedValue(undefined);
    setLearningMetaAgentScheduledTaskEnabled.mockResolvedValue(undefined);
  });

  it("returns defaults when no row exists (learning disabled by default)", async () => {
    setupMockDatabase();

    const settings = await readWorkspaceSettings(workspaceId);

    expect(settings).toEqual({
      workspaceId,
      learningEnabled: false,
      trackerKind: "database",
      trackerCredentialId: null,
      updatedAt: null,
      updatedByUserId: null,
    });
  });

  it("returns stored row when one exists", async () => {
    setupMockDatabase([
      {
        workspace_id: workspaceId,
        learning_enabled: false,
        tracker_kind: "linear",
        tracker_credential_id: "33333333-3333-4333-8333-333333333333",
        updated_at: "2026-05-18T14:00:00Z",
        updated_by_user_id: userId,
      },
    ]);

    const settings = await readWorkspaceSettings(workspaceId);

    expect(settings).toEqual({
      workspaceId,
      learningEnabled: false,
      trackerKind: "linear",
      trackerCredentialId: "33333333-3333-4333-8333-333333333333",
      updatedAt: "2026-05-18T14:00:00Z",
      updatedByUserId: userId,
    });
  });
});

describe("patchWorkspaceSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the row on first patch (no prior row) and persists the patched value", async () => {
    const db = setupMockDatabase();

    const result = await patchWorkspaceSettings({
      workspaceId,
      userId,
      patch: { learningEnabled: false },
    });

    expect(result.learningEnabled).toBe(false);
    expect(result.workspaceId).toBe(workspaceId);
    expect(result.updatedByUserId).toBe(userId);
    expect(db.workspace_settings).toHaveLength(1);
    expect(db.workspace_settings[0]).toMatchObject({
      workspace_id: workspaceId,
      learning_enabled: false,
      tracker_kind: "database",
      tracker_credential_id: null,
      updated_by_user_id: userId,
    });
  });

  it("preserves untouched fields when patching one field", async () => {
    const db = setupMockDatabase([
      {
        workspace_id: workspaceId,
        learning_enabled: true,
        tracker_kind: "database",
        tracker_credential_id: null,
        updated_at: "2026-05-18T13:00:00Z",
        updated_by_user_id: userId,
      },
    ]);

    // Empty patches are rejected by the contract schema, so this test
    // patches the same value back — demonstrates the upsert still
    // touches the row and bumps updated_by.
    const otherUserId = "99999999-9999-4999-8999-999999999999";

    await patchWorkspaceSettings({
      workspaceId,
      userId: otherUserId,
      patch: { learningEnabled: true },
    });

    expect(db.workspace_settings).toHaveLength(1);
    expect(db.workspace_settings[0]).toMatchObject({
      workspace_id: workspaceId,
      learning_enabled: true,
      tracker_kind: "database",
      updated_by_user_id: otherUserId,
    });
    expect(ensureLearningMetaAgentScheduleForWorkspace).toHaveBeenCalledWith({
      workspaceId,
      userId: otherUserId,
    });
    expect(setLearningMetaAgentScheduledTaskEnabled).not.toHaveBeenCalled();
  });

  it("toggles back from false to true", async () => {
    const db = setupMockDatabase([
      {
        workspace_id: workspaceId,
        learning_enabled: false,
        tracker_kind: "database",
        tracker_credential_id: null,
        updated_at: "2026-05-18T13:00:00Z",
        updated_by_user_id: userId,
      },
    ]);

    const result = await patchWorkspaceSettings({
      workspaceId,
      userId,
      patch: { learningEnabled: true },
    });

    expect(result.learningEnabled).toBe(true);
    expect(db.workspace_settings).toHaveLength(1);
    expect(db.workspace_settings[0]?.learning_enabled).toBe(true);
    expect(ensureLearningMetaAgentScheduleForWorkspace).toHaveBeenCalledWith({
      workspaceId,
      userId,
    });
    expect(setLearningMetaAgentScheduledTaskEnabled).not.toHaveBeenCalled();
  });

  it("updates tracker kind with a workspace-scoped matching credential", async () => {
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const db = setupMockDatabase(
      [
        {
          workspace_id: workspaceId,
          learning_enabled: true,
          tracker_kind: "database",
          tracker_credential_id: null,
          updated_at: "2026-05-18T13:00:00Z",
          updated_by_user_id: userId,
        },
      ],
      [
        {
          id: credentialId,
          workspace_id: workspaceId,
          user_id: userId,
          agent_id: null,
          format: "api_key",
          provider: "linear",
          display_name: "Linear",
          key_value: { provider: "linear", LINEAR_API_KEY: "lin-test" },
          updated_at: "2026-05-18T13:00:00Z",
          validation_state: "unknown",
          validated_at: null,
        },
      ],
    );

    const result = await patchWorkspaceSettings({
      workspaceId,
      userId,
      patch: { trackerKind: "linear", trackerCredentialId: credentialId },
    });

    expect(result).toMatchObject({
      trackerKind: "linear",
      trackerCredentialId: credentialId,
    });
    expect(db.workspace_settings[0]).toMatchObject({
      tracker_kind: "linear",
      tracker_credential_id: credentialId,
    });
  });

  it("rejects tracker kinds that require credentials when no credential is provided", async () => {
    setupMockDatabase();

    await expect(
      patchWorkspaceSettings({
        workspaceId,
        userId,
        patch: { trackerKind: "linear", trackerCredentialId: null },
      }),
    ).rejects.toMatchObject({
      code: "missing_credential_for_kind",
    });
  });

  it("allows patching learningEnabled when the stored tracker credential is stale", async () => {
    // The workspace previously selected a Linear credential that has
    // since been deleted from the workspace. Patching an unrelated
    // setting (learningEnabled) must NOT trigger tracker validation
    // and must succeed even though the stored tracker_credential_id
    // would now fail validation.
    const staleCredentialId = "55555555-5555-4555-8555-555555555555";
    const db = setupMockDatabase(
      [
        {
          workspace_id: workspaceId,
          learning_enabled: true,
          tracker_kind: "linear",
          tracker_credential_id: staleCredentialId,
          updated_at: "2026-05-18T13:00:00Z",
          updated_by_user_id: userId,
        },
      ],
      // No credential rows — the stored tracker_credential_id is stale.
      [],
    );

    const result = await patchWorkspaceSettings({
      workspaceId,
      userId,
      patch: { learningEnabled: false },
    });

    expect(result.learningEnabled).toBe(false);
    expect(result.trackerKind).toBe("linear");
    expect(result.trackerCredentialId).toBe(staleCredentialId);
    expect(db.workspace_settings[0]).toMatchObject({
      learning_enabled: false,
      tracker_kind: "linear",
      tracker_credential_id: staleCredentialId,
    });
    expect(setLearningMetaAgentScheduledTaskEnabled).toHaveBeenCalledWith({
      workspaceId,
      enabled: false,
    });
    expect(ensureLearningMetaAgentScheduleForWorkspace).not.toHaveBeenCalled();
  });

  it("rejects credentials from another workspace", async () => {
    setupMockDatabase(
      [],
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          workspace_id: "44444444-4444-4444-8444-444444444444",
          user_id: userId,
          agent_id: null,
          format: "api_key",
          provider: "linear",
          display_name: "Linear",
          key_value: { provider: "linear", LINEAR_API_KEY: "lin-test" },
          updated_at: "2026-05-18T13:00:00Z",
          validation_state: "unknown",
          validated_at: null,
        },
      ],
    );

    await expect(
      patchWorkspaceSettings({
        workspaceId,
        userId,
        patch: {
          trackerKind: "linear",
          trackerCredentialId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_credential",
    });
  });
});
