import { ApiRouteError } from "../http.js";
import { narrowSupabase, type NarrowSupabaseQuery } from "../lib/narrow-supabase.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { deletePlanForWorkspace } from "./workspace-plans.js";

import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ToolExecutionContext } from "./tool-execution-client.js";
import {
  asRecord,
  jsonOutput,
  optionalPositiveInteger,
  stringArg,
  toolKey,
  type DatabaseToolResult,
} from "./database-tool-executor-shared.js";
import {
  handleRoutingRuleList,
  handleRoutingRuleRead,
  handleRoutingRuleUpdate,
} from "./database-tool-executor-routing.js";
import {
  handleScheduledTaskCreate,
  handleScheduledTaskDelete,
  handleScheduledTaskList,
  handleScheduledTaskRead,
  handleScheduledTaskUpdate,
} from "./database-tool-executor-scheduled-tasks.js";
import { handleToolExamplesAppend } from "./database-tool-executor-tool-examples.js";
import { memoryResultTokenCount, retrieveRelevantMemories } from "./learning/memory-retriever.js";
import { isLearningEnabledForAgent } from "./learning/settings.js";

export function isDatabaseTool(tool: ToolDefinition): boolean {
  return tool.executionKind === "database";
}

function queryFrom<Row = Record<string, unknown>>(table: string): NarrowSupabaseQuery<Row> {
  return narrowSupabase(getServiceRoleSupabase()).from<Row>(table);
}

function missingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("PGRST204") ||
    message.includes("PGRST205") ||
    message.includes("42703") ||
    message.includes("Could not find") ||
    message.includes("schema cache")
  );
}

