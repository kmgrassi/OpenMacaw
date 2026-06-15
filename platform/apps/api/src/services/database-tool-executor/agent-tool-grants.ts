import { ApiRouteError } from "../../http.js";
import { setSystemAgentToolGrant } from "../agent-tools/grants.js";
import type { ToolExecutionContext } from "../tool-execution-client.js";
import { jsonOutput, stringArg } from "./shared.js";

const SYSTEM_GRANT_CAP_PER_RUN = 3;
const grantCountsByRun = new Map<string, number>();

function runBudgetKey(workspaceId: string, context?: ToolExecutionContext): string {
  return [
    workspaceId,
    context?.sessionId?.trim() || "unknown_session",
    context?.agentId?.trim() || "unknown_agent",
  ].join(":");
}

function assertGrantBudget(workspaceId: string, context?: ToolExecutionContext) {
  const key = runBudgetKey(workspaceId, context);
  const current = grantCountsByRun.get(key) ?? 0;
  if (current >= SYSTEM_GRANT_CAP_PER_RUN) {
    throw new ApiRouteError(429, "system_tool_grant_cap_exceeded", "Per-run system tool grant cap exceeded", {
      cap: SYSTEM_GRANT_CAP_PER_RUN,
    });
  }
}

function consumeGrantBudget(workspaceId: string, context?: ToolExecutionContext) {
  const key = runBudgetKey(workspaceId, context);
  const current = grantCountsByRun.get(key) ?? 0;
  grantCountsByRun.set(key, current + 1);
}

export async function createAgentToolGrant(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
) {
  const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id");
  const toolId = stringArg(args, "toolId") || stringArg(args, "tool_id");
  const toolSlug = stringArg(args, "toolSlug") || stringArg(args, "tool_slug") || stringArg(args, "slug");
  const reason = stringArg(args, "reason");
  if (!agentId) throw new ApiRouteError(400, "invalid_tool_arguments", "agentId is required");
  assertGrantBudget(workspaceId, context);
  const result = await setSystemAgentToolGrant({
    actorAgentId: context?.agentId,
    agentId,
    workspaceId,
    toolId,
    toolSlug,
    mode: "include",
    reason,
    operation: "create",
  });
  consumeGrantBudget(workspaceId, context);
  return { status: 201, output: jsonOutput(result) };
}

export async function updateAgentToolGrant(
  args: Record<string, unknown>,
  workspaceId: string,
  context?: ToolExecutionContext,
) {
  const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id");
  const toolId = stringArg(args, "toolId") || stringArg(args, "tool_id");
  const toolSlug = stringArg(args, "toolSlug") || stringArg(args, "tool_slug") || stringArg(args, "slug");
  const mode = stringArg(args, "mode");
  const reason = stringArg(args, "reason");
  if (!agentId) throw new ApiRouteError(400, "invalid_tool_arguments", "agentId is required");
  if (mode !== "include" && mode !== "exclude") {
    throw new ApiRouteError(400, "invalid_tool_arguments", "mode must be include or exclude");
  }
  assertGrantBudget(workspaceId, context);
  const result = await setSystemAgentToolGrant({
    actorAgentId: context?.agentId,
    agentId,
    workspaceId,
    toolId,
    toolSlug,
    mode,
    reason,
    operation: "update",
  });
  consumeGrantBudget(workspaceId, context);
  return { status: 200, output: jsonOutput(result) };
}
