import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGatewayContext } from "../context/GatewayContext";
import type { AgentId, GatewayEventFrame, SessionKey } from "../api/ws-types";
import {
  LOCAL_CODING_ERROR_CODES,
  PROVIDER_ERROR_CODES,
} from "../api/ws-types";
import { prepareRuntime } from "../api/broker-runtime";
import {
  fetchAgentMessages,
  type ChatMessage,
  type ChatMessagesPage,
} from "../api/messages";
import { invalidateRuntimeQueries } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";
import {
  prependOlderMessages,
  useAbortMessageMutation,
  useMessagesQuery,
  useSendMessageMutation,
} from "./useMessageQueries";
import {
  normalizeRuntimeEvent,
  runtimeEventMatchesActiveRun,
  runtimeEventRunId,
  type RuntimeTimelineEvent,
} from "../lib/runtime-events";

/**
 * Chat hook — uses an explicit sessionKey when provided (e.g. from sidebar
 * session selection), otherwise falls back to the resolved gateway scope.
 * If neither is available the hook is inert: send/abort surface an error.
 */
export function useChat(
  agentId: AgentId,
  sessionKeyOverride?: SessionKey | string,
  options: { historyOnly?: boolean } = {},
) {
  const { connected, scope, request, addEventListener } = useGatewayContext();
  const queryClient = useQueryClient();
  const sessionKey: SessionKey | null =
    (sessionKeyOverride as SessionKey | undefined) ?? scope?.sessionKey ?? null;

  const [streamText, setStreamText] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeTimelineEvent[]>(
    [],
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const messagesQuery = useMessagesQuery(agentId, sessionKey, {
    enabled: connected || options.historyOnly,
  });
  const sendMutation = useSendMessageMutation({
    agentId,
    scope,
    sessionKey,
    request,
  });
  const abortMutation = useAbortMessageMutation({
    agentId,
    scope,
    sessionKey,
    request,
    getRunId: () => runIdRef.current,
  });

  const reconcilePersistedResponse = useCallback(
    async (runId: string, targetSessionKey: SessionKey) => {
      const queryKey = queryKeys.messages.history(agentId, targetSessionKey);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!runtimeEventMatchesActiveRun(runIdRef.current, runId)) return;
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }

        const page = await fetchAgentMessages(agentId);
        queryClient.setQueryData<ChatMessagesPage>(queryKey, page);

        const hasPersistedAssistant = page.messages.some((message) => {
          if (message.role !== "assistant") return false;
          return message.runId === runId;
        });

        if (hasPersistedAssistant) {
          if (runtimeEventMatchesActiveRun(runIdRef.current, runId)) {
            setStreamText(null);
            setActiveRunId(null);
            runIdRef.current = null;
          }
          void invalidateRuntimeQueries(queryClient, agentId, targetSessionKey);
          return;
        }
      }
    },
    [agentId, queryClient],
  );

  useEffect(() => {
    if (messagesQuery.error) {
      setError((messagesQuery.error as Error).message);
    }
  }, [messagesQuery.error]);

  // Listen for chat events
  useEffect(() => {
    if (!sessionKey) return;
    const handler = (evt: GatewayEventFrame) => {
      const normalized = normalizeRuntimeEvent(evt, sessionKey);
      if (!normalized) return;
      const eventRunId = runtimeEventRunId(evt, normalized);
      if (!runtimeEventMatchesActiveRun(runIdRef.current, eventRunId)) {
        return;
      }
      console.debug("[useChat] received runtime event", {
        agentId,
        sessionKey,
        event: evt.event,
        state: evt.event === "chat" ? evt.payload.state : undefined,
        runId: eventRunId,
      });

      if (normalized.timelineEvent) {
        const event = normalized.timelineEvent;
        setRuntimeEvents((current) => [...current, event].slice(-80));
      }

      if (normalized.assistantDelta) {
        setStreamText(
          (current) => `${current ?? ""}${normalized.assistantDelta}`,
        );
      }

      if (normalized.final) {
        setStreamText(null);
        setActiveRunId(null);
        runIdRef.current = null;
        void invalidateRuntimeQueries(queryClient, agentId, sessionKey);
      }

      if (normalized.aborted) {
        setStreamText(null);
        setActiveRunId(null);
        runIdRef.current = null;
        void invalidateRuntimeQueries(queryClient, agentId, sessionKey);
      }

      if (normalized.error) {
        setStreamText(null);
        setActiveRunId(null);
        runIdRef.current = null;
        setError(normalized.error.message);
        setErrorCode(normalized.error.code);
        void invalidateRuntimeQueries(queryClient, agentId, sessionKey);
      }
    };
    return addEventListener(handler);
  }, [agentId, sessionKey, addEventListener, queryClient]);

  // Recover the composer after a mid-run disconnect. When the socket drops
  // while a run is in flight, the terminal `final` frame for that run never
  // reaches the browser, and the post-send reconcile loop has usually already
  // given up — a local-relay turn can outlast its ~8s budget by tens of
  // seconds. On every (re)connect with a run still marked active, reconcile
  // against persisted history: a run that finished during the gap clears
  // `activeRunId` instead of leaving the composer stuck "sending" forever.
  useEffect(() => {
    if (!connected || !sessionKey) return;
    const runId = runIdRef.current;
    if (!runId) return;
    void reconcilePersistedResponse(runId, sessionKey);
  }, [connected, sessionKey, reconcilePersistedResponse]);

  // Render the user's message immediately. prepareRuntime + chat.send take a
  // beat (the agent-start round-trip alone is ~0.5s), and without instant
  // feedback the message looks dropped and users re-send. Insert an optimistic
  // user bubble into the history cache and return a rollback for the failure
  // paths; the persisted message replaces it on the next history refetch.
  //
  // Cancel any in-flight history fetch first: if useMessagesQuery is loading or
  // refetching when the user sends, its response would land after this write
  // and clobber the optimistic bubble (it isn't persisted yet) until a later
  // reconcile. cancelQueries keeps the just-rendered message in place.
  const insertOptimisticUserMessage = useCallback(
    async (
      targetSessionKey: SessionKey,
      content: string,
    ): Promise<() => void> => {
      const queryKey = queryKeys.messages.history(agentId, targetSessionKey);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ChatMessagesPage>(queryKey);
      const optimisticMessage: ChatMessage = {
        role: "user",
        content,
        timestamp: Date.now(),
      };
      queryClient.setQueryData<ChatMessagesPage>(queryKey, (current) => ({
        messages: [...(current?.messages ?? []), optimisticMessage],
        pageInfo: current?.pageInfo ?? {
          limit: 30,
          hasMore: false,
          nextCursor: null,
        },
      }));
      return () => queryClient.setQueryData(queryKey, previous);
    },
    [agentId, queryClient],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const msg = text.trim();
      if (!msg) return;
      if (options.historyOnly) {
        setError("This transcript is read-only.");
        return;
      }

      // Fail fast: scope must be resolved before we show anything optimistic.
      if (!connected || !sessionKey || !scope) {
        console.warn("[useChat] send blocked; runtime not connected", {
          agentId,
          connected,
          sessionKey,
          scope,
        });
        setError("Runtime is starting. Retry in a moment.");
        return;
      }

      // Optimistic UI first — before the prepareRuntime/chat.send round-trip —
      // so the user immediately sees their message and a pending assistant, and
      // the composer locks (submitting) against accidental double-sends. The
      // composer-lock state is set synchronously so the lock is instant; the
      // bubble insert awaits cancelQueries (a local op) a tick later.
      setError(null);
      setErrorCode(null);
      setStreamText("");
      setRuntimeEvents([]);

      const idempotencyKey = crypto.randomUUID();
      runIdRef.current = idempotencyKey;
      setActiveRunId(idempotencyKey);

      const rollbackOptimistic = await insertOptimisticUserMessage(
        sessionKey,
        msg,
      );

      const rollback = () => {
        rollbackOptimistic();
        setStreamText(null);
        setActiveRunId(null);
        runIdRef.current = null;
      };

      const preparation = await prepareRuntime(agentId);
      if (!preparation.readyToConnect) {
        rollback();
        setError(
          preparation.reasons.length > 0
            ? `Runtime not ready: ${preparation.reasons.join(", ")}`
            : "Runtime not ready.",
        );
        return;
      }

      try {
        console.debug("[useChat] sending chat message", {
          agentId,
          sessionKey,
          idempotencyKey,
        });
        const { result } = await sendMutation.mutateAsync({
          message: msg,
          idempotencyKey,
        });
        if (runIdRef.current) {
          const runId = result?.runId ?? idempotencyKey;
          runIdRef.current = runId;
          setActiveRunId(runId);
          void reconcilePersistedResponse(runId, sessionKey);
        }
      } catch (err) {
        if (!runIdRef.current) return;
        rollback();
        const errMsg = (err as Error).message;
        setError(errMsg);
        // Try to extract a machine-readable error code from the rejection.
        // GatewayClient rejects with the error message; check if the message
        // itself matches a known provider error code pattern.
        const code = (err as { code?: string }).code ?? null;
        const detectedCode =
          code ??
          (PROVIDER_ERROR_CODES as readonly string[]).find((c) =>
            errMsg.includes(c),
          ) ??
          (LOCAL_CODING_ERROR_CODES as readonly string[]).find((c) =>
            errMsg.includes(c),
          ) ??
          null;
        setErrorCode(detectedCode);
      }
    },
    [
      agentId,
      connected,
      insertOptimisticUserMessage,
      options.historyOnly,
      reconcilePersistedResponse,
      sessionKey,
      scope,
      sendMutation,
    ],
  );

  const abort = useCallback(async () => {
    if (options.historyOnly || !sessionKey || !scope) return;
    try {
      await abortMutation.mutateAsync();
    } catch {
      // best effort
    }
  }, [abortMutation, options.historyOnly, sessionKey, scope]);

  const loadOlderMessages = useCallback(async () => {
    if (!sessionKey || !agentId || loadingOlderMessages) return;
    const cursor = messagesQuery.data?.pageInfo.nextCursor;
    if (!cursor) return;

    setLoadingOlderMessages(true);
    setError(null);
    try {
      const olderPage = await fetchAgentMessages(agentId, cursor);
      queryClient.setQueryData<ChatMessagesPage>(
        queryKeys.messages.history(agentId, sessionKey),
        (current) => prependOlderMessages(current, olderPage),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [
    agentId,
    loadingOlderMessages,
    messagesQuery.data?.pageInfo.nextCursor,
    queryClient,
    sessionKey,
  ]);

  return {
    messages: messagesQuery.data?.messages ?? [],
    streamText,
    runtimeEvents,
    sending: streamText !== null || activeRunId !== null,
    loading: messagesQuery.isLoading || messagesQuery.isFetching,
    loadingOlderMessages,
    hasMoreOlderMessages: messagesQuery.data?.pageInfo.hasMore ?? false,
    error,
    errorCode,
    sendMessage,
    abort,
    loadHistory: messagesQuery.refetch,
    loadOlderMessages,
  };
}
