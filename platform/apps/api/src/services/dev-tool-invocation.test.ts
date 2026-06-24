import { beforeEach, describe, expect, it, vi } from "vitest";

import { findSetupAgentById } from "../repositories/agents.js";
import type * as AgentRepository from "../repositories/agents.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import type * as SupabaseClientModule from "../supabase-client.js";
import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";
import { executeToolCall } from "./tool-execution-client.js";
import type * as ToolExecutionClient from "./tool-execution-client.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import type * as ExecutionProfileResolver from "./execution-profile-resolver.js";
import { invokeDevTool } from "./dev-tool-invocation.js";

vi.mock("../repositories/agents.js", async () => {
  const actual = await vi.importActual<typeof AgentRepository>("../repositories/agents.js");
  return {
    ...actual,
    findSetupAgentById: vi.fn(),
  };
});

vi.mock("../supabase-client.js", async () => {
  const actual = await vi.importActual<typeof SupabaseClientModule>("../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("./work-item-ingest.js", () => ({
  assertWorkspaceMembership: vi.fn(),
}));

vi.mock("./execution-profile-resolver.js", async () => {
  const actual = await vi.importActual<typeof ExecutionProfileResolver>("./execution-profile-resolver.js");
  return {
    ...actual,
    resolveExecutionProfile: vi.fn(),
  };
});

vi.mock("./tool-execution-client.js", async () => {
  const actual = await vi.importActual<typeof ToolExecutionClient>("./tool-execution-client.js");
  return {
    ...actual,
    executeToolCall: vi.fn(),
  };
});

const accessToken = "test-token";
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const toolId = "44444444-4444-4444-8444-444444444444";

function agent() {
  return {
    id: agentId,
    workspace_id: workspaceId,
    name: "Coding Agent",
    status: "ready",
    type: "coding",
    model_settings: {},
    tool_policy: {
      executionTarget: {
        kind: "local_helper",
        workspace_root: "/Users/dev/project",
      },
    },
    created_by_user_id: userId,
    updated_at: "2026-05-12T12:00:00.000Z",
  };
}

function profile() {
  return {
    agent: {
      agentId,
      workspaceId,
      role: "coding" as const,
    },
    profile: {
      agentId,
      workspaceId,
      role: "coding" as const,
      runnerKind: "local_model_coding" as const,
      provider: "local" as const,
      model: "qwen",
      credentialRef: null,
      fallbacks: [],
      modelTierFloor: "any" as const,
      toolProfile: "coding" as const,
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
        interrupt: false,
      },
    },
    missing: [],
    source: {
      routingRuleId: "77777777-7777-4777-8777-777777777777",
      credentialAlias: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  };
}

