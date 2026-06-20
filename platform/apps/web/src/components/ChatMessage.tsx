import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentMessageToolCall } from "../../../../contracts/messages";
import { copyTextToClipboard } from "../lib/clipboard";
import { getManagerSchedulerMessageDisplay } from "../lib/manager-message-rendering";
import {
  formatPersistedToolCalls,
  type ToolCallDisplay,
} from "../lib/tool-call-rendering";
import { Badge } from "./ui/Badge";
import { Card } from "./ui/Card";
import { IconButton } from "./ui/IconButton";

// Links rendered inside chat content open in a new tab instead of taking over
// the app window. DOMPurify is only used here (chat markdown), so a single
// global hook scopes cleanly to chat content.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

type Props = {
  role: string;
  content: string;
  metadata?: unknown;
  toolCalls?: AgentMessageToolCall[];
  timestamp?: number;
  pending?: boolean;
};

function PendingEllipsis() {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setDotCount((current) => (current === 3 ? 1 : current + 1));
    }, 450);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <span
      aria-label="Assistant response pending"
      className="inline-block w-[3ch] text-slate-400"
    >
      {".".repeat(dotCount)}
    </span>
  );
}

function ToolCallList({ toolCalls }: { toolCalls: ToolCallDisplay[] }) {
  if (toolCalls.length === 0) return null;

  const summaryLabel =
    toolCalls.length === 1
      ? (toolCalls[0]?.label ?? "1 tool call")
      : `${toolCalls.length} tool calls`;

  return (
    <details className="group/tools mt-2 rounded border border-slate-800 bg-black/20">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200">
        <span className="text-[10px] text-slate-500 transition-transform group-open/tools:rotate-90">
          ▶
        </span>
        <span className="text-cyan-300/80">🔧</span>
        <span>{summaryLabel}</span>
      </summary>
      <div className="space-y-1.5 px-2 pb-2">
        {toolCalls.map((toolCall, index) => (
          <Card
            key={`${toolCall.label}-${index}`}
            padding="sm"
            tone="info"
            className="px-2 py-1.5 text-xs text-cyan-50"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{toolCall.label}</span>
              {toolCall.status && (
                <Badge
                  value={toolCall.status}
                  variant="info"
                  className="px-1.5 py-0.5 text-[10px] uppercase"
                >
                  {toolCall.status}
                </Badge>
              )}
            </div>
            {toolCall.inputSummary && (
              <div className="mt-1 break-words font-mono text-[11px] leading-snug text-cyan-100/80">
                Input: {toolCall.inputSummary}
              </div>
            )}
            {toolCall.outputSummary && (
              <div className="mt-1 break-words font-mono text-[11px] leading-snug text-cyan-100/70">
                Output: {toolCall.outputSummary}
              </div>
            )}
          </Card>
        ))}
      </div>
    </details>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ChatMessage({
  role,
  content,
  metadata,
  toolCalls,
  timestamp,
  pending = false,
}: Props) {
  const managerDisplay = useMemo(
    () => getManagerSchedulerMessageDisplay(content, metadata, toolCalls),
    [content, metadata, toolCalls],
  );
  const persistedToolCallDisplay = useMemo(
    () => (managerDisplay ? [] : formatPersistedToolCalls(toolCalls)),
    [managerDisplay, toolCalls],
  );
  const html = useMemo(() => {
    if (pending) return "";
    if (managerDisplay) return "";
    if (!content) return "";
    const raw = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [content, managerDisplay, pending]);

  const isUser = role === "user";
  const [copied, setCopied] = useState(false);
  const canCopy = !pending && content.length > 0;
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`group flex min-w-0 ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`relative min-w-0 max-w-[88%] text-sm leading-relaxed sm:max-w-[min(44rem,84%)] ${
          isUser
            ? "rounded-xl border border-blue-400/20 bg-blue-500/18 px-3.5 py-2 text-blue-50 shadow-sm"
            : "border-l border-slate-800/80 px-3 py-1 text-slate-200"
        }`}
      >
        {canCopy && (
          <IconButton
            aria-label={copied ? "Message copied" : "Copy message"}
            title={copied ? "Copied" : "Copy message"}
            size="sm"
            variant="ghost"
            onClick={() => {
              void copyTextToClipboard(content).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            className={`absolute top-1 z-10 h-6 w-6 border border-slate-700/80 bg-slate-950/90 text-slate-400 opacity-0 shadow-sm transition-opacity hover:border-slate-600 hover:bg-slate-900 hover:text-slate-100 focus-visible:opacity-100 group-hover:opacity-100 ${
              isUser ? "-left-8" : "-right-8"
            }`}
          >
            {copied ? (
              <span aria-hidden="true" className="text-[11px] leading-none">
                ✓
              </span>
            ) : (
              <CopyIcon />
            )}
          </IconButton>
        )}
        {pending ? (
          <div className="prose prose-sm prose-invert max-w-none">
            <PendingEllipsis />
          </div>
        ) : managerDisplay ? (
          <div className="space-y-2">
            <div className="font-medium text-slate-100">
              {managerDisplay.summary}
            </div>
            {managerDisplay.workItemIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {managerDisplay.workItemIds.map((workItemId) => (
                  <Badge key={workItemId} className="font-mono text-[11px]">
                    {workItemId}
                  </Badge>
                ))}
              </div>
            )}
            {managerDisplay.toolCalls.length > 0 && (
              <ToolCallList toolCalls={managerDisplay.toolCalls} />
            )}
            {managerDisplay.rawPayload && (
              <details className="rounded border border-slate-800 bg-black/20 px-2 py-1.5">
                <summary className="cursor-pointer text-xs font-medium text-slate-400">
                  Raw payload
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-300">
                  {managerDisplay.rawPayload}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <div
            className="prose prose-sm prose-invert max-w-none [overflow-wrap:anywhere] [&_a]:text-blue-200 [&_a]:underline [&_a]:decoration-blue-300/50 [&_code]:text-xs [&_ol]:my-2 [&_p]:my-0 [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3 [&_ul]:my-2"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!pending && persistedToolCallDisplay.length > 0 && (
          <ToolCallList toolCalls={persistedToolCallDisplay} />
        )}
        {time && (
          <div
            className={`mt-1.5 text-right text-[10px] leading-none opacity-0 transition-opacity group-hover:opacity-100 ${
              isUser ? "text-blue-200/65" : "text-slate-600"
            }`}
          >
            {time}
          </div>
        )}
      </div>
    </div>
  );
}
