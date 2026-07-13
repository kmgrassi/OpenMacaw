import type { Request, Response } from "express";

import { z } from "zod";

import {
  AgentControlMessageResponseSchema,
  CreateAgentControlMessageRequestSchema,
} from "../../../../contracts/agent-control.js";
import { ApiRouteError, errorPayload, handleApiRouteError, requireRouteParam, requireVerifiedUser } from "../http.js";
import { parseNullableSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import {
  assertAgentControlAccess,
  createAgentControlMessage,
  mapAgentControlMessage,
} from "../services/agent-control.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

const MESSAGE_PAGE_LIMIT = 20;
const MESSAGE_PAGE_FETCH_LIMIT = MESSAGE_PAGE_LIMIT + 1;

const MessageCursorSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

type MessageCursor = z.infer<typeof MessageCursorSchema>;

const AgentWorkspaceRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
});

const MessageToolCallRowSchema = z.object({
  id: z.string(),
  tool_id: z.string().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  created_at: z.string().nullable(),
});

type MessageToolCallRow = z.infer<typeof MessageToolCallRowSchema>;

const MessageRowWithToolCallsSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  created_at: z.string().nullable(),
  metadata: z.unknown(),
  run_id: z.string().nullable(),
  session_id: z.string().nullable(),
  user_id: z.string().nullable(),
  agent_id: z.string(),
  workspace_id: z.string(),
  message_type: z.string().nullable(),
  tool_call: z.array(MessageToolCallRowSchema).nullable().optional(),
});

type MessageRowWithToolCalls = z.infer<typeof MessageRowWithToolCallsSchema>;

const AgentToolCallEventForMessageRowSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  correlation_id: z.string().nullable(),
  tool_slug: z.string(),
  status: z.string(),
  arguments: z.unknown(),
  result: z.unknown(),
  output_summary: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string().nullable(),
  sequence: z.number(),
});

type AgentToolCallEventForMessageRow = z.infer<typeof AgentToolCallEventForMessageRowSchema>;

function isWorkspaceAuthorizationMiss(error: unknown) {
  return error instanceof Error && error.message === "Authenticated user is not authorized for the requested workspace";
}

function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMessageCursor(raw: unknown): MessageCursor | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ApiRouteError(400, "invalid_cursor", "Message pagination cursor is invalid");
  }

  try {
    return MessageCursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new ApiRouteError(400, "invalid_cursor", "Message pagination cursor is invalid");
  }
}

function sortMessageToolCalls(message: MessageRowWithToolCalls): MessageRowWithToolCalls {
  if (!Array.isArray(message.tool_call)) return message;
  return {
    ...message,
    tool_call: [...message.tool_call].sort((a, b) => {
      const left = a.created_at ?? "";
      const right = b.created_at ?? "";
      if (left === right) return a.id.localeCompare(b.id);
      return left.localeCompare(right);
    }),
  };
}

function safeJsonStringify(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toolCallFromEvent(event: AgentToolCallEventForMessageRow): MessageToolCallRow {
  return {
    id: event.id,
    tool_id: null,
    input: safeJsonStringify({
      call_id: event.correlation_id ?? event.id,
      tool_name: event.tool_slug,
      input: { arguments: event.arguments ?? {} },
    }),
    output: safeJsonStringify({
      status: event.status,
      output: event.result ?? {},
      error_code: event.error_code ?? undefined,
      error_message: event.error_message ?? undefined,
      output_summary: event.output_summary ?? undefined,
    }),
    created_at: event.created_at,
  };
}

function canUseEventToolCalls(message: MessageRowWithToolCalls): boolean {
  return message.role === "assistant" || message.message_type === "assistant_tool_call";
}

async function getToolCallsByRunId(runIds: string[]): Promise<Map<string, MessageToolCallRow[]>> {
  const uniqueRunIds = [...new Set(runIds.filter((runId): runId is string => Boolean(runId)))];
  if (uniqueRunIds.length === 0) return new Map();

  const { data, error } = await getServiceRoleSupabase()
    .from("agent_tool_call_event" as never)
    .select(
      "id,run_id,correlation_id,tool_slug,status,arguments,result,output_summary,error_code,error_message,created_at,sequence",
    )
    .in("run_id", uniqueRunIds)
    .order("sequence", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return new Map();

  const grouped = new Map<string, MessageToolCallRow[]>();
  for (const event of parseSupabaseRows(
    "agent_tool_call_event query",
    AgentToolCallEventForMessageRowSchema,
    Array.isArray(data) ? data : [],
  )) {
    const toolCalls = grouped.get(event.run_id) ?? [];
    toolCalls.push(toolCallFromEvent(event));
    grouped.set(event.run_id, toolCalls);
  }
  return grouped;
}

export async function createStructuredAgentMessage(req: Request, res: Response) {
  const parsed = CreateAgentControlMessageRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(
      errorPayload("invalid_request", "workspaceId, observerAgentId, and body are required", {
        issues: parsed.error.issues,
      }),
    );
  }

  try {
    const userId = requireVerifiedUser(req);
    const targetAgentId = requireRouteParam(req, "id");
    await assertAgentControlAccess({
      userId,
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
    });

    const message = await createAgentControlMessage({
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
      kind: parsed.data.kind,
      subject: parsed.data.subject?.trim() || null,
      body: parsed.data.body,
      metadata: parsed.data.metadata ?? {},
      createdByUserId: userId,
    });

    return res.status(201).json(AgentControlMessageResponseSchema.parse({ message: mapAgentControlMessage(message) }));
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: 502,
      code: "agent_message_create_failed",
      message: "Could not persist agent message",
    });
  }
}

