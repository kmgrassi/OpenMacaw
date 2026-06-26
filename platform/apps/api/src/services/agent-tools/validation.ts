import { ApiRouteError } from "../../http.js";
import type { ToolRow } from "../../repositories/agent-tools.js";
import { hasRegisteredLocalCodingTargetRows } from "../../repositories/agent-tools.js";
import { RuntimeExecutionTargetKindSchema } from "../../../../../contracts/execution-profile.js";
import { loadToolExecutionConfig } from "../../config.js";
import { LOCAL_MODEL_CODING_TOOL_SLUGS } from "../tool-bundles.js";

const LOCAL_CODING_TOOL_SLUGS = new Set<string>(LOCAL_MODEL_CODING_TOOL_SLUGS);

export function validateToolParameters(parameters: Record<string, unknown>) {
  const type = parameters.type;
  if (type !== undefined) {
    const allowedTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
    const validType =
      typeof type === "string"
        ? allowedTypes.has(type)
        : Array.isArray(type) && type.every((item) => typeof item === "string" && allowedTypes.has(item));
    if (!validType) {
      throw new ApiRouteError(400, "invalid_parameters_schema", "Tool parameters must be a valid JSON Schema object");
    }
  }

  if (
    parameters.properties !== undefined &&
    (typeof parameters.properties !== "object" ||
      parameters.properties === null ||
      Array.isArray(parameters.properties))
  ) {
    throw new ApiRouteError(400, "invalid_parameters_schema", "Tool parameters properties must be an object");
  }

  if (parameters.required !== undefined) {
    const required = parameters.required;
    if (!Array.isArray(required) || !required.every((item) => typeof item === "string")) {
      throw new ApiRouteError(400, "invalid_parameters_schema", "Tool parameters required must be a string array");
    }
  }
}

export function isLocalCodingTool(row: ToolRow) {
  return row.runner_kind === "local_model_coding" || LOCAL_CODING_TOOL_SLUGS.has(row.slug ?? "");
}

export async function hasRegisteredLocalCodingTarget(workspaceId: string) {
  return hasRegisteredLocalCodingTargetRows(workspaceId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function configuredCodingExecutionTargetKind(agentToolPolicy: unknown) {
  const toolPolicy = asRecord(agentToolPolicy);
  const executionTarget = asRecord(toolPolicy?.executionTarget);
  if (!executionTarget || !Object.hasOwn(executionTarget, "kind")) return null;

  const parsed = RuntimeExecutionTargetKindSchema.safeParse(
    typeof executionTarget.kind === "string" ? executionTarget.kind.trim() : executionTarget.kind,
  );
  if (parsed.success) return parsed.data;

  throw new ApiRouteError(422, "invalid_execution_target", "Agent execution target is invalid");
}

function effectiveCodingExecutionTargetKind(agentToolPolicy: unknown) {
  return (
    configuredCodingExecutionTargetKind(agentToolPolicy) ?? loadToolExecutionConfig().localCodingExecutionTargetKind
  );
}

export async function assertLocalCodingToolsAllowed(input: {
  workspaceId: string;
  tools: ToolRow[];
  agentToolPolicy?: unknown;
}) {
  const hasLocalCodingTool = input.tools.some((tool) => isLocalCodingTool(tool));
  if (!hasLocalCodingTool) return;

  if (effectiveCodingExecutionTargetKind(input.agentToolPolicy) === "container") return;
  if (await hasRegisteredLocalCodingTarget(input.workspaceId)) return;

  throw new ApiRouteError(
    409,
    "local_coding_execution_target_required",
    "Configure a container execution target or connect a local runtime relay with a workspace root before enabling local coding tools",
  );
}
