import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformApiContracts } from "../../../../contracts/platform-api-contracts.js";
import {
  appendToolExamples,
  applyToolPolicyTemplateToAgent,
  createTool,
  deleteAgentToolGrant,
  getAgentToolSettings,
  listTools,
  setAgentToolGrant,
} from "../services/agent-tools.js";
import { getAgentPolicySettings } from "../services/policy-resolver.js";
import { findSetupAgentById } from "../repositories/agents.js";
import { registerAgentToolRoutes } from "./agent-tools.js";

vi.mock("../services/agent-tools.js", () => ({
  appendToolExamples: vi.fn(),
  applyToolPolicyTemplateToAgent: vi.fn(),
  createTool: vi.fn(),
  deleteAgentToolGrant: vi.fn(),
  deleteTool: vi.fn(),
  getAgentToolSettings: vi.fn(),
  getResolvedToolsForAgent: vi.fn(),
  getToolsForAgent: vi.fn(),
  listTools: vi.fn(),
  setAgentToolGrant: vi.fn(),
  updateTool: vi.fn(),
}));
vi.mock("../services/policy-resolver.js", () => ({
  getAgentPolicySettings: vi.fn(),
}));
vi.mock("../repositories/agents.js", () => ({
  findSetupAgentById: vi.fn(),
}));
vi.mock("../supabase-client.js", () => ({
  getUserScopedSupabase: vi.fn(() => ({ from: vi.fn() })),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const toolId = "44444444-4444-4444-8444-444444444444";

const responseTool = {
  id: toolId,
  workspaceId: null,
  slug: "read_file",
  name: "Read File",
  description: "Read a file",
  parameters: { type: "object" },
  examples: [],
  executionKind: "filesystem_read",
  runnerKind: "local_relay",
  enabled: true,
};
const responseResolvedTool = {
  ...responseTool,
  source: "include" as const,
  enabledForAgent: true,
};
const templateId = "55555555-5555-4555-8555-555555555555";
const responseTemplate = {
  id: templateId,
  workspaceId: null,
  slug: "coding",
  name: "Coding",
  description: "Coding tools",
  systemManaged: true,
  enabled: true,
};
const responseGrant = {
  id: "66666666-6666-4666-8666-666666666666",
  agentId,
  toolId,
  workspaceId,
  mode: "include" as const,
  source: "manual" as const,
  sourceToolTemplateId: null,
  reason: null,
  createdByUserId: userId,
};
const responseToolSettings = {
  templates: [responseTemplate],
  availableTools: [responseTool],
  grants: [responseGrant],
  tools: [responseResolvedTool],
};
const responsePolicySettings = {
  availableKinds: [
    {
      kind: "block_tools" as const,
      paramsSchema: {
        type: "object",
        required: ["tools"],
        properties: { tools: { type: "array", items: { type: "string" }, minItems: 1 } },
        additionalProperties: false,
      },
    },
  ],
  workspacePolicies: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId,
      scope: "workspace" as const,
      agentId: null,
      sessionThreadId: null,
      kind: "block_tools" as const,
      params: { kind: "block_tools" as const, tools: ["shell.exec"] },
      priority: 10,
      enabled: true,
      source: "manual" as const,
      reason: null,
      createdByUserId: userId,
      createdAt: "2026-06-30T00:00:00.000Z",
    },
  ],
  agentPolicies: [],
  sessionPolicies: [],
  effectivePolicies: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId,
      scope: "workspace" as const,
      agentId: null,
      sessionThreadId: null,
      kind: "block_tools" as const,
      params: { kind: "block_tools" as const, tools: ["shell.exec"] },
      priority: 10,
      source: "manual" as const,
      reason: null,
    },
  ],
};

type ExpressRouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function registeredExpressRoutes(app: express.Express) {
  const stack = (app as { _router?: { stack?: ExpressRouteLayer[] } })._router?.stack ?? [];

  return stack
    .flatMap((layer) => {
      if (!layer.route) {
        return [];
      }

      return Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({
          method: method.toUpperCase(),
          path: layer.route?.path ?? "",
        }));
    })
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

