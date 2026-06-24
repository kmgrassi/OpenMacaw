import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  waitForGatewayEvent as waitForGatewayEventFrame,
  waitForGatewayHello as waitForGatewayHelloFrame,
  waitForGatewayResponse as waitForGatewayResponseFrame,
  waitForSocketOpen as waitForSocketReady,
} from "../gateway-ws.mjs";
import { parseResponse, safeJson, sanitizeForArtifact } from "./utils.mjs";

async function prepareRuntime(input) {
  const response = await fetch(
    `${input.apiBaseUrl}/api/agents/${encodeURIComponent(input.agentId)}/start`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: input.workspaceId }),
    },
  );
  const parsed = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `Runtime prepare failed (${response.status}): ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

async function openBrowserGatewaySocket(input, events) {
  const url = new URL("/ws", input.apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agent_id", input.agentId);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("session_key", input.sessionKey);

  const ws = new WebSocket(url, ["platform.v1", `bearer.${input.token}`]);
  await waitForSocketOpen(ws, input.timeoutMs);
  await sendBrowserGatewayConnect(ws, input, events);
  return ws;
}

function waitForSocketOpen(ws, timeoutMs) {
  return waitForSocketReady(ws, { timeoutMs });
}

async function sendBrowserGatewayConnect(ws, input, events) {
  const connectId = `battery-connect-${randomUUID()}`;
  const responsePromise = waitForGatewayHello(
    ws,
    connectId,
    input.timeoutMs,
    events,
  );
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-control-ui",
          version: "app-0.1",
          platform: "node",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
        caps: [],
        auth: { token: input.token },
        userAgent: `node/${process.version}`,
        locale: "en-US",
      },
    }),
  );
  await responsePromise;
}

function waitForGatewayHello(ws, requestId, timeoutMs, events) {
  return waitForGatewayHelloFrame({
    ws,
    requestId,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
  });
}

function waitForGatewayResponse(ws, requestId, timeoutMs, events) {
  return waitForGatewayResponseFrame({
    ws,
    requestId,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
  });
}

function waitForGatewayEvent(ws, timeoutMs, events) {
  return waitForGatewayEventFrame({
    ws,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
    fallbackResult: () => ({
      status: "message_accepted",
      errorCode: null,
      errorMessage: null,
    }),
    onFrameResult: (frame) => {
      if (frame?.type !== "event") return undefined;
      const payload =
        frame.payload && typeof frame.payload === "object" ? frame.payload : {};
      const errorCode =
        typeof payload.errorCode === "string" ? payload.errorCode : null;
      const errorMessage =
        typeof payload.errorMessage === "string" ? payload.errorMessage : null;
      const eventName = typeof frame.event === "string" ? frame.event : null;
      if (
        !errorCode &&
        !errorMessage &&
        eventName !== "chat.completed" &&
        eventName !== "run.completed"
      ) {
        return undefined;
      }
      return {
        status: errorCode || errorMessage ? "failed" : "completed",
        errorCode,
        errorMessage,
      };
    },
  });
}

function rememberGatewayFrame(events, frame) {
  if (!frame || typeof frame !== "object") return;
  events.push({
    type: typeof frame.type === "string" ? frame.type : null,
    id: typeof frame.id === "string" ? frame.id : null,
    event: typeof frame.event === "string" ? frame.event : null,
    ok: typeof frame.ok === "boolean" ? frame.ok : null,
    payloadKeys:
      frame.payload &&
      typeof frame.payload === "object" &&
      !Array.isArray(frame.payload)
        ? Object.keys(frame.payload).sort()
        : [],
    payload:
      frame.payload &&
      typeof frame.payload === "object" &&
      !Array.isArray(frame.payload)
        ? sanitizeForArtifact(frame.payload)
        : null,
    error: frame.error ?? null,
  });
}

export async function sendBrowserGatewayMessage(input) {
  const startedAt = new Date().toISOString();
  const preparation = sanitizeForArtifact(await prepareRuntime(input));
  const requestId = `battery-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const events = [];

  const ws = await openBrowserGatewaySocket(input, events);
  try {
    const responsePromise = waitForGatewayResponse(
      ws,
      requestId,
      input.timeoutMs,
      events,
    );
    const eventPromise = waitForGatewayEvent(ws, input.timeoutMs, events);

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
          idempotencyKey,
        },
      }),
    );

    const response = await responsePromise;
    const runId = response?.runId ?? idempotencyKey;
    const observedEvent = await eventPromise;
    return {
      status: observedEvent?.status ?? "message_accepted",
      requestId,
      runId,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: observedEvent?.errorCode ?? null,
      errorMessage: observedEvent?.errorMessage ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      requestId,
      runId: idempotencyKey,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: "gateway_message_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    ws.close(1000, "manager tool battery complete");
  }
}
