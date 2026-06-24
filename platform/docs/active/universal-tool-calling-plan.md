# Universal Tool Calling — Platform Scoping Document

## Overview

This document scopes the platform-side work required to support universal tool calling across all model providers (GPT, Claude, local Ollama/Qwen, etc.). The platform is responsible for storing model-agnostic tool definitions, exposing CRUD APIs for them, and providing a settings UI.

Historical note: the direct `/local-chat` HTTP helper path is legacy/dev-only. It can remain useful as a direct local model harness, but it is not the Coding Agent local model tool path. Coding Agent local model tools run through runtime dispatch and the registered `local-runtime-helper` relay.

## Current State

- **Execution profiles** (`contracts/execution-profile.ts`) define a `ToolProfile` enum (`planning | coding | manager | none`) and a `capabilities.toolCalls` boolean, but there is no model-agnostic tool definition schema.
- **Local-chat proxy** (`apps/api/src/routes/local-model-proxy.ts`) is a legacy/dev-only single-turn request-response passthrough to a local OpenAI-compatible endpoint. It forwards `messages` and returns the response with no tool-call handling. It is not the Coding Agent local model tool path.
- **Runner kinds** (`contracts/runner-kinds.ts`) include `local_runtime` and `local_relay` for local execution, but neither carries tool specifications in the dispatch payload.
- **Database schema already exists** — The `tool` table stores definitions (name, slug, description, function_name, parameters JSON Schema). The `agent_tool` join table assigns tools to agents. The `tool_call` table records executions linked to messages. Harper-server PR #495 extended `tool` with `execution_kind`, `runner_kind`, `enabled` columns and seeded 21 tools from the runtime codebase.

## Architecture — Tool Calling Flow

```
User sends message to agent
  |
  v
Platform resolves ExecutionProfile + ToolDefinitions for agent
  |
  v
Platform builds provider-formatted tool specs
  (OpenAI function_calling format for local-chat proxy,
   or passes model-agnostic specs to runtime for relay dispatch)
  |
  v
Platform sends prompt + tools to model (legacy local-chat harness) or runtime (relay)
  |
  v
Model responds with tool_call(s) or final text
  |
  +--[tool_call]--> Platform dispatches tool execution
  |                   - legacy local-chat: execute via dev-only HTTP helper
  |                   - relay: runtime handles via registered local-runtime-helper
  |                 Tool result appended to messages
  |                 Loop back to model
  |
  +--[final text]--> Return response to user
```

## Database Schema (Already Exists)

The tool infrastructure uses three existing tables (no new migration needed):

### `tool` table (extended in harper-server PR #495)

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `name` | text | Human-readable name |
| `slug` | text | Unique identifier (e.g., `shell.exec`) |
| `function_name` | text | Function name for API calls |
| `description` | text | What the tool does |
| `parameters` | jsonb | JSON Schema for input parameters |
| `type` | text | Category (database, filesystem, platform, etc.) |
| `execution_kind` | text | How to execute: api, database, filesystem, shell, graphql |
| `runner_kind` | text | Which runner owns this: codex, planner, manager, local_runtime |
| `enabled` | boolean | Soft toggle |

### `agent_tool` table (join)

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `agent_id` | uuid | FK → agent |
| `tool_id` | uuid | FK → tool |

### `tool_call` table (execution log)

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `tool_id` | uuid | FK → tool |
| `message_id` | uuid | FK → message (links to conversation history) |
| `input` | text | Tool call arguments |
| `output` | text | Tool execution result |

