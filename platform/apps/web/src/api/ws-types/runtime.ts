import type { GatewayErrorCode } from "./errors";
import type { ChatEventState } from "./chat";
import type { RuntimeMessageContent } from "./message-content";
import type { SessionKey } from "./scope";

export type RuntimeEventPayload = {
  id?: string;
  eventId?: string;
  event_id?: string;
  callId?: string;
  call_id?: string;
  sessionKey?: SessionKey;
  session_key?: SessionKey | string;
  runId?: string;
  run_id?: string;
  kind?: string;
  event?: string;
  type?: string;
  phase?: string;
  state?: ChatEventState | string;
  message?: RuntimeMessageContent;
  summary?: string;
  error?: string;
  errorMessage?: string;
  error_code?: string;
  errorCode?: GatewayErrorCode | string;
  delta?: RuntimeMessageContent;
  content?: RuntimeMessageContent;
  text?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  tool?: string;
  usage?: TokenUsagePayload;
  inputTokens?: number;
  input_tokens?: number;
  promptTokens?: number;
  prompt_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  completionTokens?: number;
  completion_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
};

export type TokenUsagePayload = {
  inputTokens?: number;
  input_tokens?: number;
  promptTokens?: number;
  prompt_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  completionTokens?: number;
  completion_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
};

export type RuntimeGatewayEventName =
  | "message.delta"
  | "assistant.delta"
  | "assistant.delta.text"
  | "message.completed"
  | "message.completion"
  | "tool.started"
  | "tool.start"
  | "tool.call.started"
  | "tool_start"
  | "tool.completed"
  | "tool.complete"
  | "tool.completion"
  | "tool.call.completed"
  | "tool_completion"
  | "tool.failed"
  | "tool.failure"
  | "tool.call.failed"
  | "tool_failure"
  | "turn.completed"
  | "turn.completion"
  | "turn_completion"
  | "run.completed"
  | "run.completion"
  | "run_completion"
  | "turn.failed"
  | "turn.failure"
  | "turn_failure"
  | "run.failed"
  | "run.failure"
  | "run_failure"
  | "usage.updated"
  | "usage.update"
  | "usage";
