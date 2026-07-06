import type { GatewayRequest, SessionsListResponse } from "./ws-types";

export type OrchestratorSession = {
  key: string;
  id?: string;
  agentId?: string;
  sessionId?: string;
  kind: string;
  label?: string;
  displayName?: string;
  surface?: string;
  updatedAt: number | null;
  lastMessageAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
};

export type OrchestratorSessionsResult = {
  ts: number;
  count: number;
  sessions: OrchestratorSession[];
};

export async function listOrchestratorSessions(
  request: GatewayRequest,
  limit = 50,
): Promise<OrchestratorSessionsResult> {
  const result = await request<SessionsListResponse | undefined>(
    "sessions.list",
    {
      includeGlobal: false,
      includeUnknown: true,
      limit,
    },
  );

  const sessions = (result?.sessions ?? []).map((session) => ({
    key: session.key,
    id: session.id ?? session.sessionId,
    agentId: session.agentId,
    sessionId: session.sessionId,
    kind: session.kind ?? "unknown",
    label: session.label,
    displayName: session.displayName,
    surface: session.surface,
    updatedAt: session.updatedAt ?? null,
    lastMessageAt: session.lastMessageAt,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    totalTokens: session.totalTokens,
    model: session.model,
  }));

  return {
    ts: result?.ts ?? Date.now(),
    count: result?.count ?? sessions.length,
    sessions,
  };
}

export async function hasOrchestratorSessions(
  request: GatewayRequest,
): Promise<boolean> {
  const result = await listOrchestratorSessions(request, 1);
  return result.count > 0 || result.sessions.length > 0;
}