**21 tools are already seeded** (see harper-server PR #495): coding (1),
database (5), repository (4), planning profile (2), agent communication (2),
manager (8).

## PR Plan

### PR1: Tool Definition Contracts and Agent Tool Resolution

**Branch:** `feat/tool-definition-schema`

**Files:**
- `contracts/tool-definition.ts` — Zod schemas for `ToolDefinition`, `ProviderToolSpec`
- `contracts/execution-profile.ts` — Add optional `toolDefinitions: ToolDefinition[]` to `ExecutionProfile`
- `apps/api/src/services/agent-tools.ts` — Load tool definitions for an agent from `tool` + `agent_tool` tables

**Contract types:**

```typescript
// contracts/tool-definition.ts — maps to public.tool table

export const ToolDefinitionSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),  // JSON Schema
  executionKind: z.string().nullable(),
  runnerKind: z.string().nullable(),
  enabled: z.boolean(),
});

// Provider-specific tool format (output of translation)
export const OpenAIToolSpecSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()),
  }),
});

export const AnthropicToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
});
```

**Agent tool resolution** (uses existing `tool` + `agent_tool` tables):

```typescript
// apps/api/src/services/agent-tools.ts
async function getToolsForAgent(agentId: string): Promise<ToolDefinition[]> {
  // Query agent_tool join → tool table
  // Filter by tool.enabled = true
  // Return tool definitions with parameters JSON Schema
}
```

**No new DB migration needed** — uses existing tables extended by
harper-server PR #495.

**Acceptance criteria:**
- [ ] Contract types match the `tool` table shape
- [ ] `getToolsForAgent` loads tools from DB via `agent_tool` join
- [ ] Provider-specific translation types defined (OpenAI, Anthropic, generic)
- [ ] `ToolProfile` in execution profile can coexist with explicit tool definitions

**Sequencing:** No dependencies. Can start immediately.

---

### PR2: Tool Definition API

**Branch:** `feat/tool-definition-api`

**Files:**
- `apps/api/src/routes/agent-tools.ts` — CRUD endpoints
- `apps/api/src/services/agent-tools.ts` — Business logic + Supabase queries
- `apps/api/src/services/agent-tools.test.ts` — Unit tests

**Endpoints:**

```
GET    /api/agents/:agentId/tools           — List tools assigned to this agent (via agent_tool join)
POST   /api/agents/:agentId/tools           — Assign a tool to this agent (creates agent_tool row)
DELETE /api/agents/:agentId/tools/:toolId   — Unassign a tool from this agent
GET    /api/tools                           — List all available tools in the workspace
POST   /api/tools                           — Create a new custom tool definition
PUT    /api/tools/:toolId                   — Update a tool definition
DELETE /api/tools/:toolId                   — Delete a tool definition
```

**Two-level model:** Tools are workspace-level resources (in `tool` table).
Agents reference them via `agent_tool` join. This means:
- Same tool can be assigned to multiple agents
- Tool definitions are shared, not duplicated per agent
- The 21 seeded tools are available to all agents

**Acceptance criteria:**
- [ ] Agent tool assignment creates/removes `agent_tool` rows
- [ ] Tool CRUD operates on the `tool` table
- [ ] Tool slug uniqueness enforced (via DB constraint)
- [ ] `parameters` validated as valid JSON Schema
- [ ] Tests cover happy path + error cases

**Sequencing:** Depends on PR1 (schema).

---

### PR3: Tool Definition UI

**Branch:** `feat/tool-definition-ui`

**Files:**
- `apps/web/src/components/agent-settings/ToolDefinitionsPanel.tsx` — Main panel
- `apps/web/src/components/agent-settings/ToolDefinitionEditor.tsx` — Add/edit form
- `apps/web/src/components/agent-settings/ToolDefinitionList.tsx` — Sortable list
- `apps/web/src/hooks/useToolDefinitions.ts` — API hooks (React Query)

**UI components:**

1. **Tool list** — Shows defined tools with name, description, execution kind, enabled toggle
2. **Add/edit form** — Name, description, JSON Schema editor for parameters, execution kind selector, execution config form
3. **Preset templates** — Quick-add common tools (read_file, write_file, run_command, git_status)
4. **Drag-and-drop reorder** — Priority ordering for tool presentation to model

**Acceptance criteria:**
- [ ] Agent settings page has a "Tools" tab
- [ ] Users can create, edit, delete, enable/disable, and reorder tools
- [ ] JSON Schema editor validates input and shows errors
- [ ] Preset templates populate form with sensible defaults
- [ ] Changes persist via API and reflect immediately in UI

**Sequencing:** Depends on PR2 (API).

---

### PR4: Legacy Tool Calling in Local-Chat Proxy

**Branch:** `feat/local-chat-tool-calling`

**Status note:** This is a legacy/dev-only direct local-chat harness scope, not the Coding Agent `local_model_coding` path. New Coding Agent local model tool work should target runtime relay dispatch and registered local-runtime-helper state instead.

**Files:**
- `apps/api/src/routes/local-model-proxy.ts` — Extend with multi-turn tool loop
- `apps/api/src/services/tool-spec-translator.ts` — Translate model-agnostic definitions to provider format
- `apps/api/src/services/tool-spec-translator.test.ts` — Tests
- `apps/api/src/services/tool-call-parser.ts` — Parse tool calls from model response (native + prompt-based fallback)
- `apps/api/src/services/tool-call-parser.test.ts` — Tests
- `apps/api/src/services/tool-execution-client.ts` — HTTP client to dispatch tool execution to helper daemon

**Multi-turn loop (pseudocode):**

```typescript
async function chatWithTools(endpoint, model, messages, tools, maxIterations = 10) {
  let iteration = 0;
  const conversationMessages = [...messages];

  while (iteration < maxIterations) {
    const response = await callModel(endpoint, model, conversationMessages, tools);

    if (!hasToolCalls(response)) {
      return response; // Final text response
    }

    for (const toolCall of extractToolCalls(response)) {
      const result = await executeToolLocally(toolCall);
      conversationMessages.push(
        { role: 'assistant', tool_calls: [toolCall] },
        { role: 'tool', tool_call_id: toolCall.id, content: result }
      );
    }

    iteration++;
  }

  throw new Error('Tool calling loop exceeded max iterations');
}
```

**Prompt-based fallback for models without native tool support:**

```typescript
function buildToolUseSystemPrompt(tools: ToolDefinition[]): string {
  return `You have access to the following tools. To use a tool, respond with a JSON block:
\`\`\`json
{"tool_call": {"name": "tool_name", "arguments": {...}}}
\`\`\`

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parametersSchema)}`).join('\n')}

