import type {
  ChatAbortParams,
  ChatAbortResult,
  ChatEventPayload,
  ChatEventState,
  ChatSendParams,
  ChatSendResult,
} from "./chat";
import type { GatewayError } from "./errors";
import { isRuntimeMessageContent } from "./message-content";
import type { RuntimeEventPayload, RuntimeGatewayEventName } from "./runtime";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GatewayMethodParams = {
  connect: ConnectParams;
  "chat.send": ChatSendParams;
  "chat.abort": ChatAbortParams;
};

export type GatewayMethodResult = {
  connect: GatewayHelloOk;
  "chat.send": ChatSendResult;
  "chat.abort": ChatAbortResult;
};

export type GatewayMethod = keyof GatewayMethodParams;

type KnownGatewayRequestFrame = {
  [Method in GatewayMethod]: {
    type: "req";
    id: string;
    method: Method;
    params: GatewayMethodParams[Method];
  };
}[GatewayMethod];

export type UnknownGatewayRequestFrame = {
  type: "req";
  id: string;
  method: Exclude<string, GatewayMethod>;
  params?: JsonValue;
};

export type GatewayRequestFrame =
  | KnownGatewayRequestFrame
  | UnknownGatewayRequestFrame;

type GatewaySuccessPayload = GatewayMethodResult[GatewayMethod] | JsonValue;

export type GatewaySuccessResponseFrame = {
  type: "res";
  id: string;
  ok: true;
  payload?: GatewaySuccessPayload;
};

export type GatewayErrorResponseFrame = {
  type: "res";
  id: string;
  ok: false;
  error: GatewayError;
};

export type GatewayResponseFrame =
  | GatewaySuccessResponseFrame
  | GatewayErrorResponseFrame;

export type ConnectChallengePayload = {
  nonce: string;
};

export type ConnectChallengeEventFrame = {
  type: "event";
  event: "connect.challenge";
  payload: ConnectChallengePayload;
  seq?: number;
};

export type ChatEventFrame = {
  type: "event";
  event: "chat";
  payload: ChatEventPayload;
  seq?: number;
};

export type RuntimeGatewayEventFrame = {
  type: "event";
  event: RuntimeGatewayEventName;
  payload: RuntimeEventPayload;
  seq?: number;
};

export type UnknownGatewayEventFrame = {
  type: "event";
  event: Exclude<
    string,
    "connect.challenge" | "chat" | RuntimeGatewayEventName
  >;
  payload?: JsonValue;
  seq?: number;
};

export type GatewayEventFrame =
  | ConnectChallengeEventFrame
  | ChatEventFrame
  | RuntimeGatewayEventFrame;

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: { version: string; connId: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: { deviceToken?: string; role?: string; scopes?: string[] };
  policy?: { tickIntervalMs?: number };
};

export type GatewayFrame =
  | GatewayRequestFrame
  | GatewayResponseFrame
  | GatewayEventFrame
  | GatewayHelloOk;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isGatewayError(value: unknown): value is GatewayError {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" && typeof value.message === "string";
}

function isChatEventState(value: unknown): value is ChatEventState {
  return (
    value === "delta" ||
    value === "final" ||
    value === "aborted" ||
    value === "error"
  );
}

function isChatEventPayload(value: unknown): value is ChatEventPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    typeof value.sessionKey === "string" &&
    isChatEventState(value.state) &&
    (value.message === undefined || isRuntimeMessageContent(value.message)) &&
    (value.errorMessage === undefined ||
      typeof value.errorMessage === "string") &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

function isTokenUsagePayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalTokens",
    "total_tokens",
  ].every(
    (key) =>
      value[key] === undefined || optionalNumber(value[key]) !== undefined,
  );
}

export function isRuntimeGatewayEventName(
  value: unknown,
): value is RuntimeGatewayEventName {
  return (
    value === "message.delta" ||
    value === "assistant.delta" ||
    value === "assistant.delta.text" ||
    value === "message.completed" ||
    value === "message.completion" ||
    value === "tool.started" ||
    value === "tool.start" ||
    value === "tool.call.started" ||
    value === "tool_start" ||
    value === "tool.completed" ||
    value === "tool.complete" ||
    value === "tool.completion" ||
    value === "tool.call.completed" ||
    value === "tool_completion" ||
    value === "tool.failed" ||
    value === "tool.failure" ||
    value === "tool.call.failed" ||
    value === "tool_failure" ||
    value === "turn.completed" ||
    value === "turn.completion" ||
    value === "turn_completion" ||
    value === "run.completed" ||
    value === "run.completion" ||
    value === "run_completion" ||
    value === "turn.failed" ||
    value === "turn.failure" ||
    value === "turn_failure" ||
    value === "run.failed" ||
    value === "run.failure" ||
    value === "run_failure" ||
    value === "usage.updated" ||
    value === "usage.update" ||
    value === "usage"
  );
}