describe("agent tool routes", () => {
  let app: express.Express;
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    vi.restoreAllMocks();
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = userId;
      }
      next();
    });
    registerAgentToolRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("registers the tool routes declared in the Platform API contract registry", () => {
    const contractRoutes = Object.values(PlatformApiContracts)
      .filter(
        (contract) =>
          contract.path.includes("/tools") || contract.path.includes("/tool-") || contract.path.endsWith("/policies"),
      )
      .map((contract) => ({
        method: contract.method,
        path: contract.path,
      }))
      .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));

    expect(registeredExpressRoutes(app)).toEqual(contractRoutes);
  });

  it("requires auth for agent tool listing", async () => {
    const response = await fetch(`${baseUrl}/api/agents/${agentId}/tools`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("lists tools assigned to an agent", async () => {
    vi.mocked(getAgentToolSettings).mockResolvedValue(responseToolSettings);

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/tools?workspaceId=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseToolSettings);
    expect(getAgentToolSettings).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      workspaceId,
    });
  });

  it("lists policies resolved for an agent", async () => {
    vi.mocked(findSetupAgentById).mockResolvedValue({
      id: agentId,
      workspace_id: workspaceId,
      name: "Coding agent",
      status: "active",
      type: "coding",
      context: null,
      model_settings: {},
      tool_policy: {},
      created_by_user_id: userId,
      updated_at: "2026-06-30T00:00:00.000Z",
    });
    vi.mocked(getAgentPolicySettings).mockResolvedValue(responsePolicySettings);

    const response = await fetch(
      `${baseUrl}/api/agents/${agentId}/policies?workspaceId=${workspaceId}&sessionThreadId=session-thread-1`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responsePolicySettings);
    expect(getAgentPolicySettings).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      sessionThreadId: "session-thread-1",
      supabase: expect.any(Object),
    });
  });

  it("applies a tool policy template", async () => {
    vi.mocked(applyToolPolicyTemplateToAgent).mockResolvedValue(responseToolSettings);

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/tool-templates/${templateId}/apply`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseToolSettings);
    expect(applyToolPolicyTemplateToAgent).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      templateId,
      workspaceId,
    });
  });

  it("upserts a per-agent tool grant", async () => {
    vi.mocked(setAgentToolGrant).mockResolvedValue(responseToolSettings);

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/tool-grants/${toolId}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, mode: "exclude", reason: "No writes" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseToolSettings);
    expect(setAgentToolGrant).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      toolId,
      mode: "exclude",
      reason: "No writes",
      workspaceId,
    });
  });

  it("deletes a per-agent tool grant", async () => {
    vi.mocked(deleteAgentToolGrant).mockResolvedValue(responseToolSettings);

    const response = await fetch(`${baseUrl}/api/agents/${agentId}/tool-grants/${toolId}?workspaceId=${workspaceId}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseToolSettings);
    expect(deleteAgentToolGrant).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      toolId,
      workspaceId,
    });
  });

  it("requires workspace context for available tool listing", async () => {
    const response = await fetch(`${baseUrl}/api/tools`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "workspaceId is required",
      },
    });
  });

  it("lists available tools", async () => {
    vi.mocked(listTools).mockResolvedValue([responseTool]);

    const response = await fetch(`${baseUrl}/api/tools?workspaceId=${workspaceId}`, {
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tools: [responseTool] });
  });

  it("smoke-tests the tool settings read path for assigned and available tools", async () => {
    vi.mocked(getAgentToolSettings).mockResolvedValue(responseToolSettings);
    vi.mocked(listTools).mockResolvedValue([responseTool]);

    const [assignedResponse, availableResponse] = await Promise.all([
      fetch(`${baseUrl}/api/agents/${agentId}/tools?workspaceId=${workspaceId}`, {
        headers: { authorization: "Bearer test-token" },
      }),
      fetch(`${baseUrl}/api/tools?workspaceId=${workspaceId}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    ]);

    expect(assignedResponse.status).toBe(200);
    expect(availableResponse.status).toBe(200);
    await expect(assignedResponse.json()).resolves.toEqual(responseToolSettings);
    await expect(availableResponse.json()).resolves.toEqual({ tools: [responseTool] });
    expect(getAgentToolSettings).toHaveBeenCalledWith({
      accessToken: "test-token",
      userId,
      agentId,
      workspaceId,
    });
    expect(listTools).toHaveBeenCalledWith({ userId, workspaceId });
  });

  it("validates create tool payloads before calling the service", async () => {
    const response = await fetch(`${baseUrl}/api/tools`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId, slug: "", name: "" }),
    });

    expect(response.status).toBe(400);
    expect(createTool).not.toHaveBeenCalled();
  });

  it("creates a custom tool definition", async () => {
    vi.mocked(createTool).mockResolvedValue(responseTool);

    const response = await fetch(`${baseUrl}/api/tools`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        slug: "read_file",
        name: "Read File",
        description: "Read a file",
        parameters: { type: "object" },
        executionKind: "filesystem_read",
        runnerKind: "local_relay",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ tool: responseTool });
  });

  it("appends examples to a tool definition by id", async () => {
    const updatedTool = {
      ...responseTool,
      examples: [{ input: { path: "README.md" }, note: "Use repository-relative paths." }],
    };
    vi.mocked(appendToolExamples).mockResolvedValue(updatedTool);

    const response = await fetch(`${baseUrl}/api/tools/${toolId}/examples`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        example: { input: { path: "README.md" }, note: "Use repository-relative paths." },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tool: updatedTool });
    expect(appendToolExamples).toHaveBeenCalledWith({
      userId,
      toolId,
      request: {
        workspaceId,
        examples: [{ input: { path: "README.md" }, note: "Use repository-relative paths." }],
      },
    });
  });

  it("appends examples to a tool definition by slug", async () => {
    const updatedTool = {
      ...responseTool,
      examples: [{ input: { path: "package.json" } }],
    };
    vi.mocked(appendToolExamples).mockResolvedValue(updatedTool);

    const response = await fetch(`${baseUrl}/api/tools/slug/read_file/examples`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId,
        examples: [{ input: { path: "package.json" } }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tool: updatedTool });
    expect(appendToolExamples).toHaveBeenCalledWith({
      userId,
      slug: "read_file",
      request: {
        workspaceId,
        examples: [{ input: { path: "package.json" } }],
      },
    });
  });
});
