import { describe, expect, it } from "vitest";

import {
  AgentToolGrantSchema,
  AnthropicToolSpecSchema,
  GenericProviderToolSpecSchema,
  GenericToolSpecSchema,
  OpenAIToolSpecSchema,
  ProviderToolSpecSchema,
  ToolDefinitionSchema,
  ToolPolicyTemplateSchema,
  ResolvedAgentToolSchema,
} from "../../../../contracts/tool-definition.js";

const toolId = "66666666-6666-4666-8666-666666666666";
const agentId = "77777777-7777-4777-8777-777777777777";
const templateId = "88888888-8888-4888-8888-888888888888";
const grantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "99999999-9999-4999-8999-999999999999";

describe("tool definition contract", () => {
  it("parses a workspace-level tool definition", () => {
    const parsed = ToolDefinitionSchema.parse({
      id: toolId,
      workspaceId: null,
      slug: "read_file",
      name: "read_file",
      description: "Read a file within the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      examples: [{ input: { path: "README.md" }, note: "Use repository-relative paths." }],
      executionKind: "filesystem_read",
      runnerKind: "local_relay",
      enabled: true,
    });

    expect(parsed.slug).toBe("read_file");
    expect(parsed.executionKind).toBe("filesystem_read");
    expect(parsed.examples).toEqual([{ input: { path: "README.md" }, note: "Use repository-relative paths." }]);
    expect(parsed.enabled).toBe(true);
  });

  it("rejects blank slugs", () => {
    expect(() =>
      ToolDefinitionSchema.parse({
        id: toolId,
        workspaceId: null,
        slug: "",
        name: "Read File",
        description: "",
        parameters: {},
        examples: [],
        executionKind: null,
        runnerKind: null,
        enabled: true,
      }),
    ).toThrow();
  });

  it("defines OpenAI, Anthropic, and generic provider tool specs", () => {
    const openAiSpec = OpenAIToolSpecSchema.parse({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      },
    });
    const anthropicSpec = AnthropicToolSpecSchema.parse({
      name: "read_file",
      description: "Read a file.",
      input_schema: { type: "object" },
    });
    const genericSpec = GenericProviderToolSpecSchema.parse(
      ProviderToolSpecSchema.parse({
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object" },
      }),
    );
    const genericAliasSpec = GenericToolSpecSchema.parse({
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object" },
    });

    expect(openAiSpec.type).toBe("function");
    expect(anthropicSpec.input_schema.type).toBe("object");
    expect(genericSpec.parameters.type).toBe("object");
    expect(genericAliasSpec.parameters.type).toBe("object");
  });

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

  it("parses resolved tools with grant provenance", () => {
    const parsed = ResolvedAgentToolSchema.parse({
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
      source: "template",
    });

    expect(parsed.enabledForAgent).toBe(true);
    expect(parsed.source).toBe("template");
  });

  it("parses explicit agent tool grants", () => {
    const parsed = AgentToolGrantSchema.parse({
      id: grantId,
      agentId,
      toolId,
      workspaceId,
      mode: "exclude",
      source: "manual",
      sourceToolTemplateId: null,
      reason: null,
      createdByUserId: null,
    });

    expect(parsed.mode).toBe("exclude");
  });
});