describe("dev tool invocation service", () => {
  type TableRows = Array<Record<string, unknown>>;
  let tables: {
    tool: TableRows;
    agent_tool_grant: TableRows;
    routing_rule_match: TableRows;
  } & Record<string, TableRows>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tables = {
      tool: [
        {
          id: toolId,
          workspace_id: null,
          slug: "shell.exec",
          name: "Read File",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          function_name: "shell_exec",
          type: "function",
          execution_kind: "filesystem_read",
          runner_kind: "local_model_coding",
          enabled: true,
          created_by_user_id: null,
        },
      ],
      agent_tool_grant: [
        {
          id: "grant-1",
          agent_id: agentId,
          tool_id: toolId,
          workspace_id: workspaceId,
          mode: "include",
          source: "manual",
          source_tool_template_id: null,
          reason: null,
          created_by_user_id: userId,
        },
      ],
      routing_rule_match: [
        {
          id: "match-1",
          workspace_id: workspaceId,
          rule_id: "77777777-7777-4777-8777-777777777777",
          kind: "local_workspace_root",
          key: "path",
          value: "/Users/dev/routed-project",
        },
      ],
    };
    vi.mocked(getServiceRoleSupabase).mockReturnValue(createMockSupabaseClient(tables) as never);
    vi.mocked(findSetupAgentById).mockResolvedValue(agent() as never);
    vi.mocked(assertWorkspaceMembership).mockResolvedValue(undefined);
    vi.mocked(resolveExecutionProfile).mockResolvedValue(profile());
    vi.mocked(executeToolCall).mockResolvedValue({ ok: true, status: 200, output: '{"ok":true}', durationMs: 7 });
  });

  it("executes a granted tool through the shared tool executor", async () => {
    const result = await invokeDevTool({
      accessToken,
      userId,
      toolSlug: "shell.exec",
      request: {
        agentId,
        workspaceId,
        input: { path: "package.json" },
      },
    });

    expect(result).toMatchObject({
      agentId,
      workspaceId,
      toolId,
      toolSlug: "shell.exec",
      executionProfile: {
        runnerKind: "local_model_coding",
        provider: "local",
        model: "qwen",
        missing: [],
      },
      observation: {
        status: "completed",
        commandActions: ["unknown"],
        arguments: { path: "package.json" },
        result: { ok: true, status: 200, output: '{"ok":true}' },
      },
    });
    expect(resolveExecutionProfile).toHaveBeenCalledWith({
      accessToken,
      requesterUserId: userId,
      agentId,
      skipCredentialCheck: true,
    });
    expect(executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^dev-/),
        function: expect.objectContaining({
          name: "shell_exec",
          arguments: JSON.stringify({ path: "package.json" }),
        }),
      }),
      expect.objectContaining({
        id: toolId,
        slug: "shell.exec",
        functionName: "shell_exec",
      }),
      {
        context: expect.objectContaining({
          agentId,
          workspaceId,
          userId,
          workspaceRoot: "/Users/dev/routed-project",
        }),
      },
    );
  });

  it("falls back to the agent tool policy workspace root when the selected route has none", async () => {
    tables.routing_rule_match = [];

    await invokeDevTool({
      accessToken,
      userId,
      toolSlug: "shell.exec",
      request: {
        agentId,
        workspaceId,
        input: { path: "package.json" },
      },
    });

    expect(executeToolCall).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      context: expect.objectContaining({
        workspaceRoot: "/Users/dev/project",
      }),
    });
  });

  it("refuses unknown tools separately from ungranted tools", async () => {
    await expect(
      invokeDevTool({
        accessToken,
        userId,
        toolSlug: "scheduled_task.list",
        request: { agentId, workspaceId, input: { query: "needle" } },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "tool_not_found",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("refuses visible tools that are not granted to the agent", async () => {
    tables.agent_tool_grant = [];

    await expect(
      invokeDevTool({
        accessToken,
        userId,
        toolSlug: "shell.exec",
        request: { agentId, workspaceId, input: { path: "package.json" } },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "tool_not_granted",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("maps executor argument failures to tool_input_invalid", async () => {
    vi.mocked(executeToolCall).mockResolvedValue({
      ok: false,
      status: 400,
      durationMs: 3,
      output: JSON.stringify({ error: { code: "invalid_tool_arguments", message: "path is required" } }),
    });

    await expect(
      invokeDevTool({
        accessToken,
        userId,
        toolSlug: "shell.exec",
        request: { agentId, workspaceId, input: {} },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "tool_input_invalid",
      details: expect.objectContaining({
        observation: expect.objectContaining({
          status: "failed",
          errorCode: "invalid_tool_arguments",
        }),
      }),
    });
  });

  it("maps non-input executor failures to tool_execution_failed", async () => {
    vi.mocked(executeToolCall).mockResolvedValue({
      ok: false,
      status: 501,
      durationMs: 3,
      output: JSON.stringify({
        error: {
          code: "unsupported_tool_execution_transport",
          message: "Tool execution is not configured",
        },
      }),
    });

    await expect(
      invokeDevTool({
        accessToken,
        userId,
        toolSlug: "shell.exec",
        request: { agentId, workspaceId, input: { path: "package.json" } },
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "tool_execution_failed",
      details: expect.objectContaining({
        observation: expect.objectContaining({
          status: "failed",
          errorCode: "unsupported_tool_execution_transport",
        }),
      }),
    });
  });
});
