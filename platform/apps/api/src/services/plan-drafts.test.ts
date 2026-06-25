import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRouteError } from "../http.js";
import { createPlanDraftFromPrompt, PlanDraftValidationError } from "./plan-drafts.js";
import { redactOutboundPromptForWorkspace } from "./prompt-redaction.js";
import { createUpstreamRequester } from "./upstream.js";
import { resolveRuntimeTargetForAgent } from "./runtime-target.js";
import { getDefaultAgentStatusForWorkspace, listSetupAuthState } from "./setup.js";

vi.mock("./setup.js", () => ({
  getDefaultAgentStatusForWorkspace: vi.fn(),
  listSetupAuthState: vi.fn(),
}));

vi.mock("./runtime-target.js", () => ({
  resolveRuntimeTargetForAgent: vi.fn(),
}));

vi.mock("./prompt-redaction.js", () => ({
  redactOutboundPromptForWorkspace: vi.fn(),
}));

vi.mock("./upstream.js", () => ({
  createUpstreamRequester: vi.fn(),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const secondaryWorkspaceId = "55555555-5555-4555-8555-555555555555";
const planningAgentId = "33333333-3333-4333-8333-333333333333";
const managerAgentId = "55555555-5555-4555-8555-555555555555";
const secondaryPlanningAgentId = "66666666-6666-4666-8666-666666666666";

const validDraft = {
  schemaVersion: "1",
  title: "Ship plan drafting",
  intent: "Create a plan draft from the user's prompt.",
  defaultRunner: "codex",
  defaultModel: "gpt-5.1",
  tasks: [
    {
      id: "t-api",
      title: "Add API endpoint",
      instructions: "Implement the draft endpoint.",
      labels: { area: "api" },
      dependsOn: [],
      completionGates: ["tests"],
    },
  ],
};

function workspace(id = workspaceId, name = "Workspace") {
  return {
    id,
    name,
    ownerUserId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-04-25T12:00:00.000Z",
  };
}

function authState(overrides: { planningAgentId?: string; workspaces?: ReturnType<typeof workspace>[] } = {}) {
  return {
    ready: true,
    userId: "11111111-1111-4111-8111-111111111111",
    resolvedAgentId: overrides.planningAgentId ?? planningAgentId,
    workspaceId,
    workspaces: overrides.workspaces ?? [workspace()],
    agents: [],
    defaultAgents: {
      planning: {
        agentId: overrides.planningAgentId ?? planningAgentId,
        configured: true,
        missing: [],
      },
      coding: {
        agentId: "44444444-4444-4444-8444-444444444444",
        configured: false,
        missing: [],
      },
    },
    managerAgent: {
      agentId: managerAgentId,
      configured: false,
      missing: [],
    },
    onboarding: {
      required: false,
      blocking: false,
      reasons: [],
    },
  };
}

describe("createPlanDraftFromPrompt", () => {
  const runtimeRequest = vi.fn();
  const launcherRequest = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listSetupAuthState).mockResolvedValue(authState());
    vi.mocked(getDefaultAgentStatusForWorkspace).mockResolvedValue({
      agentId: planningAgentId,
      configured: true,
      missing: [],
    });
    vi.mocked(resolveRuntimeTargetForAgent).mockResolvedValue({
      agentId: planningAgentId,
      host: "127.0.0.1",
      port: 4101,
      workspaceId,
      instanceId: "runtime-1",
      startedAt: "2026-04-25T12:00:00.000Z",
      baseUrl: "http://127.0.0.1:4101",
      wsUrl: "ws://127.0.0.1:4101/ws",
    });
    vi.mocked(createUpstreamRequester).mockReturnValue(runtimeRequest);
    vi.mocked(redactOutboundPromptForWorkspace).mockImplementation(async ({ prompt }) => ({
      prompt,
      redactionCount: 0,
    }));
    runtimeRequest.mockResolvedValue({ status: 200, body: { draft: validDraft }, headers: {} });
  });

  it("dispatches the planning runtime with dry_run and returns a validated draft", async () => {
    const result = await createPlanDraftFromPrompt({
      accessToken: "access-token",
      userId: "11111111-1111-4111-8111-111111111111",
      request: {
        workspaceId: workspaceId,
        prompt: "Create an endpoint",
        defaultRunner: "codex",
        defaultModel: "gpt-5.1",
      },
      launcherRequest,
      requestTimeoutMs: 500,
    });

    expect(resolveRuntimeTargetForAgent).toHaveBeenCalledWith(planningAgentId, launcherRequest);
    expect(redactOutboundPromptForWorkspace).toHaveBeenCalledWith({
      prompt: "Create an endpoint",
      planningAgentId,
      workspaceId,
      userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(createUpstreamRequester).toHaveBeenCalledWith("http://127.0.0.1:4101", 500);
    expect(runtimeRequest).toHaveBeenCalledWith("/api/v1/plans/draft-from-prompt", {
      method: "POST",
      headers: {
        authorization: "Bearer access-token",
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        prompt: "Create an endpoint",
        default_runner: "codex",
        default_model: "gpt-5.1",
        dry_run: true,
      }),
    });
    expect(result).toEqual({ draft: validDraft });
  });

  it("sends the redacted prompt to the planning runtime", async () => {
    vi.mocked(redactOutboundPromptForWorkspace).mockResolvedValue({
      prompt: "Do not leak <redacted>",
      redactionCount: 1,
    });

    await createPlanDraftFromPrompt({
      accessToken: "access-token",
      userId: "11111111-1111-4111-8111-111111111111",
      request: {
        workspaceId: workspaceId,
        prompt: "Do not leak sk-test-1234",
      },
      launcherRequest,
      requestTimeoutMs: 500,
    });

    expect(JSON.parse(String(runtimeRequest.mock.calls[0]?.[1]?.body))).toMatchObject({
      prompt: "Do not leak <redacted>",
    });
  });

  it("fails closed when credential redaction cannot complete", async () => {
    vi.mocked(redactOutboundPromptForWorkspace).mockRejectedValue(new Error("credential lookup failed"));

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId: workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "credential_redaction_failed",
    });

    expect(runtimeRequest).not.toHaveBeenCalled();
  });

  it("uses the default planning agent assigned to the requested workspace", async () => {
    vi.mocked(listSetupAuthState).mockResolvedValue(
      authState({
        workspaces: [workspace(), workspace(secondaryWorkspaceId, "Secondary")],
      }),
    );
    vi.mocked(getDefaultAgentStatusForWorkspace).mockResolvedValue({
      agentId: secondaryPlanningAgentId,
      configured: true,
      missing: [],
    });

    await createPlanDraftFromPrompt({
      accessToken: "access-token",
      userId: "11111111-1111-4111-8111-111111111111",
      request: {
        workspaceId: secondaryWorkspaceId,
        prompt: "Create an endpoint",
      },
      launcherRequest,
      requestTimeoutMs: 500,
    });

    expect(getDefaultAgentStatusForWorkspace).toHaveBeenCalledWith(
      "access-token",
      "11111111-1111-4111-8111-111111111111",
      secondaryWorkspaceId,
      "planning",
    );
    expect(resolveRuntimeTargetForAgent).toHaveBeenCalledWith(secondaryPlanningAgentId, launcherRequest);
  });

  it("returns a setup error when the requested workspace planner is not configured", async () => {
    vi.mocked(getDefaultAgentStatusForWorkspace).mockResolvedValue({
      agentId: planningAgentId,
      configured: false,
      missing: ["credential", "model"],
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId: workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "planning_agent_unconfigured",
      details: { missing: ["credential", "model"] },
    });
    expect(resolveRuntimeTargetForAgent).not.toHaveBeenCalled();
  });

  it("maps invalid planner output to a validation error", async () => {
    runtimeRequest.mockResolvedValue({
      status: 200,
      body: { draft: { title: "Missing required fields", tasks: [] } },
      headers: {},
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId: workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(PlanDraftValidationError);
  });

  it("relays runtime validation failures as 422 validation errors", async () => {
    runtimeRequest.mockResolvedValue({
      status: 422,
      body: { errors: [{ instancePath: "/tasks/0/title", message: "must NOT be shorter than 1 character" }] },
      headers: {},
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId: workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      errors: [{ path: "/tasks/0/title", message: "must NOT be shorter than 1 character" }],
    });
  });

  it("accepts nested runtime draft envelopes", async () => {
    runtimeRequest.mockResolvedValue({
      status: 200,
      body: { data: { plan: validDraft } },
      headers: {},
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).resolves.toEqual({ draft: validDraft });
  });

  it("reads nested runtime validation details envelopes", async () => {
    runtimeRequest.mockResolvedValue({
      status: 422,
      body: {
        error: {
          details: [{ path: "/title", message: "Title is required", keyword: "required" }],
        },
      },
      headers: {},
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      errors: [{ path: "/title", message: "Title is required", code: "required" }],
    });
  });

  it("falls back to stringifying non-object runtime validation entries", async () => {
    runtimeRequest.mockResolvedValue({
      status: 422,
      body: { errors: ["planner returned malformed validation metadata"] },
      headers: {},
    });

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      errors: [{ path: "/", message: "planner returned malformed validation metadata" }],
    });
  });

  it("rejects workspaces outside the authenticated user's membership", async () => {
    vi.mocked(listSetupAuthState).mockResolvedValue(authState({ workspaces: [workspace("other", "Other")] }));

    await expect(
      createPlanDraftFromPrompt({
        accessToken: "access-token",
        userId: "11111111-1111-4111-8111-111111111111",
        request: {
          workspaceId: workspaceId,
          prompt: "Create an endpoint",
        },
        launcherRequest,
        requestTimeoutMs: 500,
      }),
    ).rejects.toMatchObject(
      new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user"),
    );
    expect(runtimeRequest).not.toHaveBeenCalled();
  });
});
