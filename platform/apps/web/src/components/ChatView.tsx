import { useCallback, useRef, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { useGatewayContext } from "../context/GatewayContext";
import { useAuthStore } from "../stores/auth";
import { PROVIDER_ERROR_CODES } from "../api/ws-types";
import type { AgentActivationState } from "./AgentList";
import { ChatMessage } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import {
  ApprovalRequiredNotice,
  isApprovalRequiredText,
} from "./ApprovalRequiredNotice";
import { RuntimeEventTimeline } from "./RuntimeEventTimeline";
import { AgentHealthBanner } from "./dashboard/AgentHealthBanner";
import { SessionPolicyPanel } from "./policies/SessionPolicyPanel";
import { Button } from "./ui/Button";
import { LoadingState } from "./ui/LoadingState";
import { StatusBanner } from "./ui/StatusBanner";

const STARTER_TASKS = [
  {
    label: "Fix a bug",
    prompt: "Help me investigate and fix a bug in this repo.",
  },
  {
    label: "Open PR",
    prompt: "Prepare my current changes for review and open a PR.",
  },
  {
    label: "Run tests",
    prompt: "Run the relevant tests for this repo and summarize the results.",
  },
  {
    label: "Inspect repo",
    prompt:
      "Inspect this repo and summarize the important structure and next steps.",
  },
] as const;

type Props = {
  agentId: string;
  /** When provided, targets this session instead of the default scope session. */
  sessionKey?: string;
  workspaceId?: string | null;
  hasCredentials?: boolean;
  activationState?: AgentActivationState | null;
  readOnly?: boolean;
};

function isProviderError(
  errorCode: string | null,
  errorText: string | null,
): boolean {
  if (
    errorCode &&
    (PROVIDER_ERROR_CODES as readonly string[]).includes(errorCode)
  )
    return true;
  if (errorText) {
    return (PROVIDER_ERROR_CODES as readonly string[]).some((c) =>
      errorText.includes(c),
    );
  }
  return false;
}

function isApprovalRequiredError(
  errorCode: string | null,
  errorText: string | null,
): boolean {
  return errorCode === "approval_required" || isApprovalRequiredText(errorText);
}

export function ChatView({
  agentId,
  sessionKey,
  workspaceId,
  hasCredentials = false,
  activationState,
  readOnly = false,
}: Props) {
  const { connected, scope, status, diagnostics, connect } =
    useGatewayContext();
  const lastAbnormalCloseAt = diagnostics.lastAbnormalCloseAt;
  const lastCloseCode = diagnostics.lastCloseCode;
  // Track which abnormal-close event the user has dismissed. The banner
  // re-appears only when a new close event arrives (i.e. a different
  // timestamp), not on every render.
  const [dismissedCloseAt, setDismissedCloseAt] = useState<number | null>(null);
  const showHealthBanner =
    !readOnly &&
    lastAbnormalCloseAt !== null &&
    lastAbnormalCloseAt !== dismissedCloseAt;
  const providerWarnings = useAuthStore((s) => s.providerWarnings);
  const {
    messages,
    streamText,
    runtimeEvents,
    sending,
    loading,
    loadingOlderMessages,
    hasMoreOlderMessages,
    error,
    errorCode,
    sendMessage,
    loadOlderMessages,
  } = useChat(agentId, sessionKey, { historyOnly: readOnly });
  const [composerText, setComposerText] = useState("");
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [showPolicies, setShowPolicies] = useState(false);
  const [bottomOverlayEl, setBottomOverlayEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [bottomOverlayHeight, setBottomOverlayHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const olderMessagesScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const navigate = useNavigate();
  const hasChatScope = Boolean(
    scope || (!readOnly && sessionKey && workspaceId),
  );
  const waitingForHistory =
    !readOnly && hasChatScope && !connected && status !== "error";
  const composerDisabled =
    readOnly || !scope || !connected || status !== "connected";

  // Auto-scroll on new messages or stream updates
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const olderMessagesScroll = olderMessagesScrollRef.current;
    if (olderMessagesScroll) {
      el.scrollTop =
        el.scrollHeight -
        olderMessagesScroll.scrollHeight +
        olderMessagesScroll.scrollTop;
      olderMessagesScrollRef.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, streamText]);

  useEffect(() => {
    if (!loadingOlderMessages && olderMessagesScrollRef.current) {
      olderMessagesScrollRef.current = null;
    }
  }, [loadingOlderMessages]);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (
      !el ||
      loading ||
      loadingOlderMessages ||
      !hasMoreOlderMessages ||
      el.scrollTop > 48
    ) {
      return;
    }

    olderMessagesScrollRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    void loadOlderMessages();
  }, [hasMoreOlderMessages, loadOlderMessages, loading, loadingOlderMessages]);

  const setBottomOverlayNode = useCallback((node: HTMLDivElement | null) => {
    setBottomOverlayEl(node);
    if (!node) setBottomOverlayHeight(0);
  }, []);

  useEffect(() => {
    if (!bottomOverlayEl) return;
    const updateHeight = () => {
      setBottomOverlayHeight(bottomOverlayEl.getBoundingClientRect().height);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(bottomOverlayEl);

    return () => observer.disconnect();
  }, [bottomOverlayEl]);

  const handleStarterClick = (prompt: string) => {
    setComposerText(prompt);
    setComposerFocusToken((token) => token + 1);
  };

  if (!readOnly && status === "resolving_scope" && !hasChatScope) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Resolving runtime scope...
      </div>
    );
  }

  if ((!readOnly && !hasChatScope) || !workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        No agent configured. Complete setup to start chatting.
      </div>
    );
  }

  if (!readOnly && status === "error") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Runtime connection lost. Reconnecting...
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Messages */}
      <div
        ref={scrollRef}
        tabIndex={0}
        aria-label="Chat messages"
        onScroll={handleMessagesScroll}
        className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pt-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:px-4 sm:pt-2"
        style={{ paddingBottom: bottomOverlayHeight + 12 }}
      >
        {!readOnly && sessionKey && (
          <div className="mx-auto mb-3 flex max-w-4xl justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowPolicies((value) => !value)}
            >
              {showPolicies ? "Hide policies" : "Session policies"}
            </Button>
          </div>
        )}

        {!readOnly && showPolicies && (
          <SessionPolicyPanel
            sessionThreadId={sessionKey}
            workspaceId={workspaceId}
          />
        )}

        {(loading || waitingForHistory) && messages.length === 0 && (
          <LoadingState
            label="Loading history..."
            className="flex items-center justify-center py-3"
          />
        )}

        {!loading && !waitingForHistory && messages.length === 0 && (
          <div className="mx-auto flex max-w-3xl flex-col gap-3 py-4">
            <div className="text-sm font-medium text-slate-300">
              {readOnly
                ? "No manager transcript yet"
                : "Start with a common task"}
            </div>
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                {STARTER_TASKS.map((task) => (
                  <Button
                    key={task.label}
                    type="button"
                    onClick={() => handleStarterClick(task.prompt)}
                    disabled={composerDisabled}
                    variant="secondary"
                    size="sm"
                    className="px-3 py-1.5 text-sm hover:border-slate-600"
                  >
                    {task.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mx-auto max-w-4xl space-y-2 pb-3">
          {loadingOlderMessages && messages.length > 0 && (
            <LoadingState
              label="Loading older messages..."
              className="flex items-center justify-center py-1.5"
            />
          )}

          {messages.map((msg, i) => (
            <ChatMessage
              key={msg.id ?? `${msg.timestamp}-${i}`}
              role={msg.role}
              content={msg.content}
              metadata={msg.metadata}
              toolCalls={msg.toolCalls}
              timestamp={msg.timestamp}
            />
          ))}

          {/* Streaming response */}
          {streamText !== null && (
            <ChatMessage
              role="assistant"
              content={streamText}
              pending={streamText.length === 0}
            />
          )}

          <RuntimeEventTimeline events={runtimeEvents} />
        </div>
      </div>

      <div
        ref={setBottomOverlayNode}
        className="absolute inset-x-0 bottom-0 z-10"
      >
        {showHealthBanner && lastAbnormalCloseAt !== null && (
          <AgentHealthBanner
            key={lastAbnormalCloseAt}
            agentId={agentId}
            workspaceId={workspaceId ?? null}
            reason="ws_close_abnormal"
            closeCode={lastCloseCode}
            onDismiss={() => setDismissedCloseAt(lastAbnormalCloseAt)}
            onReconnect={connect}
          />
        )}

        {/* Error banner */}
        {error && isApprovalRequiredError(errorCode, error) && (
          <StatusBanner
            tone="warning"
            placement="bottom"
            density="compact"
            backdrop
            contentClassName="block"
          >
            <ApprovalRequiredNotice
              message={error}
              onConfigure={() => navigate("/settings/agents")}
            />
          </StatusBanner>
        )}

        {error && !isApprovalRequiredError(errorCode, error) && (
          <StatusBanner
            tone="error"
            placement="bottom"
            density="compact"
            backdrop
            contentClassName="gap-2 md:flex-row md:items-center md:justify-start"
            actions={
              isProviderError(errorCode, error) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/settings/agents")}
                  className="bg-red-800/60 px-2 py-0.5 text-xs text-red-200 hover:bg-red-700/60 hover:text-red-100"
                >
                  Configure credentials
                </Button>
              ) : null
            }
            actionsClassName="md:ml-0"
          >
            <span>{error}</span>
          </StatusBanner>
        )}

        {!error && activationState?.phase === "activating" && (
          <StatusBanner
            tone="info"
            placement="bottom"
            density="compact"
            backdrop
          >
            {activationState.message}
          </StatusBanner>
        )}

        {!error && activationState?.phase === "ready" && (
          <StatusBanner
            tone="success"
            placement="bottom"
            density="compact"
            backdrop
          >
            {activationState.message}
          </StatusBanner>
        )}

        {!error && activationState?.phase === "error" && (
          <StatusBanner
            tone="error"
            placement="bottom"
            density="compact"
            backdrop
          >
            {activationState.message}
          </StatusBanner>
        )}

        {/* Provider warning — shown when connected but credentials/model missing */}
        {!readOnly &&
          !error &&
          (providerWarnings.length > 0 || !hasCredentials) && (
            <StatusBanner
              tone="warning"
              placement="bottom"
              density="compact"
              backdrop
              contentClassName="gap-2 md:flex-row md:items-center md:justify-start"
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/settings/agents")}
                  className="bg-amber-800/60 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-700/60 hover:text-amber-100"
                >
                  Add credentials
                </Button>
              }
              actionsClassName="md:ml-0"
            >
              <span>
                {!hasCredentials
                  ? "No usable credentials are configured for this agent yet."
                  : "Provider credentials not configured. Messages may fail until configured."}
              </span>
            </StatusBanner>
          )}

        {!readOnly && (
          <ChatComposer
            text={composerText}
            onTextChange={setComposerText}
            onSend={sendMessage}
            disabled={composerDisabled}
            submitting={streamText !== null || sending}
            focusToken={composerFocusToken}
          />
        )}
      </div>
    </div>
  );
}
