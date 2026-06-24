import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAgentDiagnostic,
  type AgentDiagnosticResponse,
} from "./agent-diagnostic";

export type UseAgentDiagnosticResult = {
  data: AgentDiagnosticResponse | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<AgentDiagnosticFetchResult>;
};

export type AgentDiagnosticFetchResult =
  | { ok: true; data: AgentDiagnosticResponse | null }
  | { ok: false; error: Error };

/**
 * One-shot diagnostic fetch for an agent. Designed for the gateway WS
 * close-handler flow: callers mount this hook (often inside a banner that
 * only renders after an abnormal close) and get a single request. There is
 * no polling here — `refetch` is exposed for manual retries.
 *
 * Uses the user's Supabase bearer token via the default `apiFetch` auth
 * path. The diagnostic endpoint is permissive on auth but we still send
 * the token so the workspace scope can be matched to the caller.
 */
export function useAgentDiagnostic(
  agentId: string | null | undefined,
  workspaceId: string | null | undefined,
): UseAgentDiagnosticResult {
  const [data, setData] = useState<AgentDiagnosticResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!agentId) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return { ok: true, data: null } satisfies AgentDiagnosticFetchResult;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getAgentDiagnostic(agentId, workspaceId ?? null);
      if (requestIdRef.current !== requestId) {
        return { ok: true, data: null } satisfies AgentDiagnosticFetchResult;
      }
      setData(result);
      return { ok: true, data: result } satisfies AgentDiagnosticFetchResult;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (requestIdRef.current !== requestId) {
        return { ok: false, error } satisfies AgentDiagnosticFetchResult;
      }
      setError(error);
      return { ok: false, error } satisfies AgentDiagnosticFetchResult;
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
    return { ok: true, data: null } satisfies AgentDiagnosticFetchResult;
  }, [agentId, workspaceId]);

  useEffect(() => {
    void fetchOnce();
    // We deliberately re-fetch only when the agent or workspace changes.
    // The component remounts on each abnormal close event (via a key
    // prop), so the effect runs once per close.
  }, [fetchOnce]);

  const refetch = useCallback(async () => {
    return await fetchOnce();
  }, [fetchOnce]);

  return { data, isLoading, error, refetch };
}
