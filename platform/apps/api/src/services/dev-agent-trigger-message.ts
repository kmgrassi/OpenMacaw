import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import type { DevAgentTriggerMessageResponse } from "../../../../contracts/dev-agent-trigger-message.js";
import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";

import { loadAgentDiagnostic } from "./diagnostics/agent-diagnostic.js";
import { internalServiceRoleHeaders } from "./internal-service-auth.js";
import type { LauncherClient } from "./launcher.js";
import { attachRuntimeDispatchContext, buildRuntimeDispatchContext } from "./runtime-dispatch-context.js";
import { assertRuntimePrepareSupported } from "./runtime-prepare.js";
import { resolveRuntimeTargetForAgent } from "./runtime-target.js";
import { createUpstreamRequester } from "./upstream.js";
import { assertWorkspaceMembership } from "./work-item-ingest.js";

type MessageSummary = DevAgentTriggerMessageResponse["messagesAfter"];
type RuntimeObservation = DevAgentTriggerMessageResponse["runtimeObservation"];

type AgentMessageRow = {
  id: string;
  role: string;
  created_at: string | null;
};

function summarizeDiagnostic(diagnostic: Awaited<ReturnType<typeof loadAgentDiagnostic>>) {
  return {
    canChat: diagnostic.canChat,
    blockers: diagnostic.blockers,
    runnerKind: diagnostic.executionProfile.profile?.runnerKind ?? null,
    provider: diagnostic.executionProfile.profile?.provider ?? null,
    model: diagnostic.executionProfile.profile?.model ?? null,
    launcherHealthy: diagnostic.launcher.healthy,
  };
}

async function latestMessages(agentId: string, workspaceId: string, limit: number): Promise<AgentMessageRow[]> {
  const { data, error } = await getServiceRoleSupabase()
    .from("message")
    .select("id,role,created_at")
    .eq("agent_id", agentId)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    throw normalizeSupabaseError("dev trigger message query", error);
  }

  return (data ?? []) as AgentMessageRow[];
}

function summarizeMessages(rows: AgentMessageRow[]): MessageSummary {
  const latest = rows[0] ?? null;
  return {
    count: rows.length,
    latestMessageId: latest?.id ?? null,
    latestRole: latest?.role ?? null,
    latestCreatedAt: latest?.created_at ?? null,
  };
}

function gatewayProtocols(accessToken: string) {
  return ["platform.v1", `bearer.${accessToken}`];
}

