import { randomUUID } from "node:crypto";

import type {
  DevToolInvocationObservation,
  DevToolInvocationRequest,
  DevToolInvocationResponse,
} from "../../../../contracts/dev-tool-invocation.js";
import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { assertAgentAccess } from "./agent-tools/access.js";
import { resolveAgentToolGrants, type GrantResolverToolRow } from "./agent-tool-grant-resolver.js";
import { resolveExecutionProfile } from "./execution-profile-resolver.js";
import { executeToolCall, type ToolExecutionContext, type ToolExecutionResult } from "./tool-execution-client.js";
import { toolFunctionName, type ToolDefinition } from "./tool-spec-translator.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function configuredWorkspaceRoot(agentToolPolicy: unknown): string | null {
  const toolPolicy = asRecord(agentToolPolicy);
  const target = asRecord(toolPolicy.executionTarget);
  const raw = target.workspace_root ?? target.workspaceRoot;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

async function routingRuleWorkspaceRoot(input: {
  workspaceId: string;
  routingRuleId: string | null;
}): Promise<string | null> {
  if (!input.routingRuleId) return null;

  const { data, error } = await getServiceRoleSupabase()
    .from("routing_rule_match")
    .select("value")
    .eq("workspace_id", input.workspaceId)
    .eq("rule_id", input.routingRuleId)
    .eq("kind", "local_workspace_root")
    .eq("key", "path")
    .limit(1)
    .maybeSingle();
  if (error) throw normalizeSupabaseError("routing_rule_match query", error);

  const workspaceRoot = typeof data?.value === "string" ? data.value.trim() : "";
  return workspaceRoot || null;
}

async function resolveWorkspaceRoot(input: {
  workspaceId: string;
  routingRuleId: string | null;
  agentToolPolicy: unknown;
}) {
  return (
    (await routingRuleWorkspaceRoot({
      workspaceId: input.workspaceId,
      routingRuleId: input.routingRuleId,
    })) ?? configuredWorkspaceRoot(input.agentToolPolicy)
  );
}

function toolFromRow(row: GrantResolverToolRow): ToolDefinition {
  const slug = row.slug ?? row.function_name ?? row.id;
  return {
    id: row.id,
    slug,
    name: row.name ?? slug,
    description: row.description ?? "",
    functionName: row.function_name ?? slug,
    parameters: asRecord(row.parameters),
    executionKind: row.execution_kind ?? null,
    runnerKind: row.runner_kind ?? null,
    enabled: row.enabled,
  };
}

function commandActionsForTool(toolSlug: string): DevToolInvocationObservation["commandActions"] {
  switch (toolSlug) {
    case "shell.exec":
    case "git.run":
      return ["unknown"];
    default:
      return ["unknown"];
  }
}

function outputSummary(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 2_000);
}

function parsedToolError(result: ToolExecutionResult): {
  code: string | null;
  message: string | null;
  details: unknown;
} {
  try {
    const parsed = JSON.parse(result.output) as unknown;
    const error = asRecord(asRecord(parsed).error);
    return {
      code: typeof error.code === "string" ? error.code : null,
      message: typeof error.message === "string" ? error.message : null,
      details: error.details,
    };
  } catch {
    return { code: null, message: null, details: null };
  }
}

function failedObservation(input: {
  tool: ToolDefinition;
  request: DevToolInvocationRequest;
  toolCallId: string;
  startedAt: string;
  completedAt: string;
  result: ToolExecutionResult;
}): DevToolInvocationObservation {
  const toolError = parsedToolError(input.result);
  return {
    toolCallId: input.toolCallId,
    correlationId: input.request.correlationId ?? null,
    eventType: "dev_tool_invocation",
    messageKind: "tool_result",
    toolSlug: input.tool.slug,
    status: "failed",
    approvalState: "not_required",
    commandActions: commandActionsForTool(input.tool.slug),
    arguments: input.request.input,
    result: {
      ok: input.result.ok,
      status: input.result.status ?? null,
      output: input.result.output,
    },
    outputSummary: outputSummary(input.result.output),
    errorCode: toolError.code,
    errorMessage: toolError.message ?? outputSummary(input.result.output),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.result.durationMs,
  };
}

