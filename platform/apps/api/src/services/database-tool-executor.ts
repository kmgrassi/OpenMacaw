import { ApiRouteError } from "../http.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { deletePlanForWorkspace } from "./workspace-plans.js";

import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ToolExecutionContext } from "./tool-execution-client.js";
import { memoryResultTokenCount, retrieveRelevantMemories } from "./learning/memory-retriever.js";
import { isLearningEnabledForAgent } from "./learning/settings.js";
import { appendToolExamples } from "./database-tool-executor/tool-examples.js";
import { createAgentToolGrant, updateAgentToolGrant } from "./database-tool-executor/agent-tool-grants.js";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTaskForWorkspace,
  listScheduledTasks,
  updateScheduledTask,
} from "./database-tool-executor/scheduled-tasks.js";
import { listRoutingRules, readRoutingRuleTool, updateRoutingRule } from "./database-tool-executor/routing-rules.js";
import { readAgentRunTool } from "./database-tool-executor/agent-runs.js";
import { executeSchemaAwareRows, queryFrom } from "./database-tool-executor/schema-aware-query.js";
import {
  asRecord,
  jsonOutput,
  optionalPositiveInteger,
  scheduledTaskIdArg,
  stringArg,
  toolKey,
  type DatabaseToolResult,
} from "./database-tool-executor/shared.js";

export function isDatabaseTool(tool: ToolDefinition): boolean {
  return tool.executionKind === "database";
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
      return listScheduledTasks(args, workspaceId);
    }

    case "routing_rule.list":
      return listRoutingRules(args, workspaceId);

    case "routing_rule.read":
      return readRoutingRuleTool(args, workspaceId);

    case "routing_rule.update":
      return updateRoutingRule(args, workspaceId, context);

    case "local_model.list": {
      const machineRows = await executeSchemaAwareRows<Record<string, unknown>>(
        "local_runtime_machine query",
        queryFrom("local_runtime_machine")
          .select(
            "id,workspace_id,display_name,helper_version,runner_kinds,advertised_runner_kinds,last_seen_at,revoked_at,updated_at",
          )
          .eq("workspace_id", workspaceId)
          .is("revoked_at", null)
          .order("updated_at", { ascending: false }),
      );
      const machineIds = machineRows.map((machine) => String(machine.id ?? "")).filter(Boolean);
      const modelRows =
        machineIds.length > 0
          ? await executeSchemaAwareRows<Record<string, unknown>>(
              "local_runtime_model query",
              queryFrom("local_runtime_model")
                .select("id,machine_id,runner_kind,model,metadata,created_at,updated_at")
                .in("machine_id", machineIds)
                .order("updated_at", { ascending: false }),
            )
          : [];
      return { status: 200, output: jsonOutput({ machines: machineRows, models: modelRows }) };
    }

    case "provider_cutover.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const providerCutovers = await executeSchemaAwareRows<Record<string, unknown>>(
        "provider_cutover query",
        queryFrom("provider_cutover")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("triggered_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerCutovers }) };
    }

    case "provider_failure.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const providerFailures = await executeSchemaAwareRows<Record<string, unknown>>(
        "provider_failure query",
        queryFrom("provider_failure")
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(limit),
      );
      return { status: 200, output: jsonOutput({ providerFailures }) };
    }

    case "agent_run.read":
      return readAgentRunTool(args, workspaceId, context);

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

    case "tool_examples.append":
      return appendToolExamples(args, workspaceId, context);

    case "agent_tool_grant.create":
      return createAgentToolGrant(args, workspaceId, context);

    case "agent_tool_grant.update":
      return updateAgentToolGrant(args, workspaceId, context);

    case "scheduled_task.read": {
      const scheduledTaskId = scheduledTaskIdArg(args);
      if (!scheduledTaskId) throw new ApiRouteError(400, "invalid_tool_arguments", "scheduledTaskId is required");
      const scheduledTask = await getScheduledTaskForWorkspace(scheduledTaskId, workspaceId);
      return { status: 200, output: jsonOutput({ scheduledTask }) };
    }

    case "scheduled_task.create":
      return createScheduledTask(args, workspaceId, context?.agentId ?? undefined);

    case "scheduled_task.update":
      return updateScheduledTask(args, workspaceId);

    case "scheduled_task.delete":
      return deleteScheduledTask(args, workspaceId);

    default:
      throw new ApiRouteError(400, "unsupported_database_tool", `Unsupported database tool: ${toolKey(tool)}`);
  }
}
