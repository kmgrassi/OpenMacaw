import { ApiRouteError } from "../http.js";

import type { RuntimeExecutionTarget } from "../../../../contracts/execution-profile.js";
import { loadToolExecutionConfig } from "../config.js";
import { executeDatabaseTool, isDatabaseTool } from "./database-tool-executor.js";
import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ParsedToolCall } from "./tool-call-parser.js";

export type ToolExecutionResult = {
  ok: boolean;
  output: string;
  durationMs: number;
  status?: number;
};

export type ToolExecutionClientOptions = {
  legacyLocalChatToolHelperBaseUrl?: string;
  allowLegacyLocalChatHttpToolHelper?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  context?: ToolExecutionContext;
};

export type ToolExecutionContext = {
  agentId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  executionTarget?: RuntimeExecutionTarget | null;
  workspaceRoot?: string | null;
  metadata?: Record<string, unknown> | null;
};

function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}

function schemaProperties(tool: ToolDefinition): Set<string> {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties));
}

function putIfDeclared(
  args: Record<string, unknown>,
  declaredProperties: Set<string>,
  key: string,
  value: string | null | undefined,
) {
  if (!value || !declaredProperties.has(key) || args[key] !== undefined) return;
  args[key] = value;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeToolExecutionContext(context?: ToolExecutionContext | null): ToolExecutionContext {
  const normalized: ToolExecutionContext = {};
  const agentId = nonEmpty(context?.agentId);
  const workspaceId = nonEmpty(context?.workspaceId);
  const userId = nonEmpty(context?.userId);
  const sessionId = nonEmpty(context?.sessionId);
  const requestId = nonEmpty(context?.requestId);
  const traceId = nonEmpty(context?.traceId);
  const workspaceRoot = nonEmpty(context?.workspaceRoot);

  if (agentId) normalized.agentId = agentId;
  if (workspaceId) normalized.workspaceId = workspaceId;
  if (userId) normalized.userId = userId;
  if (sessionId) normalized.sessionId = sessionId;
  if (requestId) normalized.requestId = requestId;
  if (traceId) normalized.traceId = traceId;
  if (context?.executionTarget) normalized.executionTarget = context.executionTarget;
  if (workspaceRoot) normalized.workspaceRoot = workspaceRoot;
  if (context?.metadata && typeof context.metadata === "object") normalized.metadata = context.metadata;

  return normalized;
}

export function injectToolExecutionContext(
  argumentsValue: unknown,
  tool: ToolDefinition,
  context?: ToolExecutionContext,
): unknown {
  if (!context || !argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return argumentsValue;
  }

  const declaredProperties = schemaProperties(tool);
  if (declaredProperties.size === 0) return argumentsValue;

  const args = { ...(argumentsValue as Record<string, unknown>) };
  putIfDeclared(args, declaredProperties, "agentId", context.agentId);
  putIfDeclared(args, declaredProperties, "agent_id", context.agentId);
  putIfDeclared(args, declaredProperties, "workspaceId", context.workspaceId);
  putIfDeclared(args, declaredProperties, "workspace_id", context.workspaceId);
  putIfDeclared(args, declaredProperties, "userId", context.userId);
  putIfDeclared(args, declaredProperties, "user_id", context.userId);
  putIfDeclared(args, declaredProperties, "sessionId", context.sessionId);
  putIfDeclared(args, declaredProperties, "session_id", context.sessionId);
  return args;
}

function toolErrorOutput(error: ApiRouteError): string {
  return JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  });
}

export async function executeToolCall(
  toolCall: ParsedToolCall,
  tool: ToolDefinition,
  options: ToolExecutionClientOptions = {},
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const config = loadToolExecutionConfig();
  const timeoutMs = options.timeoutMs ?? config.toolExecutionTimeoutMs;
  const context = normalizeToolExecutionContext(options.context);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const parsedArguments = parseToolArguments(toolCall.function.arguments);
    const scopedArguments = injectToolExecutionContext(parsedArguments, tool, context);
    if (isDatabaseTool(tool)) {
      const result = await executeDatabaseTool(tool, scopedArguments, context);
      return {
        ok: true,
        status: result.status,
        durationMs: Date.now() - startedAt,
        output: result.output,
      };
    }

    if (!options.allowLegacyLocalChatHttpToolHelper) {
      throw new ApiRouteError(
        501,
        "unsupported_tool_execution_transport",
        "Tool execution is not configured for this transport; legacy local-chat HTTP tool helper fallback requires explicit opt-in",
      );
    }

    // Legacy direct `/local-chat` development compatibility only. The current
    // Go local-runtime-helper uses relay registration, not this inbound HTTP
    // `/tools/execute` endpoint.
    const helperBaseUrl = (options.legacyLocalChatToolHelperBaseUrl ?? config.legacyLocalChatToolHelperBaseUrl).replace(
      /\/+$/,
      "",
    );
    const response = await (options.fetchFn ?? fetch)(`${helperBaseUrl}/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        toolCallId: toolCall.id,
        toolId: tool.id,
        toolSlug: tool.slug,
        name: toolCall.function.name,
        arguments: scopedArguments,
        executionKind: tool.executionKind,
        runnerKind: tool.runnerKind,
        context,
        executionTarget: context.executionTarget ?? null,
      }),
    });

    const responseText = await response.text().catch(() => "");
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        output: responseText || `Tool execution failed with HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      durationMs,
      output: responseText,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof ApiRouteError) {
      return {
        ok: false,
        status: error.status,
        durationMs,
        output: toolErrorOutput(error),
      };
    }

    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        durationMs,
        output: `Tool execution timed out after ${timeoutMs}ms`,
      };
    }

    throw new ApiRouteError(
      503,
      "legacy_local_chat_tool_helper_unavailable",
      "Legacy local-chat HTTP tool helper is unavailable",
      String(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}
