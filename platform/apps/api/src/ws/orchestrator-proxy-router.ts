import { WebSocket } from "ws";

import { errorMessage } from "../logger.js";
import type { RequestContext } from "../request-context-store.js";

import { logWebSocketEvent } from "./orchestrator-proxy-context.js";

export type PendingWebSocketMessage = {
  data: WebSocket.Data;
  isBinary: boolean;
};

function normalizeCloseCode(code: number, fallback: number) {
  if (code === 1000) return code;
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

function normalizeCloseReason(value: unknown, fallback: string) {
  return value instanceof Buffer ? value.toString() : fallback;
}

function formatCloseReason(value: Buffer) {
  return value.length > 0 ? value.toString() : null;
}

function byteLength(data: WebSocket.Data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((total, entry) => total + entry.length, 0);
}

function closeEventName(code: number) {
  return code === 1000 ? "gateway_ws_closed" : "gateway_ws_abnormal_closed";
}

function closeEventPayload(
  connectionSide: "client" | "upstream",
  agentId: string | null,
  code: number,
  reason: Buffer,
  counters: {
    downstream_message_count: number;
    downstream_byte_count: number;
    upstream_message_count: number;
    upstream_byte_count: number;
  },
) {
  return {
    event: closeEventName(code),
    connection_side: connectionSide,
    agent_id: agentId,
    close_code: code,
    close_reason: formatCloseReason(reason),
    abnormal: code !== 1000,
    ...counters,
  } satisfies Parameters<typeof logWebSocketEvent>[1];
}

export function bindWebSocketPair(
  clientSocket: WebSocket,
  upstream: WebSocket,
  context: RequestContext,
  agentId: string | null,
  pendingMessages: PendingWebSocketMessage[] = [],
  detachPendingBuffer?: () => void,
) {
  const counters = {
    downstream_message_count: 0,
    downstream_byte_count: 0,
    upstream_message_count: 0,
    upstream_byte_count: 0,
  };
  const cleanup = () => {
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CLOSING) {
      clientSocket.terminate();
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CLOSING) {
      upstream.terminate();
    }
  };

  clientSocket.on("message", (data: WebSocket.Data, isBinary: boolean) => {
    counters.upstream_message_count += 1;
    counters.upstream_byte_count += byteLength(data);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on("message", (data: WebSocket.Data, isBinary: boolean) => {
    counters.downstream_message_count += 1;
    counters.downstream_byte_count += byteLength(data);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });

  clientSocket.on("close", (code, reason) => {
    logWebSocketEvent(context, closeEventPayload("client", agentId, code, reason, counters));
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(normalizeCloseCode(code, 1000), normalizeCloseReason(reason, "client closed"));
    }
  });

  upstream.on("close", (code, reason) => {
    logWebSocketEvent(context, closeEventPayload("upstream", agentId, code, reason, counters));
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(normalizeCloseCode(code, 1011), normalizeCloseReason(reason, "upstream closed"));
    }
  });

  clientSocket.on("error", (error) => {
    logWebSocketEvent(context, {
      event: "gateway_ws_client_error",
      level: "error",
      connection_side: "client",
      agent_id: agentId,
      error: errorMessage(error),
    });
  });

  upstream.on("error", (error) => {
    logWebSocketEvent(context, {
      event: "gateway_ws_upstream_error",
      level: "error",
      connection_side: "upstream",
      agent_id: agentId,
      error: errorMessage(error),
    });
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(1011, "upstream websocket error");
    }
    cleanup();
  });

  clientSocket.once("close", cleanup);
  upstream.once("close", cleanup);

  if (detachPendingBuffer) {
    detachPendingBuffer();
  }
  for (const { data, isBinary } of pendingMessages) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      counters.downstream_message_count += 1;
      counters.downstream_byte_count += byteLength(data);
      clientSocket.send(data, { binary: isBinary });
    }
  }
}
