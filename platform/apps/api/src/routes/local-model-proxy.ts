// DEV ONLY — production should route through the relay transport.
// This endpoint proxies chat completions directly to a local
// OpenAI-compatible model server (e.g. Ollama), bypassing the
// launcher and orchestrator entirely.

import type { Express, Request, Response } from "express";

import { isLocalCodingRunnerKind, isLocalRunnerKind } from "../../../../contracts/runner-kinds.js";
import {
  ApiRouteError,
  handleApiRouteError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import { resolveExecutionProfile } from "../services/execution-profile-resolver.js";
import { getLocalChatToolResolutionForAgent } from "../services/local-chat-agent-tools.js";
import { resolveLocalEndpoint } from "../services/local-model-proxy/endpoint.js";
import { pipeStreamingResponse, writeCompletionAsSse } from "../services/local-model-proxy/streaming.js";
import { chatWithTools, requestMaxToolIterations } from "../services/local-model-proxy/tool-loop.js";
import type { ChatMessage } from "../services/local-model-proxy/types.js";
import { callLocalModel, parseModelResponse } from "../services/local-model-proxy/upstream.js";
import { toolFunctionName } from "../services/tool-spec-translator.js";
import { getUserScopedSupabase } from "../supabase-client.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

export function registerLocalModelProxyRoutes(app: Express) {
  // DEV ONLY — POST /api/agents/:agentId/local-chat
  app.post("/api/agents/:agentId/local-chat", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, {
        localhostOnly: true,
        disabledCode: "dev_endpoint_disabled",
        disabledMessage: "Local model chat endpoint is disabled",
      });
      const accessToken = requireAccessToken(req);
      const userId = requireVerifiedUser(req);
      const agentId = requireRouteParam(req, "agentId");

      // 1. Resolve execution profile and verify it's a local runtime
      const resolution = await resolveExecutionProfile({
        accessToken,
        requesterUserId: userId,
        agentId,
      });

      if (!resolution.profile) {
        throw new ApiRouteError(422, "agent_runtime_unconfigured", "Agent runtime is not fully configured", {
          agent_id: agentId,
          missing: resolution.missing,
        });
      }

      if (
        !isLocalRunnerKind(resolution.profile.runnerKind) &&
        !isLocalCodingRunnerKind(resolution.profile.runnerKind)
      ) {
        throw new ApiRouteError(
          400,
          "not_local_runtime",
          "This endpoint only supports agents with a local_relay or local_model_coding execution profile",
          { runner_kind: resolution.profile.runnerKind },
        );
      }

      // 2. Validate request body
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new ApiRouteError(400, "invalid_request", "messages array is required and must not be empty");
      }

      const stream = req.body?.stream === true;
      const model = resolution.profile.model;
      const maxIterations = requestMaxToolIterations(req.body?.maxToolIterations);

      // 3. Resolve the local model endpoint
      const endpoint = await resolveLocalEndpoint(resolution.profile.workspaceId, resolution.source.routingRuleId);

      const chatUrl = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
      const toolResolution = await getLocalChatToolResolutionForAgent({
        agentId,
        workspaceId: resolution.profile.workspaceId,
        supabase: getUserScopedSupabase(accessToken),
      });
      const tools = toolResolution.tools;
      const chatMessages = messages as ChatMessage[];

      if (
        isLocalCodingRunnerKind(resolution.profile.runnerKind) &&
        toolResolution.rejectedLocalCodingTools.length > 0
      ) {
        throw new ApiRouteError(
          409,
          "local_coding_tools_require_runtime_relay",
          "Coding Agent local model tools run through runtime relay and a registered local-runtime-helper; use runtime dispatch instead of /local-chat.",
          {
            agent_id: agentId,
            workspace_id: resolution.profile.workspaceId,
            runner_kind: resolution.profile.runnerKind,
            tool_slugs: toolResolution.rejectedLocalCodingTools.map((tool) => tool.slug),
          },
        );
      }

      // 4. Forward to the local model server
      if (process.env.NODE_ENV === "development") {
        const lastMsg = messages[messages.length - 1];
        const toolNames = tools.map((tool) => toolFunctionName(tool)).join(",");
        console.log(
          `[local-chat] → ${chatUrl} model=${model} messages=${messages.length} tools=${toolNames || "(none)"} last="${lastMsg?.content?.slice(0, 100)}"`,
        );
      }

      if (tools.length > 0) {
        const completion = await chatWithTools({
          agentId,
          workspaceId: resolution.profile.workspaceId,
          userId,
          sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : null,
          provider: resolution.profile.provider,
          model,
          chatUrl,
          routingRuleId: resolution.source.routingRuleId,
          messages: chatMessages,
          tools,
          maxIterations,
        });

        if (process.env.NODE_ENV === "development") {
          const choices = completion.choices as Array<{ message?: { content?: string } }> | undefined;
          const reply = choices?.[0]?.message?.content?.slice(0, 200) ?? "(no content)";
          console.log(`[local-chat] ← model=${model} reply="${reply}"`);
        }
        if (stream) {
          writeCompletionAsSse(res, completion, model);
          return;
        }
        return res.status(200).json(completion);
      }

      const upstreamResponse = await callLocalModel({
        chatUrl,
        model,
        messages: chatMessages,
        stream,
      });

      // 5. Stream or return JSON
      if (stream) {
        await pipeStreamingResponse(upstreamResponse, res);
      } else {
        const data = await parseModelResponse(upstreamResponse);
        if (process.env.NODE_ENV === "development") {
          const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
          const reply = choices?.[0]?.message?.content?.slice(0, 200) ?? "(no content)";
          console.log(`[local-chat] ← model=${model} reply="${reply}"`);
        }
        return res.status(200).json(data);
      }
    } catch (error) {
      if (res.headersSent) return;
      return handleApiRouteError(res, error, {
        status: 502,
        code: "local_chat_failed",
        message: "Local model chat request failed",
      });
    }
  });
}
