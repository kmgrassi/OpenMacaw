import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../config.js";
import { ApiRouteError } from "../http.js";
import { createPlanDraftFromPrompt, PlanDraftValidationError } from "../services/plan-drafts.js";
import type * as PlanDraftService from "../services/plan-drafts.js";
import { executeSupabaseRows } from "../supabase-client.js";
import { registerPlanRoutes } from "./plans.js";

vi.mock("../services/plan-drafts.js", async () => {
  const actual = await vi.importActual<typeof PlanDraftService>("../services/plan-drafts.js");
  return {
    ...actual,
    createPlanDraftFromPrompt: vi.fn(),
  };
});

let queryTable = "";
let selectRowsForTable: (table: string) => unknown[] | Promise<unknown[]> = () => [];

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: vi.fn(),
  getServiceRoleSupabase: vi.fn(() => queryBuilder),
}));

const queryBuilder = {
  from: vi.fn((table: string) => {
    queryTable = table;
    return queryBuilder;
  }),
  select: vi.fn(() => queryBuilder),
  insert: vi.fn(() => queryBuilder),
  update: vi.fn(() => queryBuilder),
  delete: vi.fn(() => queryBuilder),
  eq: vi.fn(() => queryBuilder),
  in: vi.fn(() => queryBuilder),
  not: vi.fn(() => queryBuilder),
  limit: vi.fn(() => queryBuilder),
  order: vi.fn(() => queryBuilder),
  then: vi.fn((onfulfilled?: (value: { data: unknown[]; error: null }) => unknown) =>
    Promise.resolve(selectRowsForTable(queryTable)).then((data) =>
      onfulfilled ? onfulfilled({ data, error: null }) : { data, error: null },
    ),
  ),
};

const config: ApiConfig = {
  port: 0,
  host: "127.0.0.1",
  orchestratorBaseUrl: "http://127.0.0.1:4000",
  orchestratorWsUrl: "ws://127.0.0.1:4000",
  launcherBaseUrl: "http://127.0.0.1:4100",
  orchestratorRequestTimeoutMs: 500,
  launcherRequestTimeoutMs: 500,
  corsOrigins: "http://127.0.0.1:5173",
  wsUpgradePath: "/ws",
  wsConnectTimeoutMs: 500,
  workItemDefaultWorkspaceId: null,
  githubWebhookSecret: null,
  githubRepoWorkspaceMap: {},
  linearWebhookSecret: null,
  linearApiKey: null,
  linearProjectWorkspaceMap: {},
  linearTeamWorkspaceMap: {},
};

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const planId = "33333333-3333-4333-8333-333333333333";
// Work item primary keys are assigned by the database; the test stands in for that.
const workItemApiId = "44444444-4444-4444-8444-444444444401";
const workItemWebId = "44444444-4444-4444-8444-444444444402";

const validPlan = {
  workspaceId,
  schemaVersion: "1",
  title: "Clean up imports",
  intent: "Clean up unused imports in focused areas.",
  defaultRunner: "codex",
  defaultModel: "gpt-5.2",
  tasks: [
    {
      id: "t-01",
      title: "Clean up API imports",
      instructions: "Remove unused imports under apps/api.",
      labels: { area: "api" },
      dependsOn: [],
      completionGates: ["lint", "tests"],
    },
    {
      id: "t-02",
      title: "Clean up web imports",
      instructions: "Remove unused imports under apps/web after API cleanup.",
      labels: { area: "web" },
      dependsOn: ["t-01"],
      completionGates: ["lint"],
    },
  ],
} as const;

// Note: do NOT use `as const` here. This fixture is passed through
// `vi.mocked(createPlanDraftFromPrompt).mockResolvedValue({ draft })` where
// the mock signature expects mutable `tasks: {…}[]`. `as const` would
// produce `readonly [...]` and TS2322 the build.
const draft: {
  schemaVersion: "1";
  title: string;
  intent: string;
  tasks: Array<{
    id: string;
    title: string;
    instructions: string;
    labels: Record<string, string>;
    dependsOn: string[];
    completionGates: Array<"lint" | "tests" | "peer-review" | "self-review">;
  }>;
} = {
  schemaVersion: "1",
  title: "Ship plan drafting",
  intent: "Create a plan draft from the user's prompt.",
  tasks: [
    {
      id: "t-api",
      title: "Add API endpoint",
      instructions: "Implement the draft endpoint.",
      labels: {},
      dependsOn: [],
      completionGates: ["tests"],
    },
  ],
};

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: planId,
    workspace_id: workspaceId,
    name: validPlan.title,
    description: validPlan.intent,
    status: "pending",
    metadata: validPlan,
    schema_version: "1",
    intent: validPlan.intent,
    default_runner_kind: "codex",
    default_model: "gpt-5.2",
    created_at: "2026-04-25T12:00:00.000Z",
    updated_at: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

function expectedPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: planId,
    workspaceId,
    name: validPlan.title,
    description: validPlan.intent,
    status: "pending",
    metadata: validPlan,
    schemaVersion: "1",
    intent: validPlan.intent,
    defaultRunnerKind: "codex",
    defaultModel: "gpt-5.2",
    createdAt: "2026-04-25T12:00:00.000Z",
    updatedAt: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

function workItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    task_id: "55555555-5555-4555-8555-555555555555",
    workspace_id: workspaceId,
    plan_id: planId,
    title: "Clean up API imports",
    description: "Remove unused imports under apps/api.",
    state: "todo",
    priority: null,
    source: "api",
    labels: ["area:api"],
    metadata: { author_task_id: "t-01" },
    depends_on: [],
    completion_gates: ["lint", "tests"],
    instructions: "Remove unused imports under apps/api.",
    identifier: "WI-1",
    next_poll_at: null,
    last_polled_at: null,
    poll_cadence_seconds: 300,
    created_at: "2026-04-25T12:00:00.000Z",
    updated_at: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("plan routes", () => {
  let server: Server;
  let baseUrl = "";
  const launcherRequest = vi.fn();

  beforeEach(async () => {
    selectRowsForTable = () => [];
    vi.mocked(createPlanDraftFromPrompt).mockResolvedValue({ draft });
    vi.mocked(executeSupabaseRows).mockImplementation(async (context) => {
      if (context === "workspace_members query") return [{ workspace_id: workspaceId }];
      if (context === "plan insert") return [planRow()];
      if (context === "work_items insert") {
        // The database assigns ids and depends_on defaults to empty; dependency
        // references are resolved by the second-pass update keyed on author_task_id.
        return [
          workItemRow({ id: workItemApiId, task_id: null }),
          workItemRow({
            id: workItemWebId,
            task_id: null,
            title: "Clean up web imports",
            description: "Remove unused imports under apps/web after API cleanup.",
            labels: ["area:web"],
            metadata: { author_task_id: "t-02" },
            depends_on: [],
            completion_gates: ["lint"],
          }),
        ];
      }
      return [];
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerPlanRoutes(app, config, launcherRequest);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
  });

  it("requires auth before creating a draft", async () => {
    const response = await fetch(`${baseUrl}/api/plans/draft-from-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, prompt: "Create a plan" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(createPlanDraftFromPrompt).not.toHaveBeenCalled();
  });

  it("requires auth before reading plan reviews", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/plan-reviews`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("rejects plan reviews for workspaces outside the authenticated user", async () => {
    vi.mocked(executeSupabaseRows).mockRejectedValueOnce(
      new Error("Authenticated user is not authorized for the requested workspace"),
    );

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/plan-reviews`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("returns plan reviews with tasks and extracted evidence", async () => {
    selectRowsForTable = (table) => {
      if (table === "workspace_members") return [{ workspace_id: workspaceId }];
      if (table === "work_items") {
        return [
          workItemRow({
            metadata: {
              evidence: [
                { path: "apps/api/src/routes/plans.ts", line: 41, snippet: "registerPlanRoutes", label: "route" },
                "apps/web/src/api/plan-review.ts",
              ],
            },
          }),
        ];
      }
      if (table === "plan") {
        return [
          {
            id: planId,
            name: "Clean up imports",
            description: "Clean up unused imports in focused areas.",
            status: "pending",
            type: "implementation",
            created_at: "2026-04-25T12:00:00.000Z",
            updated_at: "2026-04-25T12:00:00.000Z",
          },
        ];
      }
      return [];
    };

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/plan-reviews`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      plans: [
        {
          id: planId,
          name: "Clean up imports",
          description: "Clean up unused imports in focused areas.",
          status: "pending",
          type: "implementation",
          createdAt: "2026-04-25T12:00:00.000Z",
          updatedAt: "2026-04-25T12:00:00.000Z",
          tasks: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              workspaceId,
              planId,
              name: "Clean up API imports",
              description: "Remove unused imports under apps/api.",
              state: "todo",
              priority: null,
              labels: ["area:api"],
              metadata: {
                evidence: [
                  {
                    path: "apps/api/src/routes/plans.ts",
                    line: 41,
                    snippet: "registerPlanRoutes",
                    label: "route",
                  },
                  "apps/web/src/api/plan-review.ts",
                ],
              },
              createdAt: "2026-04-25T12:00:00.000Z",
              updatedAt: "2026-04-25T12:00:00.000Z",
              evidence: [
                {
                  path: "apps/api/src/routes/plans.ts",
                  line: 41,
                  snippet: "registerPlanRoutes",
                  label: "route",
                },
                {
                  path: "apps/web/src/api/plan-review.ts",
                  line: null,
                  snippet: null,
                  label: null,
                },
              ],
            },
          ],
          evidence: [
            {
              path: "apps/api/src/routes/plans.ts",
              line: 41,
              snippet: "registerPlanRoutes",
              label: "route",
            },
            {
              path: "apps/web/src/api/plan-review.ts",
              line: null,
              snippet: null,
              label: null,
            },
          ],
        },
      ],
    });
  });

  it("returns a draft from the planning service", async () => {
    const response = await fetch(`${baseUrl}/api/plans/draft-from-prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, prompt: "Create a plan" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ draft });
    expect(createPlanDraftFromPrompt).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      request: { workspaceId, prompt: "Create a plan" },
      launcherRequest,
      requestTimeoutMs: 500,
    });
  });

  it("accepts local model coding as a draft default runner", async () => {
    const response = await fetch(`${baseUrl}/api/plans/draft-from-prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        prompt: "Create a local coding plan",
        defaultRunner: "local_model_coding",
      }),
    });

    expect(response.status).toBe(200);
    expect(createPlanDraftFromPrompt).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      request: {
        workspaceId,
        prompt: "Create a local coding plan",
        defaultRunner: "local_model_coding",
      },
      launcherRequest,
      requestTimeoutMs: 500,
    });
  });

  it("returns 422 for invalid planner output", async () => {
    vi.mocked(createPlanDraftFromPrompt).mockRejectedValue(
      new PlanDraftValidationError([{ path: "/tasks/0/title", message: "must NOT be shorter than 1 character" }]),
    );

    const response = await fetch(`${baseUrl}/api/plans/draft-from-prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, prompt: "Create a plan" }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      errors: [{ path: "/tasks/0/title", message: "must NOT be shorter than 1 character" }],
    });
  });

  it("normalizes route errors", async () => {
    vi.mocked(createPlanDraftFromPrompt).mockRejectedValue(
      new ApiRouteError(409, "planning_agent_unconfigured", "A default planning agent is required"),
    );

    const response = await fetch(`${baseUrl}/api/plans/draft-from-prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, prompt: "Create a plan" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "planning_agent_unconfigured" },
    });
  });

  it("persists a valid plan and work items", async () => {
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(validPlan),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.plan).toEqual(expectedPlan());
    expect(body.workItems).toHaveLength(2);
    expect(queryBuilder.from).toHaveBeenCalledWith("plan");
    expect(queryBuilder.from).toHaveBeenCalledWith("work_items");

    const workItemInsertBody = (queryBuilder.insert.mock.calls[1] as unknown[] | undefined)?.[0] as Array<
      Record<string, unknown>
    >;
    expect(workItemInsertBody).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plan_id: planId,
          title: "Clean up API imports",
          description: "Remove unused imports under apps/api.",
          state: "todo",
          labels: ["area:api"],
          metadata: expect.objectContaining({ author_task_id: "t-01" }),
          instructions: "Remove unused imports under apps/api.",
          completion_gates: ["lint", "tests"],
        }),
        expect.objectContaining({
          title: "Clean up web imports",
          instructions: "Remove unused imports under apps/web after API cleanup.",
          metadata: expect.objectContaining({ author_task_id: "t-02" }),
          completion_gates: ["lint"],
        }),
      ]),
    );

    // The database owns id generation: the app must not supply a primary key, nor
    // pre-resolve depends_on (which would require knowing the ids before insert).
    for (const row of workItemInsertBody) {
      expect(row).not.toHaveProperty("id");
      expect(row).not.toHaveProperty("depends_on");
    }

    // Dependencies are resolved to the DB-assigned ids in a second-pass update.
    expect(queryBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ depends_on: [workItemApiId] }));
    const webItem = (body.workItems as Array<{ title: string; dependsOn: string[] }>).find(
      (item) => item.title === "Clean up web imports",
    );
    expect(webItem?.dependsOn).toEqual([workItemApiId]);
  });

  it("returns 400 with schema errors for an invalid plan", async () => {
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...validPlan, tasks: [] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_plan");
    expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ code: "too_small" })]));
    expect(executeSupabaseRows).not.toHaveBeenCalledWith("plan insert", expect.anything());
  });

  it("returns 400 for dependency cycles", async () => {
    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...validPlan,
        tasks: [
          { ...validPlan.tasks[0], dependsOn: ["t-02"] },
          { ...validPlan.tasks[1], dependsOn: ["t-01"] },
        ],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_plan_graph");
    expect(body.error.message).toBe("Task dependency graph must not contain cycles");
    expect(executeSupabaseRows).not.toHaveBeenCalledWith("plan insert", expect.anything());
  });

  it("rolls back the plan row when work item persistence fails", async () => {
    vi.mocked(executeSupabaseRows).mockImplementation(async (context) => {
      if (context === "workspace_members query") return [{ workspace_id: workspaceId }];
      if (context === "plan insert") return [planRow()];
      if (context === "work_items insert") throw new Error("work_items failed");
      return [];
    });

    const response = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(validPlan),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "plan_create_failed",
        message: "Could not persist plan",
        details: "Error: work_items failed",
      },
    });
    expect(executeSupabaseRows).toHaveBeenCalledWith("work_items delete", expect.anything());
    expect(executeSupabaseRows).toHaveBeenCalledWith("plan delete", expect.anything());
  });
});
