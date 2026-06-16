import { z } from "zod";

import type { Tables, TablesInsert } from "@kmgrassi/supabase-schema";
import {
  MemoryHybridSearchRequestSchema,
  MemoryItemListResponseSchema,
  MemoryItemSchema,
  MemoryScopeSchema,
  MemoryWriteRequestSchema,
  type MemoryHybridSearchRequest,
  type MemoryHybridSearchResult,
  type MemoryItem,
  type MemoryItemListQuery,
  type MemoryItemListResponse,
  type MemoryWriteRequest,
} from "../../../../contracts/memory-items.js";
import { ApiRouteError } from "../http.js";
import { logEvent } from "../logger.js";
import { workspaceMemoryBudget } from "../services/learning/memory-budget.js";
import { getServiceRoleSupabase, normalizeSupabaseError, type ApiSupabaseClient } from "../supabase-client.js";
import {
  JsonValueSchema,
  parseNullableSupabaseRow,
  parseSupabaseRow,
  parseSupabaseRows,
} from "../lib/supabase-row-parsers.js";
import { withRepositoryLogging } from "./logging.js";

const MemoryItemRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string().nullable(),
  scope: MemoryScopeSchema,
  content: z.string(),
  tags: JsonValueSchema,
  importance: z.number(),
  event_time: z.string(),
  source_run_id: z.string().nullable(),
  source_task_id: z.string().nullable(),
  source_path: z.string().nullable(),
  canonical_id: z.string().nullable(),
  supersedes_id: z.string().nullable(),
  is_deleted: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const MemoryHybridSearchRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  agent_id: z.string().nullable(),
  scope: MemoryScopeSchema,
  content: z.string(),
  tags: JsonValueSchema,
  importance: z.number(),
  event_time: z.string(),
  source_run_id: z.string().nullable(),
  source_task_id: z.string().nullable(),
  score: z.number(),
});

const WorkspaceMemorySettingsRowSchema = z
  .object({
    id: z.string(),
    settings: z.unknown().optional(),
  })
  .passthrough();

export type MemoryItemRow = z.infer<typeof MemoryItemRowSchema>;
export type MemoryHybridSearchRow = z.infer<typeof MemoryHybridSearchRowSchema>;

export const MEMORY_ITEM_SELECT =
  "id,workspace_id,agent_id,scope,content,tags,importance,event_time,source_run_id,source_task_id,source_path,canonical_id,supersedes_id,is_deleted,created_at,updated_at" as const;

type SupabaseRpcResponse = PromiseLike<{
  data: unknown;
  error: Parameters<typeof normalizeSupabaseError>[1] | null;
}>;

type MemoryRpcClient = {
  rpc(functionName: "memory_hybrid_search", args: Record<string, unknown>): SupabaseRpcResponse;
};

type SupabaseCountResponse = PromiseLike<{
  count: number | null;
  error: Parameters<typeof normalizeSupabaseError>[1] | null;
}>;

type ParsedMemoryWriteRequest = z.output<typeof MemoryWriteRequestSchema>;

function toMemoryItem(row: MemoryItemRow): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    scope: row.scope,
    content: row.content,
    tags: row.tags,
    importance: row.importance,
    eventTime: row.event_time,
    sourceRunId: row.source_run_id,
    sourceTaskId: row.source_task_id,
    sourcePath: row.source_path,
    canonicalId: row.canonical_id,
    supersedesId: row.supersedes_id,
    isDeleted: row.is_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toHybridSearchResult(row: MemoryHybridSearchRow): MemoryHybridSearchResult {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    scope: row.scope,
    content: row.content,
    tags: row.tags,
    importance: row.importance,
    eventTime: row.event_time,
    sourceRunId: row.source_run_id,
    sourceTaskId: row.source_task_id,
    score: row.score,
  };
}

function memoryInsert(input: ParsedMemoryWriteRequest): TablesInsert<"memory_items"> {
  return {
    workspace_id: input.workspaceId,
    agent_id: input.agentId ?? null,
    scope: input.scope,
    content: input.content,
    tags: input.tags,
    importance: input.importance,
    event_time: input.eventTime ?? new Date().toISOString(),
    source_run_id: input.sourceRunId ?? null,
    source_task_id: input.sourceTaskId ?? null,
    source_path: input.sourcePath ?? null,
    canonical_id: input.canonicalId ?? null,
    supersedes_id: input.supersedesId ?? null,
    is_deleted: false,
    embedding: input.embedding ?? null,
  };
}