export async function getAgentMessages(req: Request, res: Response) {
  const agentId = requireRouteParam(req, "id");
  const supabase = getServiceRoleSupabase();

  try {
    const cursor = decodeMessageCursor(req.query.before);
    const { data: agent, error: agentError } = await supabase
      .from("agent")
      .select("id,workspace_id")
      .eq("id", agentId)
      .maybeSingle();

    if (agentError) {
      throw normalizeSupabaseError("agent query", agentError);
    }

    const parsedAgent = parseNullableSupabaseRow("agent query", AgentWorkspaceRowSchema, agent);
    if (!parsedAgent) {
      return res.status(404).json(errorPayload("agent_not_found", "Agent not found"));
    }

    try {
      await assertWorkspaceMembership(requireVerifiedUser(req), parsedAgent.workspace_id);
    } catch (error) {
      if (isWorkspaceAuthorizationMiss(error)) {
        throw new ApiRouteError(403, "forbidden", "Authenticated user is not authorized for the requested workspace");
      }
      throw error;
    }

    const messageSelect =
      "id,role,content,created_at,metadata,run_id,session_id,user_id,agent_id,workspace_id,message_type,tool_call(id,tool_id,input,output,created_at)";
    let rows: MessageRowWithToolCalls[];

    if (cursor) {
      const { data: sameTimestampRows, error: sameTimestampError } = await supabase
        .from("message")
        .select(messageSelect)
        .eq("agent_id", agentId)
        .eq("workspace_id", parsedAgent.workspace_id)
        .is("deleted_at", null)
        .eq("created_at", cursor.createdAt)
        .lt("id", cursor.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MESSAGE_PAGE_FETCH_LIMIT);

      if (sameTimestampError) {
        throw normalizeSupabaseError("message query", sameTimestampError);
      }

      rows = parseSupabaseRows(
        "message query",
        MessageRowWithToolCallsSchema,
        Array.isArray(sameTimestampRows) ? sameTimestampRows : [],
      ).map(sortMessageToolCalls);
      if (rows.length < MESSAGE_PAGE_FETCH_LIMIT) {
        const { data: olderTimestampRows, error: olderTimestampError } = await supabase
          .from("message")
          .select(messageSelect)
          .eq("agent_id", agentId)
          .eq("workspace_id", parsedAgent.workspace_id)
          .is("deleted_at", null)
          .lt("created_at", cursor.createdAt)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MESSAGE_PAGE_FETCH_LIMIT - rows.length);

        if (olderTimestampError) {
          throw normalizeSupabaseError("message query", olderTimestampError);
        }

        rows = [
          ...rows,
          ...parseSupabaseRows(
            "message query",
            MessageRowWithToolCallsSchema,
            Array.isArray(olderTimestampRows) ? olderTimestampRows : [],
          ).map(sortMessageToolCalls),
        ];
      }
    } else {
      const { data, error } = await supabase
        .from("message")
        .select(messageSelect)
        .eq("agent_id", agentId)
        .eq("workspace_id", parsedAgent.workspace_id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MESSAGE_PAGE_FETCH_LIMIT);

      if (error) {
        throw normalizeSupabaseError("message query", error);
      }

      rows = parseSupabaseRows("message query", MessageRowWithToolCallsSchema, Array.isArray(data) ? data : []).map(
        sortMessageToolCalls,
      );
    }

    const pageRows = rows.slice(0, MESSAGE_PAGE_LIMIT);
    const hasMore = rows.length > MESSAGE_PAGE_LIMIT;
    const nextCursorSource = hasMore ? pageRows[pageRows.length - 1] : null;
    const toolCallsByRunId = await getToolCallsByRunId(
      pageRows
        .filter(canUseEventToolCalls)
        .map((message) => message.run_id)
        .filter((runId): runId is string => Boolean(runId)),
    );

    return res.status(200).json({
      messages: pageRows.map((message) => {
        const eventToolCalls =
          canUseEventToolCalls(message) && message.run_id ? (toolCallsByRunId.get(message.run_id) ?? []) : [];
        const toolCalls = eventToolCalls.length > 0 ? eventToolCalls : (message.tool_call ?? []);
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
          timestamp: message.created_at ? new Date(message.created_at).getTime() : undefined,
          metadata: message.metadata ?? {},
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            toolId: toolCall.tool_id,
            input: toolCall.input,
            output: toolCall.output,
            createdAt: toolCall.created_at,
          })),
          runId: message.run_id,
          sessionId: message.session_id,
          userId: message.user_id,
          agentId: message.agent_id,
          workspaceId: message.workspace_id,
          messageType: message.message_type,
        };
      }),
      pageInfo: {
        limit: MESSAGE_PAGE_LIMIT,
        hasMore,
        nextCursor:
          nextCursorSource && nextCursorSource.created_at
            ? encodeMessageCursor({ createdAt: nextCursorSource.created_at, id: nextCursorSource.id })
            : null,
      },
    });
  } catch (error) {
    return handleApiRouteError(res, error, {
      status: 502,
      code: "message_fetch_failed",
      message: "Could not fetch messages",
    });
  }
}
