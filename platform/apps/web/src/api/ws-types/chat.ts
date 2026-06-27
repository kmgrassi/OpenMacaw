import type { GatewayErrorCode } from "./errors";
import type { RuntimeMessageContent } from "./message-content";
import type { SessionKey, WsScopeFields } from "./scope";

/**
 * chat.send payload - includes inline scope fields so the engine can
 * validate scope per-request without relying solely on connection-level
 * scope. Matches engine `ScopedChatSendFields`.
 */
export type ChatSendParams = WsScopeFields & {
  sessionKey: SessionKey;
  message: string;
  deliver: boolean;
  idempotencyKey: string;
};

export type ChatSendResult = {
  runId?: string;
  ok?: boolean;
};

export type ChatAbortParams = WsScopeFields & {
  sessionKey: SessionKey;
  runId?: string;
};

export type ChatAbortResult = {
  ok?: boolean;
};

export type ChatEventState = "delta" | "final" | "aborted" | "error";

export type ChatEventPayload = {
  runId: string;
  sessionKey: SessionKey;
  state: ChatEventState;
  message?: RuntimeMessageContent;
  errorMessage?: string;
  /** Machine-readable error code for run failures (e.g. provider_not_configured_for_agent). */
  errorCode?: GatewayErrorCode | string;
};
