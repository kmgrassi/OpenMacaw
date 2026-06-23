import type { Tables } from "@kmgrassi/supabase-schema";

import type { RuntimeExecutionTarget } from "../../../../contracts/execution-profile.js";
import { LocalCodingToolSlugSchema } from "../../../../contracts/local-model-coding.js";
import { ApiRouteError } from "../http.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../supabase-client.js";

type LocalRuntimeMachineRow = Pick<
  Tables<"local_runtime_machine">,
  "id" | "workspace_id" | "runner_kinds" | "revoked_at"
>;

const LOCAL_MODEL_CODING_RUNNER = "local_model_coding";
const LOCAL_MODEL_CODING_HELPER_TOOL_SLUGS = new Set(["shell.exec", "apply_patch"]);
type LocalHelperRunnerKind = typeof LOCAL_MODEL_CODING_RUNNER | "planner";

type ToolExecutionTargetFields = {
  id: string;
  slug: string;
  executionKind: string | null;
  runnerKind: string | null;
};

function isLocalCodingTool(tool: Pick<ToolExecutionTargetFields, "slug">): boolean {
  return LocalCodingToolSlugSchema.safeParse(tool.slug).success;
}

function requiresLocalRuntimeHelper(tool: Pick<ToolExecutionTargetFields, "slug">): boolean {
  return LOCAL_MODEL_CODING_HELPER_TOOL_SLUGS.has(tool.slug);
}

export function hasLocalCodingTool(tools: Pick<ToolExecutionTargetFields, "slug">[]): boolean {
  return tools.some((tool) => isLocalCodingTool(tool));
}

export function hasLocalRuntimeHelperTool(tools: Pick<ToolExecutionTargetFields, "slug">[]): boolean {
  return tools.some((tool) => requiresLocalRuntimeHelper(tool));
}

export function assertLocalCodingToolsUseRuntimeTarget(tools: ToolExecutionTargetFields[]): void {
  for (const tool of tools) {
    if (!isLocalCodingTool(tool)) continue;

    if (!requiresLocalRuntimeHelper(tool)) {
      if (tool.executionKind === "database") {
        throw new ApiRouteError(
          422,
          "invalid_local_coding_tool_execution_target",
          "Local coding tools must not execute through Platform database handlers",
          {
            tool_id: tool.id,
            tool_slug: tool.slug,
            execution_kind: tool.executionKind,
            runner_kind: tool.runnerKind,
          },
        );
      }
      continue;
    }

    if (tool.executionKind === "database" || tool.runnerKind !== LOCAL_MODEL_CODING_RUNNER) {
      throw new ApiRouteError(
        422,
        "invalid_local_coding_tool_execution_target",
        "Local coding tools must execute through the local runtime helper target",
        {
          tool_id: tool.id,
          tool_slug: tool.slug,
          execution_kind: tool.executionKind,
          runner_kind: tool.runnerKind,
        },
      );
    }
  }
}

export async function resolveLocalCodingExecutionTarget(input: {
  workspaceId: string;
  runnerKind?: LocalHelperRunnerKind;
  /**
   * Absolute path the user saved in agent settings. Forwarded to the
   * runtime so the launcher-managed dispatch path can scope tools to
   * the same directory the gateway-chat path uses.
   */
  workspaceRoot?: string | null;
}): Promise<RuntimeExecutionTarget> {
  const runnerKind = input.runnerKind ?? LOCAL_MODEL_CODING_RUNNER;
  const rows = await executeSupabaseRows<LocalRuntimeMachineRow>(
    "local runtime machine query",
    getServiceRoleSupabase()
      .from("local_runtime_machine")
      .select("id,workspace_id,runner_kinds,revoked_at")
      .eq("workspace_id", input.workspaceId)
      .is("revoked_at", null)
      .contains("runner_kinds", [runnerKind])
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1),
  );

  const machine = rows[0] ?? null;
  if (!machine) {
    throw new ApiRouteError(
      409,
      "local_coding_execution_target_missing",
      `No local runtime helper is registered for ${runnerKind} in this workspace`,
      {
        workspace_id: input.workspaceId,
        required_runner_kind: runnerKind,
      },
    );
  }

  const workspaceRoot =
    typeof input.workspaceRoot === "string" && input.workspaceRoot.trim() !== ""
      ? input.workspaceRoot.trim()
      : undefined;

  return {
    kind: "local_helper",
    workspaceId: machine.workspace_id,
    runnerKind,
    machineId: machine.id,
    workspaceRootRef: `local_runtime_machine:${machine.id}`,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
}
