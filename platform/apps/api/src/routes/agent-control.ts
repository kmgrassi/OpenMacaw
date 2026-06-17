import type { Express, Request, Response } from "express";

import { z } from "zod";

import {
  AgentControlMessageRowSchema,
  AgentControlMessageResponseSchema,
  AgentRemediationResponseSchema,
  CreateAgentControlMessageRequestSchema,
  CreateAgentRemediationRequestSchema,
} from "../../../../contracts/agent-control.js";
import {
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  handleLauncherError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import { StartWorkerBridgeSessionRequestSchema } from "../services/launcher.js";
import {
  assertAgentControlAccess,
  createAgentControlMessage,
  createAgentRemediation,
  logAgentRemediationRequested,
  mapAgentControlMessage,
  updateAgentControlMessageDispatchStatus,
} from "../services/agent-control.js";
import { assertAgentAccess } from "../services/agent-tools/access.js";
import type { LauncherClient } from "../services/launcher.js";
import { attachRuntimeDispatchContext, buildRuntimeDispatchContext } from "../services/runtime-dispatch-context.js";
import { assertRuntimePrepareSupported } from "../services/runtime-prepare.js";
import { mapWorkerBridgeSessionListResponse, mapWorkerBridgeSessionResponse } from "../services/worker-bridge.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";
import { assertCredentialReferenceBelongsToWorkspace } from "./stored-agent-credentials/authz.js";

const MESSAGE_PAGE_LIMIT = 20;
const MESSAGE_PAGE_FETCH_LIMIT = MESSAGE_PAGE_LIMIT + 1;

const RecoverAgentRuntimeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  mode: z.enum(["restart_runtime", "stop_runtime", "full_recover"]).default("restart_runtime"),
  reason: z.string().trim().min(1).max(500).optional(),
});

const MessageCursorSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

type MessageCursor = z.infer<typeof MessageCursorSchema>;

type MessageToolCallRow = {
  id: string;
  tool_id: string | null;
  input: string | null;
  output: string | null;
  created_at: string | null;
};

type MessageRowWithToolCalls = {
  id: string;
  role: string;
  content: string;
  created_at: string | null;
  metadata: unknown;
  run_id: string | null;
  session_id: string | null;
  user_id: string | null;
  agent_id: string;
  workspace_id: string;
  message_type: string | null;
  tool_call?: MessageToolCallRow[] | null;
};

type AgentToolCallEventForMessageRow = {
  id: string;
  run_id: string;
  correlation_id: string | null;
  tool_slug: string;
  status: string;
  arguments: unknown;
  result: unknown;
  output_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | null;
  sequence: number;
};

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
  for (const event of (data ?? []) as unknown as AgentToolCallEventForMessageRow[]) {
    const toolCalls = grouped.get(event.run_id) ?? [];
    toolCalls.push(toolCallFromEvent(event));
    grouped.set(event.run_id, toolCalls);
  }
  return grouped;
}

