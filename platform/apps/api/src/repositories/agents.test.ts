import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceRoleSupabase, getUserScopedSupabase } from "../supabase-client.js";
import { createSetupAgent, findSetupAgentById, listStoredAgentRows, updateSetupAgent } from "./agents.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
  getUserScopedSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

type MockFn = ReturnType<typeof vi.fn>;
type QueryBuilder = {
  eq: MockFn;
  insert: MockFn;
  maybeSingle: MockFn;
  order: MockFn;
  select: MockFn;
  single: MockFn;
  update: MockFn;
  then?: MockFn;
};

function mockBuilder(result: unknown): QueryBuilder {
  const builder: QueryBuilder = {
    eq: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    update: vi.fn(),
  };

  builder.eq.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue(result);
  builder.single.mockResolvedValue(result);
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)));

  return builder;
}

function useServiceBuilder(builder: QueryBuilder) {
  const from = vi.fn().mockReturnValue(builder);
  vi.mocked(getServiceRoleSupabase).mockReturnValue({ from } as never);
  return from;
}

function useUserBuilder(builder: QueryBuilder) {
  const from = vi.fn().mockReturnValue(builder);
  vi.mocked(getUserScopedSupabase).mockReturnValue({ from } as never);
  return from;
}

describe("agent repository", () => {
  beforeEach(() => {
    vi.mocked(getServiceRoleSupabase).mockReset();
    vi.mocked(getUserScopedSupabase).mockReset();
  });

  it("lists stored agents with service role scope", async () => {
    const rows = [
      {
        id: "agent-1",
        name: "Agent",
        workspace_id: "workspace-1",
        type: "coding",
        context: null,
        model_settings: {},
        tool_policy: {},
      },
    ];
    const builder = mockBuilder({ data: rows, error: null });
    const from = useServiceBuilder(builder);

    await expect(listStoredAgentRows()).resolves.toEqual(rows);

    expect(from).toHaveBeenCalledWith("agent");
    expect(builder.select).toHaveBeenCalledWith("id,name,workspace_id,type,context,model_settings,tool_policy");
    expect(builder.order).toHaveBeenCalledWith("updated_at", { ascending: false });
  });

  it("rejects stored agent rows that do not match the repository schema", async () => {
    const builder = mockBuilder({
      data: [
        {
          id: "agent-1",
          name: "Agent",
          workspace_id: 42,
          type: "coding",
          model_settings: {},
          tool_policy: {},
        },
      ],
      error: null,
    });
    useServiceBuilder(builder);

    await expect(listStoredAgentRows()).rejects.toMatchObject({
      code: "repository_row_parse_error",
      details: expect.objectContaining({
        repository: "agents",
        method: "listStoredAgentRows",
        table: "agent",
      }),
    });
  });

  it("canonicalizes null agent settings JSON to empty objects on read", async () => {
    const rows = [
      {
        id: "agent-1",
        name: "Agent",
        workspace_id: "workspace-1",
        type: "coding",
        model_settings: null,
        tool_policy: null,
      },
    ];
    const builder = mockBuilder({ data: rows, error: null });
    useServiceBuilder(builder);

    await expect(listStoredAgentRows()).resolves.toEqual([
      {
        id: "agent-1",
        name: "Agent",
        workspace_id: "workspace-1",
        type: "coding",
        context: null,
        model_settings: {},
        tool_policy: {},
      },
    ]);
  });

  it("rejects non-object agent settings JSON on read", async () => {
    const rows = [
      {
        id: "agent-1",
        name: "Agent",
        workspace_id: "workspace-1",
        type: "coding",
        model_settings: "openai/gpt-5",
        tool_policy: {},
      },
    ];
    const builder = mockBuilder({ data: rows, error: null });
    useServiceBuilder(builder);

    await expect(listStoredAgentRows()).rejects.toMatchObject({
      code: "repository_row_parse_error",
      details: expect.objectContaining({
        repository: "agents",
        method: "listStoredAgentRows",
        table: "agent",
      }),
    });
  });

  it("finds a setup agent by id using the caller token", async () => {
    const row = {
      id: "agent-1",
      workspace_id: "workspace-1",
      name: "Agent",
      status: "ready",
      type: "coding",
      model_settings: {},
      tool_policy: {},
      created_by_user_id: "user-1",
      updated_at: "2026-04-26T12:00:00.000Z",
    };
    const builder = mockBuilder({ data: row, error: null });
    useUserBuilder(builder);

    await expect(findSetupAgentById("token-1", "agent-1")).resolves.toMatchObject({ id: "agent-1" });

    expect(getUserScopedSupabase).toHaveBeenCalledWith("token-1");
    expect(builder.eq).toHaveBeenCalledWith("id", "agent-1");
    expect(builder.maybeSingle).toHaveBeenCalled();
  });

  it("creates setup agents without changing the caller-facing payload", async () => {
    const row = {
      id: "agent-1",
      workspace_id: "workspace-1",
      name: "Agent",
      status: "draft",
      type: "coding",
      context: null,
      model_settings: { model: "gpt-5" },
      tool_policy: {},
      created_by_user_id: "user-1",
      updated_at: "2026-04-26T12:00:00.000Z",
    };
    const builder = mockBuilder({ data: row, error: null });
    useUserBuilder(builder);

    await expect(
      createSetupAgent({
        accessToken: "token-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        name: "Agent",
        type: "coding",
        modelSettings: { model: "gpt-5" },
        toolPolicy: {},
        status: "draft",
      }),
    ).resolves.toEqual(row);

    expect(builder.insert).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      created_by_user_id: "user-1",
      name: "Agent",
      type: "coding",
      model_settings: { model: "gpt-5" },
      tool_policy: {},
      status: "draft",
    });
    expect(builder.single).toHaveBeenCalled();
  });

  it("returns null when an update does not match a setup agent", async () => {
    const builder = mockBuilder({ data: null, error: null });
    useUserBuilder(builder);

    await expect(
      updateSetupAgent({
        accessToken: "token-1",
        agentId: "missing-agent",
        name: "Agent",
        type: "coding",
        modelSettings: {},
        toolPolicy: {},
      }),
    ).resolves.toBeNull();

    expect(builder.update).toHaveBeenCalledWith({
      name: "Agent",
      type: "coding",
      model_settings: {},
      tool_policy: {},
    });
    expect(builder.eq).toHaveBeenCalledWith("id", "missing-agent");
    expect(builder.maybeSingle).toHaveBeenCalled();
  });
});
