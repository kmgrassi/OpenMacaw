import type { ToolDefinition } from "../tool-spec-translator.js";

export const MEMORY_SEARCH_TOOL_ID = "11111111-1111-4111-8111-111111111111";
export const MEMORY_SEARCH_TOOL_SLUG = "memory.search";
export const MEMORY_CREATE_TOOL_ID = "22222222-2222-4222-8222-222222222222";
export const MEMORY_CREATE_TOOL_SLUG = "memory.create";

export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  id: MEMORY_SEARCH_TOOL_ID,
  slug: MEMORY_SEARCH_TOOL_SLUG,
  name: "Search memory",
  functionName: "memory_search",
  description:
    "Search workspace memory from prior agent runs for historical context, prior decisions, recurring failures, or known gotchas.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Natural language memory search query.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "agent"],
        description: "Visibility scope for matching memories.",
      },
      importance_min: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Minimum memory importance from 1 to 10.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of memories to return.",
      },
    },
    required: ["query"],
  },
  executionKind: "database",
  runnerKind: null,
  enabled: true,
};

export const MEMORY_CREATE_TOOL: ToolDefinition = {
  id: MEMORY_CREATE_TOOL_ID,
  slug: MEMORY_CREATE_TOOL_SLUG,
  name: "Create memory",
  functionName: "memory_create",
  description:
    "Save a durable memory for future agent runs when you learn a stable fact, decision, preference, or recurring gotcha.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        description: "The durable fact, decision, preference, or gotcha to remember.",
      },
      visibility: {
        type: "string",
        enum: ["agent", "workspace"],
        description: "Use agent for this agent's private memory, or workspace for memory useful to all agents.",
      },
      scope: {
        type: "string",
        enum: ["long_term", "daily", "project", "run_summary", "scratch"],
        description: "Memory category. Defaults to long_term.",
      },
      tags: {
        type: "object",
        additionalProperties: true,
        description: "Optional structured tags for filtering or provenance.",
      },
      importance: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Importance from 1 to 10. Defaults to 5.",
      },
      event_time: {
        type: "string",
        format: "date-time",
        description: "Optional ISO timestamp for when the remembered event happened.",
      },
      source_task_id: {
        type: "string",
        description: "Optional source task identifier.",
      },
      source_path: {
        type: "string",
        description: "Optional source file path or external path.",
      },
      canonical_id: {
        type: "string",
        format: "uuid",
        description: "Optional canonical memory UUID this memory belongs to.",
      },
      supersedes_id: {
        type: "string",
        format: "uuid",
        description: "Optional memory UUID superseded by this memory.",
      },
    },
    required: ["content"],
  },
  executionKind: "database",
  runnerKind: null,
  enabled: true,
};

export const MEMORY_TOOLS = [MEMORY_CREATE_TOOL, MEMORY_SEARCH_TOOL] as const;
