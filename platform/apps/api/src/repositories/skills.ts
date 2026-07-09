import { z } from "zod";

import {
  SkillListResponseSchema,
  SkillSchema,
  SkillStatusSchema,
  SkillUpdateRequestSchema,
  type Skill,
  type SkillListQuery,
  type SkillListResponse,
  type SkillUpdateRequest,
} from "../../../../contracts/skills.js";
import { ApiRouteError } from "../http.js";
import { parseNullableSupabaseRow, parseSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";

const SkillRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  status: SkillStatusSchema,
  copied_from_skill_id: z.string().nullable(),
  created_by_agent_id: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  source_run_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type SkillRow = z.infer<typeof SkillRowSchema>;
type SkillUpdatePayload = Partial<Pick<SkillRow, "name" | "description" | "body" | "status">>;

export const MaterializedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  updatedAt: z.string().nullable(),
});

export const SkillsSnapshotSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  workspaceId: z.string(),
  skills: z.array(MaterializedSkillSchema),
});

export type SkillsSnapshot = z.infer<typeof SkillsSnapshotSchema>;

const SKILL_SELECT =
  "id,workspace_id,agent_id,name,description,body,status,copied_from_skill_id,created_by_agent_id,created_by_user_id,source_run_id,created_at,updated_at" as const;

type SupabaseError = Parameters<typeof normalizeSupabaseError>[1];

type TypedSkillRowsResponse = PromiseLike<{
  data: SkillRow[] | null;
  error: SupabaseError | null;
}>;

type TypedSkillSingleResponse = PromiseLike<{
  data: SkillRow | null;
  error: SupabaseError | null;
}>;

type TypedSkillQuery = TypedSkillRowsResponse & {
  select(columns: string): TypedSkillQuery;
  update(payload: SkillUpdatePayload): TypedSkillQuery;
  eq(column: string, value: unknown): TypedSkillQuery;
  order(column: string, options?: { ascending?: boolean }): TypedSkillQuery;
  limit(count: number): TypedSkillQuery;
  maybeSingle(): TypedSkillSingleResponse;
  single(): TypedSkillSingleResponse;
};

type TypedSkillTable = {
  select(columns: string): TypedSkillQuery;
  update(payload: SkillUpdatePayload): TypedSkillQuery;
};

function skillTable(): TypedSkillTable {
  return getServiceRoleSupabase().from("skill" as never) as unknown as TypedSkillTable;
}

function toSkill(row: SkillRow): Skill {
  return SkillSchema.parse({
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
  });
}

function skillUpdatePayload(input: SkillUpdateRequest): SkillUpdatePayload {
  const request = SkillUpdateRequestSchema.parse(input);
  return {
    ...(request.name !== undefined ? { name: request.name } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
  };
}

export async function listSkillsForWorkspace(workspaceId: string, filters: SkillListQuery): Promise<SkillListResponse> {
  return withRepositoryLogging(
    {
      repository: "skills",
      method: "listSkillsForWorkspace",
      table: "skill",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      let query = skillTable().select(SKILL_SELECT).eq("workspace_id", workspaceId);

      if (filters.agentId) query = query.eq("agent_id", filters.agentId);
      if (filters.status) query = query.eq("status", filters.status);

      const { data, error } = await query.order("updated_at", { ascending: false }).limit(filters.limit);
      if (error) throw normalizeSupabaseError("skill list", error);

      return SkillListResponseSchema.parse({
        skills: parseSupabaseRows("skill list", SkillRowSchema, Array.isArray(data) ? data : []).map(toSkill),
      });
    },
  );
}

export async function getSkillForWorkspace(skillId: string, workspaceId: string): Promise<Skill | null> {
  return withRepositoryLogging(
    {
      repository: "skills",
      method: "getSkillForWorkspace",
      table: "skill",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await skillTable()
        .select(SKILL_SELECT)
        .eq("id", skillId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("skill query", error);
      const row = parseNullableSupabaseRow("skill query", SkillRowSchema, data);
      return row ? toSkill(row) : null;
    },
  );
}

export async function updateSkillForWorkspace(input: {
  skillId: string;
  workspaceId: string;
  patch: SkillUpdateRequest;
}): Promise<Skill> {
  const existing = await getSkillForWorkspace(input.skillId, input.workspaceId);
  if (!existing) {
    throw new ApiRouteError(404, "skill_not_found", "Skill was not found");
  }

  return withRepositoryLogging(
    {
      repository: "skills",
      method: "updateSkillForWorkspace",
      table: "skill",
      operation: "update",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await skillTable()
        .update(skillUpdatePayload(input.patch))
        .eq("id", input.skillId)
        .eq("workspace_id", input.workspaceId)
        .select(SKILL_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("skill update", error);
      return toSkill(parseSupabaseRow("skill update", SkillRowSchema, data));
    },
  );
}

export async function resolveApprovedSkillsSnapshot(input: {
  agentId: string;
  workspaceId: string;
}): Promise<SkillsSnapshot> {
  return withRepositoryLogging(
    {
      repository: "skills",
      method: "resolveApprovedSkillsSnapshot",
      table: "skill",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await skillTable()
        .select(SKILL_SELECT)
        .eq("agent_id", input.agentId)
        .eq("workspace_id", input.workspaceId)
        .eq("status", "approved")
        .order("name", { ascending: true })
        .limit(1000);

      if (error) throw normalizeSupabaseError("skill approved list", error);

      const rows = parseSupabaseRows("skill approved list", SkillRowSchema, Array.isArray(data) ? data : []);

      return SkillsSnapshotSchema.parse({
        version: 1,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        skills: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          body: row.body,
          updatedAt: row.updated_at,
        })),
      });
    },
  );
}
