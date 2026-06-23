#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import type { Tables } from "@kmgrassi/supabase-schema";

import { AgentTypeSchema, ToolPolicySchema, type AgentType, type ToolPolicy } from "../../../contracts/agents.js";
import { RunnerKindSchema, KnownExecutionProviderSchema } from "../../../contracts/execution-profile.js";
import {
  AGENT_TOOL_GRANT_SELECT,
  listAgentToolGrantRows,
  listVisibleToolRows,
  serviceRoleDb,
} from "../src/repositories/agent-tools.js";
import { ensureDefaultAgentToolsForAgent } from "../src/services/default-agent-tools.js";
import {
  DEFAULT_PLANNING_TOOL_SLUGS,
  DEFAULT_MANAGER_TOOL_SLUGS,
  GIT_COMMAND_TOOL_SLUG,
  SCHEDULED_TASK_TOOL_SLUGS,
} from "../src/services/tool-bundles.js";
import { executeSupabaseRows, getServiceRoleSupabase, normalizeSupabaseError } from "../src/supabase-client.js";

type CliCommand = "seed" | "reset";
type JsonRecord = Record<string, unknown>;

type AgentRow = Pick<
  Tables<"agent">,
  "id" | "workspace_id" | "name" | "type" | "model_settings" | "tool_policy" | "session_id"
>;
type WorkspaceRow = Pick<Tables<"workspaces">, "id" | "owner_user_id">;
type GatewayConfigRow = Pick<Tables<"gateway_config">, "id" | "scope_id" | "scope_type" | "version" | "config_json">;
type MessageRow = Pick<Tables<"message">, "id">;
type SessionThreadRow = Pick<Tables<"session_thread">, "id">;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const TEST_OWNER = "agent:test-seed";

loadDotenv({ path: path.join(repoRoot, ".env") });
loadDotenv({ path: path.join(repoRoot, "apps/api/.env"), override: false });

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help || !args.command) {
    printUsage();
    return;
  }

  if (args.command === "seed") {
    await seedAgent();
  } else {
    await resetAgent();
  }
}

function parseArgs(argv: string[]) {
  const parsed: {
    command: CliCommand | null;
    help: boolean;
    json: boolean;
    yes: boolean;
    workspaceId: string | null;
    agentId: string | null;
    kind: AgentType;
    name: string | null;
    model: string | null;
    provider: string | null;
    runnerKind: string | null;
    userId: string | null;
  } = {
    command: null,
    help: false,
    json: false,
    yes: false,
    workspaceId: null,
    agentId: null,
    kind: "coding",
    name: null,
    model: envString("AGENT_TEST_MODEL"),
    provider: envString("AGENT_TEST_PROVIDER"),
    runnerKind: envString("AGENT_TEST_RUNNER_KIND") ?? "codex",
    userId: envString("AGENT_TEST_USER_ID"),
  };

  const [command, ...rest] = argv;
  if (command === "seed" || command === "reset") {
    parsed.command = command;
  } else if (command === "--help" || command === "-h") {
    parsed.help = true;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--workspace-id") {
      parsed.workspaceId = value ?? null;
      index += 1;
    } else if (arg.startsWith("--workspace-id=")) parsed.workspaceId = arg.slice("--workspace-id=".length);
    else if (arg === "--agent-id") {
      parsed.agentId = value ?? null;
      index += 1;
    } else if (arg.startsWith("--agent-id=")) parsed.agentId = arg.slice("--agent-id=".length);
    else if (arg === "--kind") {
      parsed.kind = AgentTypeSchema.parse(value);
      index += 1;
    } else if (arg.startsWith("--kind=")) parsed.kind = AgentTypeSchema.parse(arg.slice("--kind=".length));
    else if (arg === "--name") {
      parsed.name = value ?? null;
      index += 1;
    } else if (arg.startsWith("--name=")) parsed.name = arg.slice("--name=".length);
    else if (arg === "--model") {
      parsed.model = value ?? null;
      index += 1;
    } else if (arg.startsWith("--model=")) parsed.model = arg.slice("--model=".length);
    else if (arg === "--provider") {
      parsed.provider = value ?? null;
      index += 1;
    } else if (arg.startsWith("--provider=")) parsed.provider = arg.slice("--provider=".length);
    else if (arg === "--runner-kind") {
      parsed.runnerKind = value ?? null;
      index += 1;
    } else if (arg.startsWith("--runner-kind=")) parsed.runnerKind = arg.slice("--runner-kind=".length);
    else if (arg === "--user-id") {
      parsed.userId = value ?? null;
      index += 1;
    } else if (arg.startsWith("--user-id=")) parsed.userId = arg.slice("--user-id=".length);
  }

  parsed.workspaceId = cleanString(parsed.workspaceId);
  parsed.agentId = cleanString(parsed.agentId);
  parsed.name = cleanString(parsed.name);
  parsed.model = cleanString(parsed.model);
  parsed.provider = cleanString(parsed.provider);
  parsed.runnerKind = cleanString(parsed.runnerKind);
  parsed.userId = cleanString(parsed.userId);
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  pnpm run agent:test-seed -- --workspace-id <workspace-id> --kind coding --provider <provider> --model <model>
  pnpm run agent:test-reset -- --agent-id <agent-id> --workspace-id <workspace-id> --yes

