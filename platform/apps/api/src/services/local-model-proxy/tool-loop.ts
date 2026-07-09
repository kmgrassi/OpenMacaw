import { ApiRouteError } from "../../http.js";
import { logEvent } from "../../logger.js";
import { extractToolCalls } from "../tool-call-parser.js";
import { executeToolCall, type ToolExecutionContext } from "../tool-execution-client.js";
import { toOpenAIToolSpecs, toolsByProviderFunctionName, type ToolDefinition } from "../tool-spec-translator.js";
import { resolveLocalWorkspaceRoot } from "./endpoint.js";
import { messageWithToolCalls, promptFallbackConversationMessages } from "./messages.js";
import { callLocalModel, parseModelResponse, shouldFallbackToPromptTools } from "./upstream.js";
import type { ChatCompletionResponse, ChatMessage } from "./types.js";

const DEFAULT_TOOL_CALL_MAX_ITERATIONS = 10;

export function requestMaxToolIterations(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_TOOL_CALL_MAX_ITERATIONS;
  }
  return Math.min(value, DEFAULT_TOOL_CALL_MAX_ITERATIONS);
}

export async function chatWithTools(input: {
  agentId: string;
  workspaceId: string;
  userId: string;
  sessionId?: string | null;
  provider: string;
  model: string;
  chatUrl: string;
  routingRuleId: string | null;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxIterations: number;
}): Promise<ChatCompletionResponse> {
  const conversationMessages = [...input.messages];
  const openAiTools = toOpenAIToolSpecs(input.tools);
  const toolsByName = toolsByProviderFunctionName(input.tools);
  const workspaceRoot = await resolveLocalWorkspaceRoot(input.workspaceId, input.routingRuleId);
  const context: ToolExecutionContext = {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sessionId: input.sessionId ?? null,
    executionTarget: null,
    workspaceRoot,
  };
  let promptFallback = false;

  for (let iteration = 0; iteration < input.maxIterations; iteration++) {
    const messages = promptFallbackConversationMessages(conversationMessages, context, input.tools);
    let response = await callLocalModel({
      chatUrl: input.chatUrl,
      model: input.model,
      messages,
      stream: false,
      tools: promptFallback ? undefined : openAiTools,
    });

    if (!promptFallback && (await shouldFallbackToPromptTools(response))) {
      promptFallback = true;
      response = await callLocalModel({
        chatUrl: input.chatUrl,
        model: input.model,
        messages: promptFallbackConversationMessages(conversationMessages, context, input.tools),
        stream: false,
      });
    }

    const completion = await parseModelResponse(response);
    const toolCalls = extractToolCalls(completion);
    if (toolCalls.length === 0) {
      return completion;
    }

    const assistantMessage = completion.choices?.[0]?.message;
    conversationMessages.push(messageWithToolCalls(assistantMessage, toolCalls));

    for (const toolCall of toolCalls) {
      const tool = toolsByName.get(toolCall.function.name);
      if (!tool) {
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Unknown tool: ${toolCall.function.name}`,
        });
        continue;
      }

      const result = await executeToolCall(toolCall, tool, {
        context,
        allowLegacyLocalChatHttpToolHelper: true,
      });
      logEvent({
        event: "local_chat_tool_call",
        agent_id: input.agentId,
        provider: input.provider,
        model: input.model,
        tool_name: toolCall.function.name,
        tool_arguments: toolCall.function.arguments,
        workspace_id: input.workspaceId,
        tool_result_success: result.ok,
        tool_result_size_bytes: Buffer.byteLength(result.output, "utf8"),
        duration_ms: result.durationMs,
        iteration_number: iteration + 1,
        is_prompt_based_fallback: promptFallback || toolCall.promptBasedFallback === true,
      });

      conversationMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.output,
      });
    }
  }

  throw new ApiRouteError(508, "tool_call_iterations_exceeded", "Tool calling loop exceeded max iterations", {
    max_iterations: input.maxIterations,
  });
}
