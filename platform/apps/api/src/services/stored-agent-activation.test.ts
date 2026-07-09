import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireStoredAgent } from "../routes/stored-agent-credentials/authz.js";
import { assertCodingHandoffReviewable } from "./planning-handoff.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { listSavedCredentialsForAgentFromSupabase, type ResolvedSavedCredential } from "./saved-credentials.js";
import { runStoredAgentActivation } from "./stored-agent-activation.js";
import {
  createStoredCredentialLaunch,
  validateLaunchableStoredCredential,
} from "./stored-agent-credentials/activation.js";

vi.mock("../routes/stored-agent-credentials/authz.js", () => ({
  requireStoredAgent: vi.fn(),
}));

vi.mock("./planning-handoff.js", () => ({
  assertCodingHandoffReviewable: vi.fn(),
}));

vi.mock("./execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("./saved-credentials.js", () => ({
  listSavedCredentialsForAgentFromSupabase: vi.fn(),
}));

vi.mock("./stored-agent-credentials/activation.js", () => ({
  createStoredCredentialLaunch: vi.fn(),
  validateLaunchableStoredCredential: vi.fn(),
}));

const codexCredential: ResolvedSavedCredential = {
  id: "cred-1",
  credentialRowId: "cred-row-1",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  provider: "openai",
  label: "OpenAI",
  envVar: "OPENAI_API_KEY",
  updatedAt: "2026-07-08T00:00:00.000Z",
  validationState: "ok",
  validatedAt: "2026-07-08T00:00:00.000Z",
  launchableKind: "codex",
  secretValue: "",
  secretRef: null,
  aliases: ["OPENAI_API_KEY"],
  endpoint: null,
  apiVersion: null,
  oauth: null,
};

const validatedCredential = {
  credential: {
    id: "cred-1",
    credentialRowId: "cred-row-1",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    updatedAt: "2026-07-08T00:00:00.000Z",
    validationState: "ok" as const,
    validatedAt: "2026-07-08T00:00:00.000Z",
    launchableKind: "codex" as const,
    endpoint: null,
    apiVersion: null,
    oauth: null,
  },
  secretValue: "secret-value",
  validation: {
    ok: true,
    provider: "openai",
    model: "openai/gpt-5.2",
    checkedAt: "2026-07-08T00:00:00.000Z",
    status: 200,
    code: null,
    message: "Validated",
  },
};

describe("runStoredAgentActivation", () => {
  beforeEach(() => {
    vi.mocked(requireStoredAgent).mockReset();
    vi.mocked(assertCodingHandoffReviewable).mockReset();
    vi.mocked(resolveExecutionProfile).mockReset();
    vi.mocked(listSavedCredentialsForAgentFromSupabase).mockReset();
    vi.mocked(validateLaunchableStoredCredential).mockReset();
    vi.mocked(createStoredCredentialLaunch).mockReset();

    vi.mocked(resolveExecutionProfile).mockResolvedValue({
      agent: {
        agentId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        role: "coding",
      },
      profile: {
        agentId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        role: "coding",
        runnerKind: "codex",
        model: "openai/gpt-5.2",
        provider: "openai",
        credentialRef: null,
        fallbacks: [],
        modelTierFloor: "any",
        toolProfile: "coding",
        capabilities: {
          streaming: true,
          toolCalls: true,
          workspaceWrite: true,
          structuredOutput: true,
          interrupt: true,
        },
      },
      missing: [],
      source: {
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    } as Awaited<ReturnType<typeof resolveExecutionProfile>>);
    vi.mocked(listSavedCredentialsForAgentFromSupabase).mockResolvedValue([codexCredential]);
  });

  it("selects a specific credential id and launches with the reviewed handoff", async () => {
    vi.mocked(validateLaunchableStoredCredential).mockResolvedValue(validatedCredential);
    vi.mocked(createStoredCredentialLaunch).mockResolvedValue({
      status: 201,
      launch: {
        attempted: true,
        sessionId: "session-1",
        status: "running",
        command: "codex app-server",
        cwd: "/workspace",
      },
    });

    const handoff = { planId: "plan-1", taskIds: ["task-1"] };
    const launcherClient = {} as never;
    const result = await runStoredAgentActivation({
      accessToken: "token",
      userId: "user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      handoff,
      selection: { kind: "credential_id", credentialId: "cred-1" },
      validationFailureMode: "skipped_launch",
      launcherClient,
    });

    expect(requireStoredAgent).toHaveBeenCalledWith({
      accessToken: "token",
      userId: "user-1",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });
    expect(assertCodingHandoffReviewable).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      handoff,
    });
    expect(validateLaunchableStoredCredential).toHaveBeenCalledWith({
      credential: codexCredential,
      workspaceId: "workspace-1",
      model: "openai/gpt-5.2",
    });
    expect(createStoredCredentialLaunch).toHaveBeenCalledWith({
      agentId: "agent-1",
      credential: codexCredential,
      workspaceId: "workspace-1",
      secretValue: "secret-value",
      handoff,
      launcherClient,
    });
    expect(result).toMatchObject({
      kind: "launched",
      status: 201,
      payload: {
        handoff,
        launch: {
          sessionId: "session-1",
        },
      },
    });
  });

  it("returns a skipped launch payload for specific-credential validation failures", async () => {
    vi.mocked(validateLaunchableStoredCredential).mockResolvedValue({
      ...validatedCredential,
      validation: {
        ...validatedCredential.validation,
        ok: false,
        code: "invalid_api_key",
        message: "Credential is invalid",
      },
    });

    const result = await runStoredAgentActivation({
      accessToken: "token",
      userId: "user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      handoff: null,
      selection: { kind: "credential_id", credentialId: "cred-1" },
      validationFailureMode: "skipped_launch",
      launcherClient: {} as never,
    });

    expect(createStoredCredentialLaunch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "validation_failed",
      payload: {
        launch: {
          attempted: false,
          status: "skipped_validation_failed",
        },
      },
    });
  });

  it("selects the first codex credential and returns a null launch on validation failure", async () => {
    vi.mocked(listSavedCredentialsForAgentFromSupabase).mockResolvedValue([
      { ...codexCredential, id: "cred-2", launchableKind: null },
      codexCredential,
    ]);
    vi.mocked(validateLaunchableStoredCredential).mockResolvedValue({
      ...validatedCredential,
      validation: {
        ...validatedCredential.validation,
        ok: false,
        code: "invalid_api_key",
        message: "Credential is invalid",
      },
    });

    const result = await runStoredAgentActivation({
      accessToken: "token",
      userId: "user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      handoff: null,
      selection: { kind: "first_codex" },
      validationFailureMode: "error",
      launcherClient: {} as never,
    });

    expect(validateLaunchableStoredCredential).toHaveBeenCalledWith({
      credential: codexCredential,
      workspaceId: "workspace-1",
      model: "openai/gpt-5.2",
    });
    expect(result).toMatchObject({
      kind: "validation_failed",
      payload: {
        launch: null,
      },
    });
  });
});