function throwFailedExecution(observation: DevToolInvocationObservation, result: ToolExecutionResult): never {
  const toolError = parsedToolError(result);
  if (result.status === 400 || toolError.code === "invalid_tool_arguments") {
    throw new ApiRouteError(400, "tool_input_invalid", toolError.message ?? "Tool input is invalid", {
      observation,
      tool_error: toolError,
    });
  }

  throw new ApiRouteError(502, "tool_execution_failed", toolError.message ?? "Tool execution failed", {
    observation,
    tool_error: toolError,
  });
}

export async function invokeDevTool(input: {
  accessToken: string;
  userId: string;
  toolSlug: string;
  request: DevToolInvocationRequest;
}): Promise<DevToolInvocationResponse> {
  const { agent, workspaceId } = await assertAgentAccess({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: input.request.agentId,
    workspaceId: input.request.workspaceId,
  });

  const [executionProfile, grants] = await Promise.all([
    resolveExecutionProfile({
      accessToken: input.accessToken,
      requesterUserId: input.userId,
      agentId: input.request.agentId,
      skipCredentialCheck: true,
    }),
    resolveAgentToolGrants({
      agentId: input.request.agentId,
      workspaceId,
      supabase: getServiceRoleSupabase(),
    }),
  ]);

  if (executionProfile.profile && executionProfile.profile.workspaceId !== workspaceId) {
    throw new ApiRouteError(403, "agent_workspace_mismatch", "Execution profile workspace does not match the agent");
  }

  const visibleTool = grants.availableTools.find((tool) => tool.slug === input.toolSlug);
  if (!visibleTool) {
    throw new ApiRouteError(404, "tool_not_found", "Tool was not found", {
      tool_slug: input.toolSlug,
      workspace_id: workspaceId,
    });
  }

  const grantedTool = grants.resolvedTools.find(
    (resolution) => resolution.tool.id === visibleTool.id && resolution.enabledForAgent,
  );
  if (!grantedTool) {
    throw new ApiRouteError(403, "tool_not_granted", "Tool is not granted to this agent", {
      tool_slug: input.toolSlug,
      tool_id: visibleTool.id,
      agent_id: input.request.agentId,
      workspace_id: workspaceId,
    });
  }

  const tool = toolFromRow(grantedTool.tool);
  const toolCallId = `dev-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const workspaceRoot = await resolveWorkspaceRoot({
    workspaceId,
    routingRuleId: executionProfile.source.routingRuleId,
    agentToolPolicy: agent.tool_policy,
  });
  const context: ToolExecutionContext = {
    agentId: input.request.agentId,
    workspaceId,
    userId: input.userId,
    executionTarget: null,
    workspaceRoot,
  };
  const result = await executeToolCall(
    {
      id: toolCallId,
      type: "function",
      function: {
        name: toolFunctionName(tool),
        arguments: JSON.stringify(input.request.input),
      },
    },
    tool,
    { context },
  );
  const completedAt = new Date().toISOString();

  if (!result.ok) {
    throwFailedExecution(
      failedObservation({ tool, request: input.request, toolCallId, startedAt, completedAt, result }),
      result,
    );
  }

  const observation: DevToolInvocationObservation = {
    toolCallId,
    correlationId: input.request.correlationId ?? null,
    eventType: "dev_tool_invocation",
    messageKind: "tool_result",
    toolSlug: tool.slug,
    status: "completed",
    approvalState: "not_required",
    commandActions: commandActionsForTool(tool.slug),
    arguments: input.request.input,
    result: {
      ok: result.ok,
      status: result.status ?? null,
      output: result.output,
    },
    outputSummary: outputSummary(result.output),
    errorCode: null,
    errorMessage: null,
    startedAt,
    completedAt,
    durationMs: result.durationMs,
  };

  return {
    agentId: input.request.agentId,
    workspaceId,
    toolId: tool.id,
    toolSlug: tool.slug,
    toolCallId,
    executionProfile: {
      runnerKind: executionProfile.profile?.runnerKind ?? null,
      provider: executionProfile.profile?.provider ?? null,
      model: executionProfile.profile?.model ?? null,
      missing: executionProfile.missing,
    },
    observation,
  };
}
