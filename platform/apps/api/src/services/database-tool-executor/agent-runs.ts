import { normalizeAgentType } from "../../../../../contracts/agents.js";
import { ApiRouteError } from "../../http.js";
import { findSetupAgentById } from "../../repositories/agents.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";
import type { ToolExecutionContext } from "../tool-execution-client.js";
import { jsonOutput, optionalPositiveInteger, stringArg, type DatabaseToolResult } from "./shared.js";

type BrokerRunTranscriptRow = {
  run_id: string;
  agent_id: string | null;
  workspace_id: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  error: string | null;
  terminal_reason: string | null;
};

type MessageTranscriptRow = {
  id: string;
  role: string | null;
  content: string | null;
  created_at: string | null;
  metadata: unknown;
  run_id: string | null;
  session_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  workspace_id: string | null;
  message_type: string | null;
};

type ToolCallTranscriptRow = {
  id: string;
  run_id: string;
  sequence: number | null;
  event_type: string | null;
  message_kind: string | null;
  tool_slug: string | null;
  status: string | null;
  approval_state: string | null;
  arguments: unknown;
  result: unknown;
  output_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | null;
};

const RUN_SELECT =
  "run_id,agent_id,workspace_id,status,started_at,completed_at,created_at,updated_at,error,terminal_reason" as const;
const MESSAGE_SELECT =
  "id,role,content,created_at,metadata,run_id,session_id,user_id,agent_id,workspace_id,message_type" as const;
const TOOL_EVENT_SELECT =
  "id,run_id,sequence,event_type,message_kind,tool_slug,status,approval_state,arguments,result,output_summary,error_code,error_message,created_at" as const;

async function assertLearningObserver(context: ToolExecutionContext | undefined, workspaceId: string) {
  const agentId = context?.agentId?.trim() ?? "";
  if (!agentId) throw new ApiRouteError(400, "runtime_context_required", "agent_id is required in runtime context");

  const agent = await findSetupAgentById("", agentId);
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Observer agent was not found");
  if (agent.workspace_id !== workspaceId) {
    throw new ApiRouteError(403, "workspace_mismatch", "Observer agent must belong to the runtime workspace");
  }
  if (normalizeAgentType(agent.type) !== "learning") {
    throw new ApiRouteError(403, "learning_agent_required", "agent_run.read is only available to learning agents");
  }
  return agent;
}

async function getRun(workspaceId: string, runId: string) {
  const rows = await executeSupabaseRows<BrokerRunTranscriptRow>(
    "agent_run.read broker_run query",
    getServiceRoleSupabase()
      .from("broker_run")
      .select(RUN_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("run_id", runId)
      .limit(1),
  );
  return rows[0] ?? null;
}

async function getMessages(workspaceId: string, runId: string, limit: number) {
  return executeSupabaseRows<MessageTranscriptRow>(
    "agent_run.read message query",
    getServiceRoleSupabase()
      .from("message")
      .select(MESSAGE_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("run_id", runId)
      .order("created_at", { ascending: true })
      .limit(limit),
  );
}

async function getToolEvents(workspaceId: string, runId: string, limit: number) {
  return executeSupabaseRows<ToolCallTranscriptRow>(
    "agent_run.read tool event query",
    getServiceRoleSupabase()
      .from("agent_tool_call_event" as never)
      .select(TOOL_EVENT_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("run_id", runId)
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit) as never,
  );
}

export async function readAgentRunTool(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
): Promise<DatabaseToolResult> {
  await assertLearningObserver(context, workspaceId);

  const runId = stringArg(args, "run_id") || stringArg(args, "runId");
  if (!runId) throw new ApiRouteError(400, "invalid_tool_arguments", "run_id is required");

  const messageLimit = optionalPositiveInteger(args, "message_limit", 10, 100);
  const toolEventLimit = optionalPositiveInteger(args, "tool_event_limit", 50, 200);
  const includeToolEvents = args.include_tool_events !== false && args.includeToolEvents !== false;
  const run = await getRun(workspaceId, runId);
  if (!run) throw new ApiRouteError(404, "run_not_found", "Run was not found in this workspace");

  const [messages, toolEvents] = await Promise.all([
    getMessages(workspaceId, runId, messageLimit),
    includeToolEvents ? getToolEvents(workspaceId, runId, toolEventLimit) : Promise.resolve([]),
  ]);

  return {
    status: 200,
    output: jsonOutput({
      run,
      messages,
      toolEvents,
      messageCount: messages.length,
      toolEventCount: toolEvents.length,
      truncated: {
        messages: messages.length === messageLimit,
        toolEvents: includeToolEvents && toolEvents.length === toolEventLimit,
      },
    }),
  };
}

export async function sampleRecentAgentRunTranscript(input: {
  workspaceId: string;
  observerAgentId: string;
  recentRunLimit?: number;
  messageLimit?: number;
}) {
  const recentRunLimit = Math.min(Math.max(input.recentRunLimit ?? 50, 1), 200);
  const messageLimit = Math.min(Math.max(input.messageLimit ?? 10, 1), 100);
  const runs = await executeSupabaseRows<BrokerRunTranscriptRow>(
    "learning sampler broker_run query",
    getServiceRoleSupabase()
      .from("broker_run")
      .select(RUN_SELECT)
      .eq("workspace_id", input.workspaceId)
      .neq("agent_id", input.observerAgentId)
      .order("created_at", { ascending: false })
      .limit(recentRunLimit),
  );
  if (runs.length === 0) return null;

  const run = runs[Math.floor(Math.random() * runs.length)];
  if (!run) return null;
  const [messages, toolEvents] = await Promise.all([
    getMessages(input.workspaceId, run.run_id, messageLimit),
    getToolEvents(input.workspaceId, run.run_id, 50),
  ]);
  return { run, messages, toolEvents };
}
