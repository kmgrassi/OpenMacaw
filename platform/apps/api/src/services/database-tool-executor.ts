import { ApiRouteError } from "../http.js";
import { narrowSupabase, type NarrowSupabaseQuery } from "../lib/narrow-supabase.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { deletePlanForWorkspace } from "./workspace-plans.js";

import type { ToolDefinition } from "./tool-spec-translator.js";
import type { ToolExecutionContext } from "./tool-execution-client.js";
import { memoryResultTokenCount, retrieveRelevantMemories } from "./learning/memory-retriever.js";
import { isLearningEnabledForAgent } from "./learning/settings.js";
import { appendToolExamples } from "./database-tool-executor/tool-examples.js";
import { assertAgentInWorkspace, workspaceAgentIds } from "./database-tool-executor/agent-helpers.js";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTaskForWorkspace,
  SCHEDULED_TASK_SELECT,
  updateScheduledTask,
} from "./database-tool-executor/scheduled-tasks.js";
import { listRoutingRules, readRoutingRuleTool, updateRoutingRule } from "./database-tool-executor/routing-rules.js";
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

function queryFrom<Row = Record<string, unknown>>(table: string): NarrowSupabaseQuery<Row> {
  return narrowSupabase(getServiceRoleSupabase()).from<Row>(table);
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
      const agentId = stringArg(args, "agentId") || stringArg(args, "agent_id");
      const supabase = getServiceRoleSupabase();
      const agentIds = agentId ? [agentId] : await workspaceAgentIds(workspaceId);
      if (agentId) await assertAgentInWorkspace(agentId, workspaceId);
      if (agentIds.length === 0) return { status: 200, output: jsonOutput({ scheduledTasks: [] }) };
      const { data, error } = await supabase
        .from("scheduled_task")
        .select(SCHEDULED_TASK_SELECT)
        .in("agent_id", agentIds)
        .order("created_at", { ascending: false });
      if (error) throw normalizeSupabaseError("scheduled_task query", error);
      return { status: 200, output: jsonOutput({ scheduledTasks: data ?? [] }) };
    }

    case "routing_rule.list":
      return listRoutingRules(args, workspaceId);

    case "routing_rule.read":
      return readRoutingRuleTool(args, workspaceId);

    case "routing_rule.update":
      return updateRoutingRule(args, workspaceId, context);

    case "local_model.list": {
      const machines = await queryFrom<Record<string, unknown>>("local_runtime_machine")
        .select(
          "id,workspace_id,display_name,helper_version,runner_kinds,advertised_runner_kinds,last_seen_at,revoked_at,updated_at",
        )
        .eq("workspace_id", workspaceId)
        .is("revoked_at", null)
        .order("updated_at", { ascending: false });
      if (machines.error) throw normalizeSupabaseError("local_runtime_machine query", machines.error);

      const machineRows = Array.isArray(machines.data) ? machines.data : [];
      const machineIds = machineRows.map((machine) => String(machine.id ?? "")).filter(Boolean);
      const modelRows =
        machineIds.length > 0
          ? await queryFrom<Record<string, unknown>>("local_runtime_model")
              .select("id,machine_id,runner_kind,model,metadata,created_at,updated_at")
              .in("machine_id", machineIds)
              .order("updated_at", { ascending: false })
          : null;
      if (modelRows?.error) throw normalizeSupabaseError("local_runtime_model query", modelRows.error);
      return { status: 200, output: jsonOutput({ machines: machineRows, models: modelRows?.data ?? [] }) };
    }

    case "provider_cutover.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const { data, error } = await queryFrom<Record<string, unknown>>("provider_cutover")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("triggered_at", { ascending: false })
        .limit(limit);
      if (error) throw normalizeSupabaseError("provider_cutover query", error);
      return { status: 200, output: jsonOutput({ providerCutovers: data ?? [] }) };
    }

    case "provider_failure.list": {
      const limit = optionalPositiveInteger(args, "limit", 25, 100);
      const { data, error } = await queryFrom<Record<string, unknown>>("provider_failure")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw normalizeSupabaseError("provider_failure query", error);
      return { status: 200, output: jsonOutput({ providerFailures: data ?? [] }) };
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

    case "tool_examples.append":
      return appendToolExamples(args, workspaceId, context);

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