Options:
  --kind <coding|planning|manager|custom>  Agent type for seed (default: coding)
  --provider <provider>                   Execution provider, or AGENT_TEST_PROVIDER
  --model <model>                         Execution model, or AGENT_TEST_MODEL
  --runner-kind <kind>                    Runner kind, or AGENT_TEST_RUNNER_KIND (default: codex)
  --user-id <id>                          App user id; defaults to the workspace owner
  --name <name>                           Seeded agent display name
  --yes                                   Required for reset
  --json                                  Print machine-readable output

Remote Supabase safety:
  Localhost Supabase URLs are allowed by default. For any remote Supabase URL,
  set AGENT_TEST_DISPOSABLE_SUPABASE=true to confirm the target project is
  disposable test data.`);
}

async function seedAgent() {
  const workspaceId = requireArg(args.workspaceId, "--workspace-id is required");
  const model = requireArg(args.model, "--model or AGENT_TEST_MODEL is required");
  const provider = KnownExecutionProviderSchema.parse(
    requireArg(args.provider, "--provider or AGENT_TEST_PROVIDER is required"),
  );
  const runnerKind = RunnerKindSchema.parse(
    requireArg(args.runnerKind, "--runner-kind or AGENT_TEST_RUNNER_KIND is required"),
  );
  assertLocalDevScope();

  const workspace = await getWorkspace(workspaceId);
  const userId = args.userId ?? workspace.owner_user_id;
  const now = new Date().toISOString();
  const name = args.name ?? `Disposable ${titleCase(args.kind)} Test Agent ${now.slice(0, 10)}`;
  const toolPolicy = testOwnedToolPolicy(defaultToolPolicy(args.kind), now);
  const modelSettings = { primary: model };
  const gatewayConfig = buildGatewayConfig({ kind: args.kind, runnerKind, provider, model });
  const configHash = hashJson(gatewayConfig);
  const supabase = getServiceRoleSupabase();

  const [agent] = await executeSupabaseRows<AgentRow>(
    "agent test seed insert",
    supabase
      .from("agent")
      .insert({
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name,
        type: args.kind,
        model_settings: modelSettings,
        tool_policy: toolPolicy,
        status: "active",
      })
      .select("id,workspace_id,name,type,model_settings,tool_policy,session_id")
      .single(),
  );

  if (!agent) throw new Error("Agent seed insert returned no row");

  const [gateway] = await executeSupabaseRows<GatewayConfigRow>(
    "agent test seed gateway_config insert",
    supabase
      .from("gateway_config")
      .insert({
        scope_type: "agent",
        scope_id: agent.id,
        updated_by: userId,
        config_hash: configHash,
        config_json: gatewayConfig,
        version: 1,
      })
      .select("id,scope_id,scope_type,version,config_json")
      .single(),
  );

  if (!gateway) throw new Error("Gateway config seed insert returned no row");

  await executeSupabaseRows(
    "agent test seed gateway_config_versions insert",
    supabase
      .from("gateway_config_versions")
      .insert({
        gateway_config_id: gateway.id,
        version: gateway.version,
        config_hash: configHash,
        config_json: gatewayConfig,
        created_by: userId,
        change_summary: { source: TEST_OWNER, action: "agent_test_seed" },
      })
      .select("id"),
  );

  const toolAssignment = await ensureDefaultAgentToolsForAgent({
    agentId: agent.id,
    workspaceId,
    agentType: args.kind,
    runnerKind,
    userId,
    supabase,
  });
  const grantedTools = await grantedToolSlugs(agent.id, workspaceId);
  const result = {
    ok: true,
    agentId: agent.id,
    workspaceId,
    kind: args.kind,
    runnerKind,
    provider,
    model,
    grantedTools,
    missingToolSlugs: toolAssignment.missingToolSlugs,
    resetCommand: `pnpm run agent:test-reset -- --agent-id ${agent.id} --workspace-id ${workspaceId} --yes`,
  };

  printResult(result, [
    ["agentId", result.agentId],
    ["workspaceId", result.workspaceId],
    ["kind", result.kind],
    ["runnerKind", result.runnerKind],
    ["provider", result.provider],
    ["model", result.model],
    ["grantedTools", result.grantedTools.length > 0 ? result.grantedTools.join(", ") : "(none)"],
    ["resetCommand", result.resetCommand],
  ]);
}

async function resetAgent() {
  const agentId = requireArg(args.agentId, "--agent-id is required");
  const workspaceId = requireArg(args.workspaceId, "--workspace-id is required");
  if (!args.yes) {
    throw new Error("Reset is destructive. Re-run with --yes to clear this disposable test agent's state.");
  }
  assertLocalDevScope();

  const agent = await getAgent(agentId, workspaceId);
  if (!isDisposableTestAgent(agent.tool_policy)) {
    throw new Error(
      "Refusing to reset agent because it is not marked tool_policy.test.disposable=true by agent:test-seed",
    );
  }

  const supabase = getServiceRoleSupabase();
  const messages = await executeSupabaseRows<MessageRow>(
    "agent test reset message query",
    supabase.from("message").select("id").eq("agent_id", agentId).eq("workspace_id", workspaceId),
  );
  const messageIds = messages.map((message) => message.id);
  const deletedToolCalls = await deleteToolCallsForMessages(messageIds);
  const deletedMessages = await deleteRows(
    "message",
    supabase.from("message").delete().eq("agent_id", agentId).eq("workspace_id", workspaceId).select("id"),
  );
  const deletedGrants = await deleteRows(
    "agent_tool_grant",
    serviceRoleDb()
      .from("agent_tool_grant")
      .delete()
      .eq("agent_id", agentId)
      .eq("workspace_id", workspaceId)
      .select(AGENT_TOOL_GRANT_SELECT),
  );
  const sessions = await executeSupabaseRows<SessionThreadRow>(
    "agent test reset session_thread query",
    supabase.from("session_thread").select("id").eq("agent_id", agentId).eq("workspace_id", workspaceId),
  );
  const deletedSessionThreads = await deleteSessionThreads(sessions.map((session) => session.id));

  await executeSupabaseRows(
    "agent test reset agent session update",
    supabase
      .from("agent")
      .update({ session_id: null, updated_at: new Date().toISOString() })
      .eq("id", agentId)
      .select("id"),
  );

  const result = {
    ok: true,
    agentId,
    workspaceId,
    deleted: {
      messages: deletedMessages,
      toolCalls: deletedToolCalls,
      grants: deletedGrants,
      sessionThreads: deletedSessionThreads,
    },
  };

  printResult(result, [
    ["agentId", result.agentId],
    ["workspaceId", result.workspaceId],
    ["deletedMessages", String(result.deleted.messages)],
    ["deletedToolCalls", String(result.deleted.toolCalls)],
    ["deletedGrants", String(result.deleted.grants)],
    ["deletedSessionThreads", String(result.deleted.sessionThreads)],
  ]);
}

function assertLocalDevScope() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("agent:test helpers are local/dev scoped and refuse to run with NODE_ENV=production");
  }
  if (isLocalSupabaseUrl(process.env.SUPABASE_URL)) return;
  if (envFlag("AGENT_TEST_DISPOSABLE_SUPABASE")) return;

  throw new Error(
    "agent:test helpers require a local Supabase URL or AGENT_TEST_DISPOSABLE_SUPABASE=true for disposable remote targets",
  );
}

function isLocalSupabaseUrl(value: string | undefined) {
  const rawUrl = cleanString(value);
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function envFlag(name: string) {
  const value = cleanString(process.env[name])?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function getWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const rows = await executeSupabaseRows<WorkspaceRow>(
    "agent test workspace query",
    getServiceRoleSupabase().from("workspaces").select("id,owner_user_id").eq("id", workspaceId).limit(1),
  );
  const workspace = rows[0] ?? null;
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  return workspace;
}

async function getAgent(agentId: string, workspaceId: string): Promise<AgentRow> {
  const rows = await executeSupabaseRows<AgentRow>(
    "agent test reset agent query",
    getServiceRoleSupabase()
      .from("agent")
      .select("id,workspace_id,name,type,model_settings,tool_policy,session_id")
      .eq("id", agentId)
      .eq("workspace_id", workspaceId)
      .limit(1),
  );
  const agent = rows[0] ?? null;
  if (!agent) throw new Error(`Agent not found in workspace: ${agentId}`);
  return agent;
}

async function grantedToolSlugs(agentId: string, workspaceId: string) {
  const [grants, tools] = await Promise.all([
    listAgentToolGrantRows({ agentId, workspaceId }),
    listVisibleToolRows(workspaceId),
  ]);
  const toolsById = new Map(tools.map((tool) => [tool.id, tool.slug]));
  return grants
    .filter((grant) => grant.mode === "include")
    .map((grant) => toolsById.get(grant.tool_id) ?? grant.tool_id)
    .filter((slug): slug is string => Boolean(slug))
    .sort();
}

async function deleteToolCallsForMessages(messageIds: string[]) {
  let deleted = 0;
  for (const chunk of chunks(messageIds, 100)) {
    const rows = await deleteRows(
      "tool_call",
      getServiceRoleSupabase().from("tool_call").delete().in("message_id", chunk).select("id"),
    );
    deleted += rows;
  }
  return deleted;
}

async function deleteSessionThreads(sessionIds: string[]) {
  let deleted = 0;
  for (const chunk of chunks(sessionIds, 100)) {
    try {
      deleted += await deleteRows(
        "session_thread",
        getServiceRoleSupabase().from("session_thread").delete().in("id", chunk).select("id"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not clear runtime session state. Delete dependent runtime rows first: ${message}`);
    }
  }
  return deleted;
}

