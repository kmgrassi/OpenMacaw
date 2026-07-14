import { z } from "zod";

import { SkillCreateToolRequestSchema, SkillCreateToolResponseSchema } from "../../../../../contracts/skills.js";
import { ApiRouteError } from "../../http.js";
import { parseNullableSupabaseRow, parseSupabaseRow } from "../../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";
import { asRecord, jsonOutput, stringArg, type DatabaseToolResult } from "./shared.js";
import type { ToolExecutionContext } from "../tool-execution-client.js";

const AgentOwnershipRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
});

const SkillRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  status: z.enum(["draft", "approved", "archived"]),
  copied_from_skill_id: z.string().nullable(),
  created_by_agent_id: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  source_run_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type SkillRow = z.infer<typeof SkillRowSchema>;
type SkillInsertRow = Pick<
  SkillRow,
  | "workspace_id"
  | "agent_id"
  | "name"
  | "description"
  | "body"
  | "status"
  | "copied_from_skill_id"
  | "created_by_agent_id"
  | "created_by_user_id"
  | "source_run_id"
>;

type SkillInsertQuery = {
  select: (columns?: string) => {
    single: () => Promise<{ data: unknown; error: Parameters<typeof normalizeSupabaseError>[1] | null }>;
  };
};

type SkillInsertTable = {
  insert: (payload: SkillInsertRow) => SkillInsertQuery;
};

const SKILL_SELECT =
  "id,workspace_id,agent_id,name,description,body,status,copied_from_skill_id,created_by_agent_id,created_by_user_id,source_run_id,created_at,updated_at" as const;

function skillFromRow(row: SkillRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    body: row.body,
    status: row.status,
    copiedFromSkillId: row.copied_from_skill_id,
    createdByAgentId: row.created_by_agent_id,
    createdByUserId: row.created_by_user_id,
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createSkill(
  argsValue: unknown,
  workspaceId: string,
  context?: ToolExecutionContext,
): Promise<DatabaseToolResult> {
  const args = asRecord(argsValue);
  const targetAgentId =
    stringArg(args, "agentId") ||
    stringArg(args, "agent_id") ||
    stringArg(args, "targetAgentId") ||
    stringArg(args, "target_agent_id");
  const parsedRequest = SkillCreateToolRequestSchema.safeParse({
    agentId: targetAgentId,
    name: stringArg(args, "name"),
    description: stringArg(args, "description"),
    body: stringArg(args, "body"),
  });
  if (!parsedRequest.success) {
    throw new ApiRouteError(
      400,
      "invalid_tool_arguments",
      "skill.create requires agentId, name, description, and body in the Agent Skills format",
      parsedRequest.error.issues,
    );
  }
  const request = parsedRequest.data;

  const supabase = getServiceRoleSupabase();
  const agentQuery = supabase
    .from("agent")
    .select("id,workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("id", request.agentId)
    .limit(1)
    .maybeSingle();
  const { data: agent, error: agentError } = await agentQuery;
  if (agentError) {
    throw normalizeSupabaseError("skill target agent query", agentError);
  }
  if (!parseNullableSupabaseRow("skill target agent query", AgentOwnershipRowSchema, agent)) {
    throw new ApiRouteError(404, "agent_not_found", "Target agent was not found in the runtime workspace");
  }

  const createdByAgentId = context?.agentId?.trim() || null;
  const createdByUserId = context?.userId?.trim() || null;
  const sourceRunId = context?.sessionId?.trim() || null;
  const insertPayload: SkillInsertRow = {
    workspace_id: workspaceId,
    agent_id: request.agentId,
    name: request.name,
    description: request.description,
    body: request.body,
    status: "draft",
    copied_from_skill_id: null,
    created_by_agent_id: createdByAgentId,
    created_by_user_id: createdByUserId,
    source_run_id: sourceRunId,
  };
  const insertQuery = (supabase.from("skill" as never) as unknown as SkillInsertTable)
    .insert(insertPayload)
    .select(SKILL_SELECT)
    .single();
  const { data: skillRow, error: skillError } = await insertQuery;
  if (skillError) {
    throw normalizeSupabaseError("skill insert", skillError);
  }
  if (!skillRow) throw new ApiRouteError(502, "skill_create_failed", "Skill creation returned no row");

  return {
    status: 201,
    output: jsonOutput(
      SkillCreateToolResponseSchema.parse({
        skill: skillFromRow(parseSupabaseRow("skill insert", SkillRowSchema, skillRow)),
      }),
    ),
  };
}
