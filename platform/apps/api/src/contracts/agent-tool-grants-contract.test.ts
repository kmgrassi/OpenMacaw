import { describe, expect, it } from "vitest";

import {
  AgentToolGrantResolvedToolSchema,
  AgentToolGrantSchema,
  ToolPolicyTemplateSchema,
  ToolPolicyTemplateToolSchema,
} from "../../../../contracts/agent-tool-grants.js";

const toolId = "66666666-6666-4666-8666-666666666666";
const agentId = "77777777-7777-4777-8777-777777777777";
const templateId = "88888888-8888-4888-8888-888888888888";
const workspaceId = "99999999-9999-4999-8999-999999999999";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("agent tool grant contract", () => {
  it("parses tool policy templates", () => {
    const parsed = ToolPolicyTemplateSchema.parse({
      id: templateId,
      workspaceId: null,
      slug: "coding",
      name: "Coding",
      description: "Repository read and planning tools.",
      systemManaged: true,
      enabled: true,
    });

    expect(parsed.slug).toBe("coding");
    expect(parsed.systemManaged).toBe(true);
  });

  it("parses tool policy template membership", () => {
    const parsed = ToolPolicyTemplateToolSchema.parse({
      templateId,
      toolId,
    });

    expect(parsed.templateId).toBe(templateId);
    expect(parsed.toolId).toBe(toolId);
  });

  it("parses explicit agent tool grants", () => {
    const parsed = AgentToolGrantSchema.parse({
      agentId,
      toolId,
      workspaceId,
      mode: "exclude",
      source: "manual",
      sourceToolTemplateId: null,
      reason: null,
      createdByUserId: userId,
    });

    expect(parsed.mode).toBe("exclude");
    expect(parsed.source).toBe("manual");
  });

  it("parses grant-backed resolved tools", () => {
    const parsed = AgentToolGrantResolvedToolSchema.parse({
      id: toolId,
      workspaceId,
      slug: "shell.exec",
      name: "Read File",
      description: "Read a file within the workspace.",
      parameters: {},
      examples: [],
      executionKind: "filesystem_read",
      runnerKind: "local_relay",
      enabled: true,
      enabledForAgent: true,
      grant: {
        agentId,
        toolId,
        workspaceId,
        mode: "include",
        source: "template",
        sourceToolTemplateId: templateId,
        reason: "Applied coding template",
        createdByUserId: userId,
      },
    });

    expect(parsed.enabledForAgent).toBe(true);
    expect(parsed.grant?.sourceToolTemplateId).toBe(templateId);
  });
});