async function deleteRows(table: string, query: PromiseLike<{ data: unknown; error: unknown }>) {
  const { data, error } = await query;
  if (error) throw normalizeSupabaseError(`${table} delete`, error as never);
  return Array.isArray(data) ? data.length : data ? 1 : 0;
}

function testOwnedToolPolicy(basePolicy: ToolPolicy, seededAt: string) {
  return ToolPolicySchema.parse({
    ...basePolicy,
    test: {
      disposable: true,
      owner: TEST_OWNER,
      seededAt,
    },
  });
}

function isDisposableTestAgent(toolPolicy: unknown) {
  if (!toolPolicy || typeof toolPolicy !== "object" || Array.isArray(toolPolicy)) return false;
  const test = (toolPolicy as JsonRecord).test;
  if (!test || typeof test !== "object" || Array.isArray(test)) return false;
  return (test as JsonRecord).disposable === true && (test as JsonRecord).owner === TEST_OWNER;
}

function defaultToolPolicy(kind: AgentType): ToolPolicy {
  if (kind === "planning") {
    return ToolPolicySchema.parse({
      planning: {
        destination: "database",
        tools: [...DEFAULT_PLANNING_TOOL_SLUGS, ...SCHEDULED_TASK_TOOL_SLUGS],
      },
    });
  }
  if (kind === "manager") {
    return ToolPolicySchema.parse({
      manager: {
        cadence_ms: 60_000,
        tools: DEFAULT_MANAGER_TOOL_SLUGS,
      },
    });
  }
  if (kind === "custom") {
    return ToolPolicySchema.parse({ custom: { target_required: true } });
  }
  return ToolPolicySchema.parse({
    coding: {
      tools: [
        GIT_COMMAND_TOOL_SLUG,
        "shell.exec",
        "apply_patch",
        ...SCHEDULED_TASK_TOOL_SLUGS,
      ],
      execution_kinds: ["filesystem", "shell"],
    },
  });
}

function buildGatewayConfig(input: { kind: AgentType; runnerKind: string; provider: string; model: string }) {
  return {
    workflow_template: { id: `${input.kind}-test-seed` },
    runners: [{ kind: input.runnerKind, provider: input.provider, model: input.model }],
    max_concurrent_agents: 1,
    test: {
      disposable: true,
      owner: TEST_OWNER,
    },
  };
}

function hashJson(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function requireArg(value: string | null, message: string) {
  if (!value) throw new Error(message);
  return value;
}

function cleanString(value: string | null | undefined) {
  return value?.trim() || null;
}

function envString(name: string) {
  return cleanString(process.env[name]);
}

function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function printResult(result: unknown, rows: Array<[string, string]>) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [label, value] of rows) {
    console.log(`${label}: ${value}`);
  }
}