function isRuntimeEventPayload(value: unknown): value is RuntimeEventPayload {
  if (!isRecord(value)) return false;

  const stringKeys = [
    "id",
    "eventId",
    "event_id",
    "callId",
    "call_id",
    "sessionKey",
    "session_key",
    "runId",
    "run_id",
    "kind",
    "event",
    "type",
    "phase",
    "state",
    "summary",
    "error",
    "errorMessage",
    "error_code",
    "errorCode",
    "text",
    "toolName",
    "tool_name",
    "name",
    "tool",
  ] as const;

  if (
    stringKeys.some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    )
  ) {
    return false;
  }

  if (
    (value.message !== undefined && !isRuntimeMessageContent(value.message)) ||
    (value.delta !== undefined && !isRuntimeMessageContent(value.delta)) ||
    (value.content !== undefined && !isRuntimeMessageContent(value.content))
  ) {
    return false;
  }

  if (value.usage !== undefined && !isTokenUsagePayload(value.usage)) {
    return false;
  }

  return [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalTokens",
    "total_tokens",
  ].every(
    (key) =>
      value[key] === undefined || optionalNumber(value[key]) !== undefined,
  );
}

function isConnectChallengePayload(
  value: unknown,
): value is ConnectChallengePayload {
  return isRecord(value) && typeof value.nonce === "string";
}

export function gatewayFrameType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return optionalString(value.type);
}

export function parseGatewayEventFrame(
  value: unknown,
): GatewayEventFrame | null {
  if (!isRecord(value) || value.type !== "event") return null;
  const seq = value.seq;
  if (seq !== undefined && optionalNumber(seq) === undefined) return null;

  if (value.event === "connect.challenge") {
    return isConnectChallengePayload(value.payload)
      ? {
          type: "event",
          event: "connect.challenge",
          payload: value.payload,
          seq: optionalNumber(seq),
        }
      : null;
  }

  if (value.event === "chat") {
    return isChatEventPayload(value.payload)
      ? {
          type: "event",
          event: "chat",
          payload: value.payload,
          seq: optionalNumber(seq),
        }
      : null;
  }

  return isRuntimeGatewayEventName(value.event) &&
    isRuntimeEventPayload(value.payload)
    ? {
        type: "event",
        event: value.event,
        payload: value.payload,
        seq: optionalNumber(seq),
      }
    : null;
}

export function parseGatewayHelloOk(value: unknown): GatewayHelloOk | null {
  if (!isRecord(value) || value.type !== "hello-ok") return null;
  const protocol = optionalNumber(value.protocol);
  if (protocol === undefined) return null;

  const server = value.server;
  if (
    server !== undefined &&
    (!isRecord(server) ||
      typeof server.version !== "string" ||
      typeof server.connId !== "string")
  ) {
    return null;
  }

  const features = value.features;
  if (
    features !== undefined &&
    (!isRecord(features) ||
      (features.methods !== undefined &&
        stringArray(features.methods) === null) ||
      (features.events !== undefined && stringArray(features.events) === null))
  ) {
    return null;
  }

  const auth = value.auth;
  if (
    auth !== undefined &&
    (!isRecord(auth) ||
      (auth.deviceToken !== undefined &&
        typeof auth.deviceToken !== "string") ||
      (auth.role !== undefined && typeof auth.role !== "string") ||
      (auth.scopes !== undefined && stringArray(auth.scopes) === null))
  ) {
    return null;
  }

  const policy = value.policy;
  if (
    policy !== undefined &&
    (!isRecord(policy) ||
      (policy.tickIntervalMs !== undefined &&
        optionalNumber(policy.tickIntervalMs) === undefined))
  ) {
    return null;
  }

  return {
    type: "hello-ok",
    protocol,
    server:
      server === undefined
        ? undefined
        : {
            version: server.version as string,
            connId: server.connId as string,
          },
    features:
      features === undefined
        ? undefined
        : {
            methods: stringArray(features.methods) ?? undefined,
            events: stringArray(features.events) ?? undefined,
          },
    snapshot: value.snapshot,
    auth:
      auth === undefined
        ? undefined
        : {
            deviceToken: optionalString(auth.deviceToken),
            role: optionalString(auth.role),
            scopes: stringArray(auth.scopes) ?? undefined,
          },
    policy:
      policy === undefined
        ? undefined
        : { tickIntervalMs: optionalNumber(policy.tickIntervalMs) },
  };
}

export function parseGatewayResponseFrame(
  value: unknown,
): GatewayResponseFrame | null {
  if (!isRecord(value) || value.type !== "res") return null;
  if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return null;
  }

  if (value.ok) {
    return {
      type: "res",
      id: value.id,
      ok: true,
      payload: value.payload as GatewaySuccessPayload | undefined,
    };
  }

  return isGatewayError(value.error)
    ? {
        type: "res",
        id: value.id,
        ok: false,
        error: value.error,
      }
    : null;
}

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  role: string;
  scopes: string[];
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string | undefined;
  };
  caps: string[];
  auth?: { token?: string; password?: string };
  userAgent: string;
  locale: string;
};