async function executeRouterRows<Row>(
  queryContext: string,
  query: PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<Row[]> {
  try {
    const { data, error } = await query;
    if (error) throw normalizeSupabaseError(queryContext, error as never);
    if (!data) return [];
    return (Array.isArray(data) ? data : [data]) as Row[];
  } catch (error) {
    if (missingSchema(error)) {
      throw new ApiRouteError(
        503,
        "routing_tool_schema_unavailable",
        "Routing tools require the intelligent cutover routing schema migrations before they can be used",
        { context: queryContext },
      );
    }
    throw error;
  }
}

export async function executeDatabaseTool(
  tool: ToolDefinition,
  argumentsValue: unknown,
  context?: ToolExecutionContext,
): Promise<DatabaseToolResult> {
  const args = asRecord(argumentsValue);
  const requestedWorkspaceId = stringArg(args, "workspace_id") || stringArg(args, "workspaceId");
  const workspaceId = context?.workspaceId?.trim() || "";
  if (!workspaceId) {
    throw new ApiRouteError(400, "runtime_context_required", "workspace_id is required in runtime context");
  }
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    throw new ApiRouteError(403, "workspace_mismatch", "Tool workspace_id must match the runtime workspace");
  }

  switch (toolKey(tool)) {
    case "plans.read":
    case "get_plans": {
      const limit = optionalPositiveInteger(args, "limit", 50, 200);
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw normalizeSupabaseError("plan query", error);
      return { status: 200, output: jsonOutput({ plans: data ?? [] }) };
    }

    case "plan.read": {
      const planId = stringArg(args, "plan_id") || stringArg(args, "planId");
      if (!planId) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "plan_id is required");
      }
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .eq("workspace_id", workspaceId)
        .eq("id", planId)
        .limit(1)
        .maybeSingle();
      if (error) throw normalizeSupabaseError("plan query", error);
      if (!data) throw new ApiRouteError(404, "plan_not_found", "Plan was not found");
      return { status: 200, output: jsonOutput({ plan: data }) };
    }

    case "plan.delete": {
      const planId = stringArg(args, "plan_id") || stringArg(args, "planId");
      if (!planId) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "plan_id is required");
      }
      const result = await deletePlanForWorkspace(workspaceId, planId);
      return { status: 200, output: jsonOutput(result) };
    }

    case "plan.create": {
      const name = stringArg(args, "name");
      if (!name) {
        throw new ApiRouteError(400, "invalid_tool_arguments", "name is required");
      }
      const payload = {
        workspace_id: workspaceId,
        name,
        description: stringArg(args, "description") || null,
        type: stringArg(args, "type") || null,
        is_ongoing: typeof args.is_ongoing === "boolean" ? args.is_ongoing : null,
      };
      const supabase = getServiceRoleSupabase();
      const { data, error } = await supabase
        .from("plan")
        .insert(payload)
        .select("id,workspace_id,name,description,type,status,is_ongoing,created_at,updated_at")
        .single();
      if (error) throw normalizeSupabaseError("plan insert", error);
      return { status: 201, output: jsonOutput({ plan: data }) };
    }

    case "scheduled_task.list": {
      return handleScheduledTaskList(args, workspaceId);
    }

    case "routing_rule.list": {
      return handleRoutingRuleList(args, workspaceId);
    }

    case "routing_rule.read": {
      return handleRoutingRuleRead(args, workspaceId);
    }

    case "routing_rule.update": {
      return handleRoutingRuleUpdate(args, workspaceId, context);
    }

    case "local_model.list": {
      const machines = await executeRouterRows<Record<string, unknown>>(
        "local_runtime_machine query",
        queryFrom("local_runtime_machine")
          .select(
            "id,workspace_id,display_name,helper_version,runner_kinds,advertised_runner_kinds,last_seen_at,revoked_at,updated_at",
          )
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .order("updated_at", { ascending: false }),
      );
      const machineIds = machines.map((machine: Record<string, unknown>) => String(machine.id ?? "")).filter(Boolean);
      const models =
        machineIds.length > 0
          ? await executeRouterRows<Record<string, unknown>>(
              "local_runtime_model query",
              queryFrom("local_runtime_model")
                .select("id,machine_id,runner_kind,model,metadata,created_at,updated_at")
                .in("machine_id", machineIds)
                .order("updated_at", { ascending: false }),
            )
          : [];
      return { status: 200, output: jsonOutput({ machines, models }) };
    }

    case "provider_cutover.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const cutovers = await executeRouterRows<Record<string, unknown>>(
        "provider_cutover query",
        queryFrom("provider_cutover")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("triggered_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerCutovers: cutovers }) };
    }

    case "provider_failure.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const failures = await executeRouterRows<Record<string, unknown>>(
        "provider_failure query",
        queryFrom("provider_failure")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerFailures: failures }) };
    }

    case "memory.search": {
      const agentId = context?.agentId?.trim() || "";
      if (!agentId) throw new ApiRouteError(400, "runtime_context_required", "agent_id is required in runtime context");
      const learningEnabled = await isLearningEnabledForAgent({
        agentId,
        workspaceId,
        supabase: getServiceRoleSupabase(),
      });
      if (!learningEnabled) {
        throw new ApiRouteError(403, "learning_disabled", "Workspace learning is not enabled for this agent");
      }
      const query = stringArg(args, "query");
      if (!query) throw new ApiRouteError(400, "invalid_tool_arguments", "query is required");
      const scope = stringArg(args, "scope") || undefined;
      const importanceMin = optionalPositiveInteger(args, "importance_min", 1, 10);
      const limit = optionalPositiveInteger(args, "limit", 5, 20);
      const retrieval = await retrieveRelevantMemories({
        workspaceId,
        agentId,
        queryText: query,
        scope: scope === "workspace" || scope === "agent" ? scope : undefined,
        importanceMin,
        limit,
        maxTokens: 1200,
      });
      const results = retrieval.results;
      return {
        status: 200,
        output: jsonOutput({
          results,
          resultCount: results.length,
          resultTokenCount: memoryResultTokenCount(results),
          embeddingUsed: retrieval.embeddingUsed,
        }),
      };
    }

    case "tool_examples.append": {
      return handleToolExamplesAppend(args, workspaceId, context);
    }

    case "scheduled_task.read": {
      return handleScheduledTaskRead(args, workspaceId);
    }

    case "scheduled_task.create": {
      return handleScheduledTaskCreate(args, workspaceId, context);
    }

    case "scheduled_task.update": {
      return handleScheduledTaskUpdate(args, workspaceId);
    }

    case "scheduled_task.delete": {
      return handleScheduledTaskDelete(args, workspaceId);
    }

    default:
      throw new ApiRouteError(400, "unsupported_database_tool", `Unsupported database tool: ${toolKey(tool)}`);
  }
}