async function loadWorkspaceMemorySettings(workspaceId: string) {
  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "loadWorkspaceMemorySettings",
      table: "workspaces",
      operation: "select",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("workspaces")
        .select("id,settings")
        .eq("id", workspaceId)
        .single();

      if (error) throw normalizeSupabaseError("workspace memory settings query", error);
      return parseSupabaseRow("workspace memory settings query", WorkspaceMemorySettingsRowSchema, data);
    },
  );
}

async function countActiveMemoryItems(workspaceId: string) {
  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "countActiveMemoryItems",
      table: "memory_items",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { count, error } = await (getServiceRoleSupabase()
        .from("memory_items")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("is_deleted", false) as unknown as SupabaseCountResponse);

      if (error) throw normalizeSupabaseError("memory_items count", error);
      return count ?? 0;
    },
  );
}

async function assertWorkspaceMemoryBudget(request: ParsedMemoryWriteRequest) {
  const workspace = await loadWorkspaceMemorySettings(request.workspaceId);
  const memoryBudget = workspaceMemoryBudget(workspace.settings);
  const memoryCount = await countActiveMemoryItems(request.workspaceId);

  if (memoryCount < memoryBudget) return;

  logEvent({
    event: "memory_write_budget_exceeded",
    level: "warn",
    workspace_id: request.workspaceId,
    source_run_id: request.sourceRunId ?? null,
    memory_budget: memoryBudget,
    memory_count: memoryCount,
  });
  throw new ApiRouteError(409, "memory_budget_exceeded", "Workspace memory budget has been reached", {
    workspaceId: request.workspaceId,
    memoryBudget,
    memoryCount,
  });
}

export async function insertMemoryItem(input: MemoryWriteRequest): Promise<MemoryItem> {
  const request = MemoryWriteRequestSchema.parse(input);
  await assertWorkspaceMemoryBudget(request);

  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "insertMemoryItem",
      table: "memory_items",
      operation: "insert",
      expectedCardinality: "exactly_one",
      access: "service_role",
      workspaceId: request.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("memory_items")
        .insert(memoryInsert(request))
        .select(MEMORY_ITEM_SELECT)
        .single();

      if (error) throw normalizeSupabaseError("memory_items insert", error);
      return toMemoryItem(parseSupabaseRow("memory_items insert", MemoryItemRowSchema, data));
    },
  );
}

export async function listRecentRunSummaryMemories(input: {
  workspaceId: string;
  limit?: number;
}): Promise<MemoryItem[]> {
  const limit = input.limit ?? 250;

  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "listRecentRunSummaryMemories",
      table: "memory_items",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("memory_items")
        .select(MEMORY_ITEM_SELECT)
        .eq("workspace_id", input.workspaceId)
        .eq("scope", "run_summary")
        .eq("is_deleted", false)
        .order("event_time", { ascending: false })
        .limit(limit);

      if (error) throw normalizeSupabaseError("memory_items recent run summaries", error);
      return parseSupabaseRows(
        "memory_items recent run summaries",
        MemoryItemRowSchema,
        Array.isArray(data) ? data : [],
      ).map(toMemoryItem);
    },
  );
}

export async function getMemoryItem(id: string, workspaceId: string): Promise<MemoryItem | null> {
  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "getMemoryItem",
      table: "memory_items",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("memory_items")
        .select(MEMORY_ITEM_SELECT)
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .eq("is_deleted", false)
        .maybeSingle();

      if (error) throw normalizeSupabaseError("memory_items query", error);
      const row = parseNullableSupabaseRow("memory_items query", MemoryItemRowSchema, data);
      return row ? toMemoryItem(row) : null;
    },
  );
}