async function createStructuredAgentMessage(req: Request, res: Response) {
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

async function recoverAgentRuntime(req: Request, res: Response, launcherClient: LauncherClient) {
  const parsed = RecoverAgentRuntimeRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(
      errorPayload("invalid_request", "workspaceId and a valid recovery mode are required", {
        issues: parsed.error.issues,
      }),
    );
  }

  try {
    const accessToken = requireAccessToken(req);
    const userId = requireVerifiedUser(req);
    const agentId = requireRouteParam(req, "id");
    const { workspaceId } = await assertAgentAccess({
      accessToken,
      userId,
      agentId,
      workspaceId: parsed.data.workspaceId,
    });

    const orchestrators = await launcherClient.listOrchestrators();
    const matchingOrchestrators = orchestrators.data.filter(
      (orchestrator) => orchestrator.agent_id === agentId && orchestrator.workspace_id === workspaceId,
    );

    const stopped = [];
    const stopErrors = [];
    for (const orchestrator of matchingOrchestrators) {
      try {
        const result = await launcherClient.stopOrchestrator(orchestrator.id);
        stopped.push(result.data.data);
      } catch (error) {
        stopErrors.push({
          id: orchestrator.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (stopErrors.length > 0) {
      return res.status(502).json(
        errorPayload("runtime_recovery_stop_failed", "Could not stop every matching runtime", {
          stopped,
          stopErrors,
        }),
      );
    }

    const shouldRestart = parsed.data.mode === "restart_runtime" || parsed.data.mode === "full_recover";
    let restarted = null;
    if (shouldRestart) {
      const restartBody = {
        workspaceId,
        recovery: {
          mode: parsed.data.mode,
          reason: parsed.data.reason ?? null,
          stopped_orchestrator_ids: stopped.map((orchestrator) => orchestrator.id),
        },
      };
      const dispatchContext = await buildRuntimeDispatchContext({
        accessToken,
        requesterUserId: userId,
        agentId,
        requestBody: restartBody,
      });
      restarted = await launcherClient.startAgent(agentId, attachRuntimeDispatchContext(restartBody, dispatchContext));
    }

    return res.status(200).json({
      status: "ok",
      agentId,
      workspaceId,
      mode: parsed.data.mode,
      stoppedCount: stopped.length,
      stopped,
      restarted: restarted?.data.data ?? null,
    });
  } catch (error) {
    if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "runtime_recovery_failed",
        message: "Runtime recovery failed",
      });
    }
    return handleLauncherError(res, error);
  }
}

async function getAgentMessages(req: Request, res: Response) {
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

    if (!agent) {
      return res.status(404).json(errorPayload("agent_not_found", "Agent not found"));
    }

    try {
      await assertWorkspaceMembership(requireVerifiedUser(req), agent.workspace_id);
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
        .eq("workspace_id", agent.workspace_id)
        .is("deleted_at", null)
        .eq("created_at", cursor.createdAt)
        .lt("id", cursor.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MESSAGE_PAGE_FETCH_LIMIT);

      if (sameTimestampError) {
        throw normalizeSupabaseError("message query", sameTimestampError);
      }

      rows = ((sameTimestampRows ?? []) as unknown as MessageRowWithToolCalls[]).map(sortMessageToolCalls);
      if (rows.length < MESSAGE_PAGE_FETCH_LIMIT) {
        const { data: olderTimestampRows, error: olderTimestampError } = await supabase
          .from("message")
          .select(messageSelect)
          .eq("agent_id", agentId)
          .eq("workspace_id", agent.workspace_id)
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
          ...((olderTimestampRows ?? []) as unknown as MessageRowWithToolCalls[]).map(sortMessageToolCalls),
        ];
      }
    } else {
      const { data, error } = await supabase
        .from("message")
        .select(messageSelect)
        .eq("agent_id", agentId)
        .eq("workspace_id", agent.workspace_id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MESSAGE_PAGE_FETCH_LIMIT);

      if (error) {
        throw normalizeSupabaseError("message query", error);
      }

      rows = ((data ?? []) as unknown as MessageRowWithToolCalls[]).map(sortMessageToolCalls);
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

async function createAgentRemediationRequest(req: Request, res: Response, launcherClient: LauncherClient) {
  const parsed = CreateAgentRemediationRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(
      errorPayload("invalid_request", "workspaceId, observerAgentId, and action are required", {
        issues: parsed.error.issues,
      }),
    );
  }

  let remediationId: string | undefined;

  try {
    const userId = requireVerifiedUser(req);
    const targetAgentId = requireRouteParam(req, "id");
    await assertAgentControlAccess({
      userId,
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
    });

    const remediation = await createAgentRemediation({
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
      action: parsed.data.action,
      reason: parsed.data.reason?.trim() || null,
      metadata: parsed.data.metadata ?? {},
      dispatchStatus: parsed.data.action === "restart" ? "dispatching" : "queued",
      createdByUserId: userId,
    });
    remediationId = remediation.id;

    logAgentRemediationRequested({
      workspaceId: parsed.data.workspaceId,
      targetAgentId,
      observerAgentId: parsed.data.observerAgentId,
      action: parsed.data.action,
      remediationId: remediation.id,
      dispatchStatus: remediation.dispatch_status,
    });

    if (parsed.data.action !== "restart") {
      return res.status(202).json(
        AgentRemediationResponseSchema.parse({
          remediation: mapAgentControlMessage(remediation),
          dispatch: {
            attempted: false,
            status: "queued",
            result: null,
          },
        }),
      );
    }

    try {
      await assertRuntimePrepareSupported(requireAccessToken(req), userId, targetAgentId);
      const result = await launcherClient.startAgent(targetAgentId);

      const optimisticRemediation = AgentControlMessageRowSchema.parse({
        ...remediation,
        status: "accepted",
        dispatch_status: "dispatched",
        metadata: {
          ...remediation.metadata,
          launcher_status: result.status,
        },
      });

      const updated = await updateAgentControlMessageDispatchStatus({
        messageId: remediation.id,
        dispatchStatus: "dispatched",
        status: "accepted",
        metadata: optimisticRemediation.metadata,
      }).catch((error) => {
        process.stdout.write(
          `${JSON.stringify({
            event: "agent_remediation_status_update_failed",
            remediation_id: remediation.id,
            workspace_id: parsed.data.workspaceId,
            target_agent_id: targetAgentId,
            observer_agent_id: parsed.data.observerAgentId,
            dispatch_status: "dispatched",
            error_message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        return null;
      });

      return res.status(202).json(
        AgentRemediationResponseSchema.parse({
          remediation: mapAgentControlMessage(updated ?? optimisticRemediation),
          dispatch: {
            attempted: true,
            status: updated ? "dispatched" : "dispatched_status_update_failed",
            result: result.data,
          },
        }),
      );
    } catch (error) {
      await updateAgentControlMessageDispatchStatus({
        messageId: remediation.id,
        dispatchStatus: "failed",
        status: "failed",
        metadata: {
          ...(parsed.data.metadata ?? {}),
          dispatch_error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => undefined);
      if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
        return handleApiRouteError(res, error, {
          status: 502,
          code: "runtime_prepare_failed",
          message: "Runtime preparation failed",
        });
      }
      return handleLauncherError(res, error);
    }
  } catch (error) {
    if (remediationId) {
      await updateAgentControlMessageDispatchStatus({
        messageId: remediationId,
        dispatchStatus: "failed",
        status: "failed",
      }).catch(() => undefined);
    }
    return handleApiRouteError(res, error, {
      status: 502,
      code: "agent_remediation_create_failed",
      message: "Could not persist agent remediation request",
    });
  }
}

function requireWorkerBridgeIdentityLaunch(body: unknown) {
  const parsed = StartWorkerBridgeSessionRequestSchema.parse(body ?? {});
  const agentId = parsed.agent_id?.trim() ?? "";
  const workspaceId = parsed.workspace_id?.trim() ?? "";
  const credentialId = parsed.credential_id?.trim() ?? "";

  if (!agentId || !workspaceId || !credentialId) {
    throw new ApiRouteError(
      403,
      "worker_bridge_identity_required",
      "Worker bridge API launches must be scoped to an authorized agent workspace and credential",
    );
  }

  return { parsed, agentId, workspaceId, credentialId };
}

async function assertWorkerBridgeSessionAccess(
  req: Request,
  session: { agent_id?: string | null; workspace_id?: string | null },
) {
  const agentId = session.agent_id?.trim() ?? "";
  const workspaceId = session.workspace_id?.trim() ?? "";
  if (!agentId || !workspaceId) {
    throw new ApiRouteError(
      403,
      "worker_bridge_forbidden",
      "Worker bridge session is not bound to an authorized agent workspace",
    );
  }

  await assertAgentAccess({
    accessToken: requireAccessToken(req),
    userId: requireVerifiedUser(req),
    agentId,
    workspaceId,
  });
}

async function canAccessWorkerBridgeSession(
  req: Request,
  session: { agent_id?: string | null; workspace_id?: string | null },
): Promise<boolean> {
  try {
    await assertWorkerBridgeSessionAccess(req, session);
    return true;
  } catch (error) {
    if (
      error instanceof ApiRouteError &&
      (error.status === 403 || error.status === 404 || error.code === "worker_bridge_forbidden")
    ) {
      return false;
    }
    throw error;
  }
}

function handleWorkerBridgeRouteError(res: Response, error: unknown, fallback: { code: string; message: string }) {
  if (error instanceof z.ZodError) {
    return res.status(400).json(
      errorPayload("invalid_request", "Invalid worker bridge session payload", {
        issues: error.issues,
      }),
    );
  }
  if (error instanceof ApiRouteError) {
    return handleApiRouteError(res, error, {
      status: 500,
      code: fallback.code,
      message: fallback.message,
    });
  }
  return handleLauncherError(res, error);
}

export function registerAgentControlRoutes(app: Express, launcherClient: LauncherClient) {
  app.get("/api/agents/:id", async (req: Request, res: Response) => {
    try {
      const result = await launcherClient.getAgent(requireRouteParam(req, "id"));
      return res.status(200).json(result);
    } catch (error) {
      return handleLauncherError(res, error);
    }
  });

  app.post("/api/agents/:id/start", async (req: Request, res: Response) => {
    try {
      const agentId = requireRouteParam(req, "id");
      const prepared = await assertRuntimePrepareSupported(requireAccessToken(req), requireVerifiedUser(req), agentId);

      if (prepared.localRuntime) {
        return res.status(200).json({
          status: "ready",
          agentId: prepared.agentId,
          agentType: prepared.agentType,
          workspaceId: prepared.workspaceId,
          localRuntime: true,
        });
      }

      const dispatchContext = await buildRuntimeDispatchContext({
        accessToken: requireAccessToken(req),
        requesterUserId: requireVerifiedUser(req),
        agentId,
        requestBody: req.body ?? {},
      });
      const result = await launcherClient.startAgent(
        agentId,
        attachRuntimeDispatchContext(req.body ?? {}, dispatchContext),
      );
      return res.status(result.status).json(result.data);
    } catch (error) {
      if (!(error instanceof Error && error.name.startsWith("Launcher"))) {
        return handleApiRouteError(res, error, {
          status: 502,
          code: "runtime_prepare_failed",
          message: "Runtime preparation failed",
        });
      }
      return handleLauncherError(res, error);
    }
  });

  app.post("/api/agents/:id/runtime/recover", async (req: Request, res: Response) => {
    return await recoverAgentRuntime(req, res, launcherClient);
  });

  app.post("/api/agents/:id/messages", async (req: Request, res: Response) => {
    return await createStructuredAgentMessage(req, res);
  });

  app.get("/api/agents/:id/messages", async (req: Request, res: Response) => {
    return await getAgentMessages(req, res);
  });

  app.post("/api/agents/:id/remediations", async (req: Request, res: Response) => {
    return await createAgentRemediationRequest(req, res, launcherClient);
  });

  app.get("/api/worker-bridge/sessions", async (req: Request, res: Response) => {
    try {
      requireAccessToken(req);
      requireVerifiedUser(req);
      const result = await launcherClient.listWorkerBridgeSessions();
      const visibleSessions = (
        await Promise.all(
          (result.data ?? []).map(async (session) =>
            (await canAccessWorkerBridgeSession(req, session)) ? session : null,
          ),
        )
      ).filter((session): session is NonNullable<typeof session> => Boolean(session));
      return res.status(200).json(mapWorkerBridgeSessionListResponse({ data: visibleSessions }));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_list_failed",
        message: "Could not list worker bridge sessions",
      });
    }
  });

  app.post("/api/worker-bridge/sessions", async (req: Request, res: Response) => {
    try {
      const { parsed, agentId, workspaceId, credentialId } = requireWorkerBridgeIdentityLaunch(req.body);
      await assertAgentAccess({
        accessToken: requireAccessToken(req),
        userId: requireVerifiedUser(req),
        agentId,
        workspaceId,
      });
      await assertCredentialReferenceBelongsToWorkspace({
        workspaceId,
        credentialRef: { type: "credential_id", value: credentialId },
      });

      const result = await launcherClient.createWorkerBridgeSession(parsed);
      if (result.data?.data) {
        await assertWorkerBridgeSessionAccess(req, result.data.data);
      }
      return res.status(result.status).json(mapWorkerBridgeSessionResponse(result.data));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_create_failed",
        message: "Could not create worker bridge session",
      });
    }
  });

  app.get("/api/worker-bridge/sessions/:id", async (req: Request, res: Response) => {
    try {
      const result = await launcherClient.getWorkerBridgeSession(requireRouteParam(req, "id"));
      if (result.data) {
        await assertWorkerBridgeSessionAccess(req, result.data);
      }
      return res.status(200).json(mapWorkerBridgeSessionResponse(result));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_fetch_failed",
        message: "Could not fetch worker bridge session",
      });
    }
  });

  app.delete("/api/worker-bridge/sessions/:id", async (req: Request, res: Response) => {
    try {
      const sessionId = requireRouteParam(req, "id");
      const existing = await launcherClient.getWorkerBridgeSession(sessionId);
      if (existing.data) {
        await assertWorkerBridgeSessionAccess(req, existing.data);
      }
      const result = await launcherClient.deleteWorkerBridgeSession(sessionId);
      return res.status(200).json(mapWorkerBridgeSessionResponse(result));
    } catch (error) {
      return handleWorkerBridgeRouteError(res, error, {
        code: "worker_bridge_session_delete_failed",
        message: "Could not delete worker bridge session",
      });
    }
  });
}
