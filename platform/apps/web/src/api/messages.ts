import { brokerFetch } from "./broker-fetch";
import { resolveBrokerBase } from "./broker";
import { ROUTES } from "./routes";
import {
  AgentMessagesResponseSchema,
  type AgentMessage,
  type AgentMessageToolCall,
  type AgentMessagesResponse,
} from "../../../../contracts/messages";

export type ChatMessage = {
  id?: string;
  role: string;
  content: string;
  metadata?: unknown;
  toolCalls?: AgentMessageToolCall[];
  timestamp?: number;
  runId?: string | null;
};

export type ChatMessagesPage = {
  messages: ChatMessage[];
  pageInfo: AgentMessagesResponse["pageInfo"];
};

export function normalizeMessages(raw: AgentMessage[]): ChatMessage[] {
  return raw.map((msg) => {
    const parsedCreatedAt = msg.createdAt ? Date.parse(msg.createdAt) : NaN;
    const timestamp =
      msg.timestamp ??
      (Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : undefined);
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata,
      toolCalls: msg.toolCalls,
      timestamp,
      runId: msg.runId,
    };
  });
}

export async function fetchAgentMessages(
  agentId: string,
  before?: string | null,
): Promise<ChatMessagesPage> {
  const res = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.agentMessages(agentId, before)}`,
    { method: "GET" },
  );
  if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
  const body = AgentMessagesResponseSchema.parse(await res.json());
  return {
    messages: normalizeMessages(body.messages).reverse(),
    pageInfo: body.pageInfo,
  };
}