function wsUrlWithScope(baseUrl: string, input: { agentId: string; workspaceId: string; sessionKey: string }) {
  const url = new URL(baseUrl);
  url.searchParams.set("agent_id", input.agentId);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("session_key", input.sessionKey);
  return String(url);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function sendGatewayMessage(input: {
  accessToken: string;
  agentId: string;
  workspaceId: string;
  sessionKey: string;
  message: string;
  waitMs: number;
}): Promise<{ requestId: string; observation: RuntimeObservation }> {
  const target = await resolveRuntimeTargetForAgent(
    input.agentId,
    createUpstreamRequester(process.env.LAUNCHER_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:4100", 10_000),
  );
  const requestId = randomUUID();
  const runId = randomUUID();
  const started: RuntimeObservation = {
    status: "started",
    runId,
    event: null,
    errorCode: null,
    errorMessage: null,
  };

  const observation = await new Promise<RuntimeObservation>((resolve) => {
    const ws = new WebSocket(wsUrlWithScope(target.wsUrl, input), gatewayProtocols(input.accessToken), {
      headers: internalServiceRoleHeaders(),
    });
    let settled = false;
    let accepted = false;
    let fallback: RuntimeObservation = started;

    function settle(observation: RuntimeObservation) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(observation);
    }

    const timer = setTimeout(() => {
      settle(fallback);
    }, input.waitMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: randomUUID(),
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "platform-dev-trigger-message",
              version: "app-0.1",
              platform: "api",
              mode: "smoke",
            },
            role: "operator",
            scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
            caps: [],
            auth: { token: input.accessToken },
            userAgent: "platform-dev-trigger-message",
            locale: "en-US",
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }

      const record = asRecord(frame);
      if (!record) return;

      if (record.type === "hello-ok") {
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: "chat.send",
            params: {
              agent_id: input.agentId,
              workspace_id: input.workspaceId,
              sessionKey: input.sessionKey,
              message: input.message,
              deliver: false,
              idempotencyKey: runId,
            },
          }),
        );
        return;
      }

      if (record.type === "res" && record.id === requestId) {
        const payload = asRecord(record.payload);
        const returnedRunId = typeof payload?.runId === "string" ? payload.runId : runId;
        if (record.ok === true) {
          accepted = true;
          fallback = {
            status: "message_accepted",
            runId: returnedRunId,
            event: null,
            errorCode: null,
            errorMessage: null,
          };
          return;
        }

        const error = asRecord(record.error);
        settle({
          status: "failed",
          runId: returnedRunId,
          event: null,
          errorCode: typeof error?.code === "string" ? error.code : "gateway_request_failed",
          errorMessage: typeof error?.message === "string" ? error.message : "Gateway rejected chat.send",
        });
        return;
      }

      if (record.type === "event") {
        const payload = asRecord(record.payload);
        const eventRunId = typeof payload?.runId === "string" ? payload.runId : fallback.runId;
        const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : null;
        const errorMessage = typeof payload?.errorMessage === "string" ? payload.errorMessage : null;
        settle({
          status: errorCode || errorMessage ? "failed" : "event_observed",
          runId: eventRunId,
          event: typeof record.event === "string" ? record.event : "event",
          errorCode,
          errorMessage,
        });
      }
    });

    ws.on("error", (error) => {
      settle({
        status: accepted ? "message_accepted" : "failed",
        runId: fallback.runId,
        event: null,
        errorCode: "gateway_unreachable",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  });

  return { requestId, observation };
}

export async function triggerDevAgentMessage(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId: string;
  message: string;
  sessionKey?: string | undefined;
  waitMs: number;
  launcherClient: LauncherClient;
}): Promise<DevAgentTriggerMessageResponse> {
  await assertWorkspaceMembership(input.userId, input.workspaceId);

  const diagnostic = await loadAgentDiagnostic({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    workItemId: null,
  });
  const diagnosticBefore = summarizeDiagnostic(diagnostic);

  if (!diagnostic.canChat) {
    throw new ApiRouteError(409, "diagnostic_blocked", "Agent diagnostic blocked chat trigger", diagnosticBefore);
  }

  const prepared = await assertRuntimePrepareSupported(input.accessToken, input.userId, input.agentId);
  if (!prepared.localRuntime) {
    const dispatchContext = await buildRuntimeDispatchContext({
      accessToken: input.accessToken,
      requesterUserId: input.userId,
      agentId: input.agentId,
      requestBody: { workspaceId: input.workspaceId },
    });
    await input.launcherClient.startAgent(
      input.agentId,
      attachRuntimeDispatchContext({ workspaceId: input.workspaceId }, dispatchContext),
    );
  }

  const before = await latestMessages(input.agentId, input.workspaceId, 1);
  const sessionKey = input.sessionKey ?? `agent:${input.agentId}:main`;
  const { requestId, observation: runtimeObservation } = await sendGatewayMessage({
    accessToken: input.accessToken,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    sessionKey,
    message: input.message,
    waitMs: input.waitMs,
  });
  const after = await latestMessages(input.agentId, input.workspaceId, 10);
  const latestAfter = after[0]?.id ?? null;
  const messageId = latestAfter && latestAfter !== before[0]?.id ? latestAfter : null;

  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    messageId,
    requestId,
    diagnosticBefore,
    runtimeObservation,
    messagesAfter: summarizeMessages(after),
    logSummary: {
      available: false,
      note: "Run pnpm run logs:summary with the returned agentId/requestId for full log correlation.",
    },
  };
}