export async function listMemoryItemsForWorkspace(
  workspaceId: string,
  filters: MemoryItemListQuery,
): Promise<MemoryItemListResponse> {
  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "listMemoryItemsForWorkspace",
      table: "memory_items",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      let query = getServiceRoleSupabase()
        .from("memory_items")
        .select(MEMORY_ITEM_SELECT)
        .eq("workspace_id", workspaceId)
        .eq("is_deleted", false);

      if (filters.agentId !== undefined) {
        query = filters.agentId === null ? query.is("agent_id", null) : query.eq("agent_id", filters.agentId);
      }
      if (filters.scope) query = query.eq("scope", filters.scope);
      if (filters.importanceMin !== undefined) query = query.gte("importance", filters.importanceMin);
      if (filters.sourceRunId) query = query.eq("source_run_id", filters.sourceRunId);

      const { data, error } = await query.order("event_time", { ascending: false }).limit(filters.limit);
      if (error) throw normalizeSupabaseError("memory_items list", error);

      return MemoryItemListResponseSchema.parse({
        memoryItems: parseSupabaseRows("memory_items list", MemoryItemRowSchema, Array.isArray(data) ? data : []).map(
          toMemoryItem,
        ),
      });
    },
  );
}

export async function searchMemoryItemsHybrid(input: MemoryHybridSearchRequest): Promise<MemoryHybridSearchResult[]> {
  const request = MemoryHybridSearchRequestSchema.parse(input);

  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "searchMemoryItemsHybrid",
      table: "memory_hybrid_search",
      operation: "rpc",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: request.workspaceId,
    },
    async () => {
      const { data, error } = await (getServiceRoleSupabase() as unknown as MemoryRpcClient).rpc(
        "memory_hybrid_search",
        {
          p_workspace_id: request.workspaceId,
          p_agent_id: request.agentId ?? null,
          p_scope: request.scope ?? null,
          p_query_text: request.queryText,
          p_query_embedding: request.queryEmbedding ?? null,
          p_match_count: request.limit,
        },
      );

      if (error) throw normalizeSupabaseError("memory_hybrid_search rpc", error);
      return parseSupabaseRows(
        "memory_hybrid_search rpc",
        MemoryHybridSearchRowSchema,
        Array.isArray(data) ? data : [],
      ).map(toHybridSearchResult);
    },
  );
}

function sortPinnedMemoryItems(items: MemoryItem[]) {
  return [...items].sort(
    (left, right) => right.importance - left.importance || right.eventTime.localeCompare(left.eventTime),
  );
}

async function listPinnedLongTermMemoryItemsForAgent(input: {
  workspaceId: string;
  agentId: string | null;
  limit: number;
  supabase: ApiSupabaseClient;
}) {
  let query = input.supabase
    .from("memory_items")
    .select(MEMORY_ITEM_SELECT)
    .eq("workspace_id", input.workspaceId)
    .eq("is_deleted", false)
    .eq("scope", "long_term");
  query = input.agentId === null ? query.is("agent_id", null) : query.eq("agent_id", input.agentId);

  const { data, error } = await query.order("importance", { ascending: false }).limit(input.limit);
  if (error) throw normalizeSupabaseError("memory_items pinned query", error);
  return parseSupabaseRows("memory_items pinned query", MemoryItemRowSchema, Array.isArray(data) ? data : []).map(
    toMemoryItem,
  );
}

export async function listPinnedLongTermMemoryItems(input: {
  workspaceId: string;
  agentId?: string | null;
  limit: number;
  supabase?: ApiSupabaseClient;
}): Promise<MemoryItem[]> {
  const supabase = input.supabase ?? getServiceRoleSupabase();
  const visibleAgentIds = input.agentId ? [null, input.agentId] : [null];

  return withRepositoryLogging(
    {
      repository: "memory-items",
      method: "listPinnedLongTermMemoryItems",
      table: "memory_items",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const rows = (
        await Promise.all(
          visibleAgentIds.map((agentId) =>
            listPinnedLongTermMemoryItemsForAgent({
              workspaceId: input.workspaceId,
              agentId,
              limit: input.limit,
              supabase,
            }),
          ),
        )
      ).flat();
      return sortPinnedMemoryItems(Array.from(new Map(rows.map((row) => [row.id, row])).values())).slice(
        0,
        input.limit,
      );
    },
  );
}

export type MemoryItemsTableRow = Tables<"memory_items">;
