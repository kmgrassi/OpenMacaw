import { LocalCodingToolSlugSchema } from "../../../../contracts/local-model-coding.js";
import { resolveAgentToolGrants, type GrantResolverToolRow } from "./agent-tool-grant-resolver.js";
import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ApiSupabaseClient } from "../supabase-client.js";
import { MEMORY_TOOLS } from "./learning/memory-tool.js";

export type LocalChatToolResolution = {
  tools: ToolDefinition[];
  rejectedLocalCodingTools: ToolDefinition[];
};

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function examples(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toolDefinitionFromRow(tool: GrantResolverToolRow): ToolDefinition {
  const name = nullableString(tool.name) ?? nullableString(tool.slug) ?? tool.id;
  const slug = nullableString(tool.slug) ?? name;
  const functionName = nullableString(tool.function_name) ?? slug;

  return {
    id: tool.id,
    slug,
    name,
    functionName,
    description: nullableString(tool.description) ?? "",
    parameters: asJsonObject(tool.parameters),
    examples: examples(tool.examples),
    executionKind: nullableString(tool.execution_kind),
    runnerKind: nullableString(tool.runner_kind) ?? nullableString(tool.type),
    enabled: true,
  };
}

function isLocalModelCodingTool(tool: ToolDefinition): boolean {
  return tool.runnerKind === "local_model_coding" || LocalCodingToolSlugSchema.safeParse(tool.slug).success;
}

export async function getLocalChatToolResolutionForAgent(input: {
  agentId: string;
  workspaceId: string;
  supabase: ApiSupabaseClient;
}): Promise<LocalChatToolResolution> {
  const resolution = await resolveAgentToolGrants(input);

  const resolvedTools = resolution.resolvedTools
    .filter((resolvedTool) => resolvedTool.enabledForAgent)
    .map((resolvedTool) => toolDefinitionFromRow(resolvedTool.tool));
  const tools = [...resolvedTools, ...MEMORY_TOOLS];

  return {
    tools: tools.filter((tool) => !isLocalModelCodingTool(tool)),
    rejectedLocalCodingTools: tools.filter((tool) => isLocalModelCodingTool(tool)),
  };
}

export async function getLocalChatToolsForAgent(input: {
  agentId: string;
  workspaceId: string;
  supabase: ApiSupabaseClient;
}): Promise<ToolDefinition[]> {
  const resolution = await getLocalChatToolResolutionForAgent(input);
  return resolution.tools;
}
