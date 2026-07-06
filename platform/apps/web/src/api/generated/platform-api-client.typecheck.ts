import {
  createToolDefinition,
  listTools,
  upsertAgentToolGrant,
  updateToolDefinition,
} from "./platform-api-client";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const toolId = "44444444-4444-4444-8444-444444444444";
const agentId = "33333333-3333-4333-8333-333333333333";

void listTools({ workspaceId });

// @ts-expect-error workspaceId is required for tool listing.
void listTools({});

void createToolDefinition({
  workspaceId,
  slug: "read_file",
  name: "Read File",
  description: "Read a file",
  parameters: { type: "object" },
  executionKind: "filesystem_read",
  runnerKind: "local_relay",
});

// @ts-expect-error workspaceId is required for tool creation.
void createToolDefinition({
  slug: "read_file",
  name: "Read File",
});

void updateToolDefinition(toolId, {
  workspaceId,
  name: "Read File",
});

// @ts-expect-error workspaceId is required for tool updates.
void updateToolDefinition(toolId, {
  name: "Read File",
});

void upsertAgentToolGrant(agentId, toolId, { workspaceId, mode: "include" });

// @ts-expect-error workspaceId is required for tool grant updates.
void upsertAgentToolGrant(agentId, toolId, { mode: "include" });
