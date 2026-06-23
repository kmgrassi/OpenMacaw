import { describe, expect, it } from "vitest";

import {
  buildToolUseSystemPrompt,
  toAnthropicToolSpec,
  toGenericToolSpec,
  toOpenAIToolSpec,
  toOpenAIToolSpecs,
  toolFunctionName,
  toolsByProviderFunctionName,
  type ToolDefinition,
} from "./tool-spec-translator.js";

const tool: ToolDefinition = {
  id: "tool-1",
  slug: "shell.exec",
  name: "Read file",
  functionName: "shell_exec",
  description: "Read a file from the workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  executionKind: "filesystem",
  runnerKind: "local_relay",
  enabled: true,
};

describe("tool spec translator", () => {
  it("translates model-agnostic definitions to OpenAI tool specs", () => {
    expect(toOpenAIToolSpec(tool)).toEqual({
      type: "function",
      function: {
        name: "shell_exec",
        description: "Read a file from the workspace",
        parameters: tool.parameters,
      },
    });
  });

  it("translates model-agnostic definitions to Anthropic and generic specs", () => {
    expect(toAnthropicToolSpec(tool)).toEqual({
      name: "shell_exec",
      description: "Read a file from the workspace",
      input_schema: tool.parameters,
    });
    expect(toGenericToolSpec(tool)).toEqual({
      name: "shell_exec",
      description: "Read a file from the workspace",
      parameters: tool.parameters,
    });
  });

  it("adds tool examples to model-facing descriptions", () => {
    const exampleTool = {
      ...tool,
      examples: [{ input: { path: "README.md" }, note: "Use repository-relative paths." }],
    };

    expect(toOpenAIToolSpec(exampleTool).function.description).toContain("Examples / usage guidance:");
    expect(toOpenAIToolSpec(exampleTool).function.description).toContain("README.md");
    expect(toAnthropicToolSpec(exampleTool).description).toContain("README.md");
    expect(toGenericToolSpec(exampleTool).description).toContain("README.md");
  });

  it("omits disabled tools from OpenAI tool spec batches", () => {
    expect(toOpenAIToolSpecs([{ ...tool, enabled: false }])).toEqual([]);
  });

  it("sanitizes function names for provider compatibility", () => {
    expect(toolFunctionName({ functionName: "", slug: "repo.read-file", name: "Read file" })).toBe("repo_read-file");
    expect(toolFunctionName({ functionName: "", slug: "1-invalid", name: "Read file" })).toBe("tool_1-invalid");
  });

  it("maps provider-safe function names back to canonical tool definitions", () => {
    const shellTool: ToolDefinition = {
      ...tool,
      id: "tool-shell",
      slug: "shell.exec",
      name: "Shell Exec",
      functionName: "shell_exec",
      executionKind: "shell",
      runnerKind: "local_model_coding",
      parameters: {
        type: "object",
        required: ["argv"],
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
      },
    };

    const byName = toolsByProviderFunctionName([shellTool]);

    expect(byName.get("shell_exec")).toMatchObject({
      slug: "shell.exec",
      functionName: "shell_exec",
      parameters: expect.objectContaining({ required: ["argv"] }),
    });
  });

  it("builds a prompt fallback with tool schema details", () => {
    const prompt = buildToolUseSystemPrompt([tool]);
    expect(prompt).toContain("shell_exec");
    expect(prompt).toContain('"tool_call"');
    expect(prompt).toContain('"path"');
  });
});
