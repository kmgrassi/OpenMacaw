import { afterEach, describe, expect, it, vi } from "vitest";

import { listStoredAgentsFromSupabase } from "../services/stored-agent-management.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";
import { requestAgentId, resolveDefaultAgentId, resolveRuntimeTargetForAgent } from "./runtime-target.js";
import type { UpstreamResponse } from "./upstream.js";

vi.mock("../services/stored-agent-management.js", () => ({
  isStoredAgentRuntimeSelectable: (agent: { agentType: string }) => agent.agentType !== "manager",
  listStoredAgentsFromSupabase: vi.fn(),
}));

vi.mock("../supabase-client.js", () => ({
  executeSupabaseRows: vi.fn(),
  getServiceRoleSupabase: vi.fn(),
}));

const mockedListStoredAgentsFromSupabase = vi.mocked(listStoredAgentsFromSupabase);
const mockedExecuteSupabaseRows = vi.mocked(executeSupabaseRows);
const mockedGetServiceRoleSupabase = vi.mocked(getServiceRoleSupabase);

function launcherResponse(status: number, body: unknown = {}): UpstreamResponse {
  return { status, body, headers: {} };
}

function mockEngineInstanceQuery() {
  const builder = {
    eq: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  builder.from.mockReturnValue(builder);
  mockedGetServiceRoleSupabase.mockReturnValue(builder as never);
  return builder;
}

describe("resolveRuntimeTargetForAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LAUNCHER_BASE_URL;
  });

  it("uses the launcher runtime front door when engine_instance has not been written yet", async () => {
    process.env.LAUNCHER_BASE_URL = "http://127.0.0.1:4100";
    mockEngineInstanceQuery();
    mockedExecuteSupabaseRows.mockResolvedValue([]);
    const launcherRequest = vi.fn().mockResolvedValue(launcherResponse(200, { ok: true }));

    const target = await resolveRuntimeTargetForAgent("agent-1", launcherRequest);

    expect(target).toMatchObject({
      agentId: "agent-1",
      baseUrl: "http://127.0.0.1:4100/agents/agent-1/runtime",
      wsUrl: "ws://127.0.0.1:4100/agents/agent-1/runtime/ws",
    });
    expect(launcherRequest).toHaveBeenCalledWith("/agents/agent-1/runtime/api/v1/health", { method: "GET" });
  });

  it("prefers a healthy engine_instance row when one is available", async () => {
    process.env.LAUNCHER_BASE_URL = "http://127.0.0.1:4100";
    mockEngineInstanceQuery();
    mockedExecuteSupabaseRows.mockResolvedValue([
      {
        agent_id: "agent-1",
        host: "runtime-host",
        instance_id: "instance-1",
        port: 4001,
        started_at: "2026-04-24T10:00:00.000Z",
        status: "healthy",
        workspace_id: "workspace-1",
      },
    ]);
    const launcherRequest = vi.fn();

    const target = await resolveRuntimeTargetForAgent("agent-1", launcherRequest);

    expect(target).toMatchObject({
      agentId: "agent-1",
      instanceId: "instance-1",
      workspaceId: "workspace-1",
      baseUrl: "http://127.0.0.1:4100/agents/agent-1/runtime",
      wsUrl: "ws://127.0.0.1:4100/agents/agent-1/runtime/ws",
    });
    expect(launcherRequest).not.toHaveBeenCalled();
  });
});

describe("resolveDefaultAgentId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips manager agents when choosing the stored-agent fallback", async () => {
    mockedListStoredAgentsFromSupabase.mockResolvedValue([
      {
        id: "manager-agent",
        name: "Manager",
        workspaceId: "workspace-1",
        agentType: "manager",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        runnerKind: "llm_tool_runner",
        hasCredentials: true,
        isResolved: true,
        planningDestination: null,
        customTarget: null,
      },
      {
        id: "coding-agent",
        name: "Coding",
        workspaceId: "workspace-1",
        agentType: "coding",
        model: "openai/gpt-5.2",
        provider: "openai",
        context: null,
        runnerKind: "codex",
        hasCredentials: true,
        isResolved: false,
        planningDestination: null,
        customTarget: null,
      },
    ]);

    await expect(resolveDefaultAgentId()).resolves.toBe("coding-agent");
  });
});

describe("requestAgentId", () => {
  it("reads camelCase HTTP boundary fields", () => {
    expect(
      requestAgentId({
        params: {},
        query: { agentId: " agent-query " },
        body: undefined,
      } as never),
    ).toBe("agent-query");

    expect(
      requestAgentId({
        params: {},
        query: {},
        body: { agentId: " agent-body " },
      } as never),
    ).toBe("agent-body");
  });

  it("does not accept snake_case HTTP boundary fields", () => {
    expect(
      requestAgentId({
        params: {},
        query: { agent_id: "agent-query" },
        body: undefined,
      } as never),
    ).toBeNull();

    expect(
      requestAgentId({
        params: {},
        query: {},
        body: { agent_id: "agent-body" },
      } as never),
    ).toBeNull();
  });
});