When you have finished using tools and are ready to respond to the user, respond normally without a JSON tool_call block.`;
}
```

**Detection logic:**

```typescript
function supportsNativeToolCalling(provider: string, model: string): boolean {
  // OpenAI models, Claude, and some local models support native tool calling
  // Check capabilities.toolCalls from execution profile
  // Fallback: try with tools, if 400 error, retry with prompt-based
}
```

**Acceptance criteria:**
- [ ] Local-chat proxy resolves tool definitions for the agent
- [ ] Tool specs translated to OpenAI function_calling format for OpenAI-compatible endpoints
- [ ] Multi-turn loop continues until model responds without tool calls or max iterations reached
- [ ] Tool execution dispatched to the legacy/dev-only HTTP helper
- [ ] Prompt-based fallback works for models that don't support native tool calling
- [ ] Each tool call logged with: model, tool name, arguments, result, duration
- [ ] Timeout per tool execution (configurable, default 30s)
- [ ] Streaming support maintained through tool-calling loop

**Sequencing:** Depends on PR1 (schema) and PR2 (API). Can be developed in parallel with PR3 (UI).

---

## Sequencing Diagram

```
PR1: Tool Definition Schema ──────────────────────┐
                                                   |
                                    ┌──────────────┤
                                    v              v
                            PR2: Tool API    PR4: Local-Chat
                                    |         Tool Calling
                                    v              |
                            PR3: Tool UI           |
                                    |              |
                                    v              v
                              [UI Complete]   [Tool Loop Complete]
```

## Cross-Cutting Concerns

### Tool definition format compatibility

The `tool` table schema is intentionally model-agnostic. Translation happens at call time:
- **OpenAI-compatible** (GPT, Ollama with tool support): `{ type: "function", function: { name, description, parameters } }`
- **Anthropic** (Claude): `{ name, description, input_schema }`
- **Prompt-based fallback**: System prompt injection with JSON response parsing

### Coordination with runtime

The runtime currently resolves tools via `ToolPolicy` and `DynamicTool` in Elixir. For relay-dispatched agents, including Coding Agent local models, the platform will include tool definitions in the dispatch payload so the runtime can forward them to the registered `local-runtime-helper` relay. The runtime scoping doc covers the relay-side loop.

### Coordination with helper

The legacy direct-local-chat helper path uses a dev-only HTTP tool execution endpoint. The Go `local-runtime-helper` is relay-based and should not be expected to expose the legacy HTTP helper port. The helper scoping doc covers the relay executor framework for runtime-dispatched local model tools.

### Error handling

| Error | Handling |
|-------|----------|
| Model returns invalid tool name | Return error message as tool result, let model self-correct |
| Tool execution fails | Return error as tool result, let model decide next step |
| Max iterations exceeded | Return partial response with warning |
| Legacy HTTP helper offline | Return 503 with clear error message for direct local-chat harness requests |
| Model doesn't support tools | Fall back to prompt-based tool use |

### Observability

Every tool call will be logged with structured fields:
```typescript
{
  agent_id, model, provider, tool_name, tool_arguments,
  tool_result_success, tool_result_size_bytes, duration_ms,
  iteration_number, is_prompt_based_fallback
}
```
