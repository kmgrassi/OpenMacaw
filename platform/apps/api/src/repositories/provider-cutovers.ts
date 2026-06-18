import { z } from "zod";

import type { CreateProviderCutoverRequest, ProviderCutover } from "../../../../contracts/provider-cutover.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { parseNullableSupabaseRow, parseSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { missingRepositoryRow, withRepositoryLogging } from "./logging.js";

const ProviderCutoverRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  work_item_id: z.string().uuid().nullable(),
  triggered_at: z.string(),
  from_provider: z.string(),
  from_model: z.string(),
  from_credential_id: z.string().uuid().nullable(),
  to_provider: z.string().nullable(),
  to_model: z.string().nullable(),
  to_credential_id: z.string().uuid().nullable(),
  trigger_error_code: z.string(),
  trigger_status_code: z.number().int().nullable(),
  elapsed_ms: z.number().int().nonnegative(),
  outcome: z.enum([
    "fallback_succeeded",
    "fallback_failed",
    "escalated_floor",
    "escalated_exhausted",
    "skipped_no_adapter",
  ]),
});

const WorkItemWorkspaceRowSchema = z.object({
  workspace_id: z.string().uuid(),
});

type ProviderCutoverRow = z.infer<typeof ProviderCutoverRowSchema>;
type ProviderCutoverInsert = Omit<ProviderCutoverRow, "id">;
type WorkItemWorkspaceRow = z.infer<typeof WorkItemWorkspaceRowSchema>;

const PROVIDER_CUTOVER_SELECT =
  "id,workspace_id,agent_id,work_item_id,triggered_at,from_provider,from_model,from_credential_id,to_provider,to_model,to_credential_id,trigger_error_code,trigger_status_code,elapsed_ms,outcome" as const;

type SupabaseError = Parameters<typeof normalizeSupabaseError>[1];

type TypedSupabaseResponse<Row> = PromiseLike<{
  data: Row[] | Row | null;
  error: SupabaseError | null;
}>;

type TypedSupabaseSingleResponse<Row> = PromiseLike<{
  data: Row | null;
  error: SupabaseError | null;
}>;

type TypedSupabaseQuery<Row> = TypedSupabaseResponse<Row> & {
  select: (columns?: string) => TypedSupabaseQuery<Row>;
  eq: (column: string, value: unknown) => TypedSupabaseQuery<Row>;
  lt: (column: string, value: unknown) => TypedSupabaseQuery<Row>;
  or: (filters: string) => TypedSupabaseQuery<Row>;
  order: (column: string, options?: Record<string, unknown>) => TypedSupabaseQuery<Row>;
  limit: (count: number) => TypedSupabaseResponse<Row>;
  single: () => TypedSupabaseSingleResponse<Row>;
  maybeSingle: () => TypedSupabaseSingleResponse<Row>;
};

type TypedSupabaseTable<Row, InsertRow> = {
  select: (columns?: string) => TypedSupabaseQuery<Row>;
  insert: (values: InsertRow) => TypedSupabaseQuery<Row>;
};

function providerCutoverTable(): TypedSupabaseTable<ProviderCutoverRow, ProviderCutoverInsert> {
  return getServiceRoleSupabase().from("provider_cutover" as never) as unknown as TypedSupabaseTable<
    ProviderCutoverRow,
    ProviderCutoverInsert
  >;
}

function workItemsTable(): TypedSupabaseTable<WorkItemWorkspaceRow, never> {
  return getServiceRoleSupabase().from("work_items") as unknown as TypedSupabaseTable<WorkItemWorkspaceRow, never>;
}

function mapProviderCutover(row: ProviderCutoverRow): ProviderCutover {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    workItemId: row.work_item_id,
    triggeredAt: row.triggered_at,
    fromProvider: row.from_provider,
    fromModel: row.from_model,
    fromCredentialId: row.from_credential_id,
    toProvider: row.to_provider,
    toModel: row.to_model,
    toCredentialId: row.to_credential_id,
    triggerErrorCode: row.trigger_error_code,
    triggerStatusCode: row.trigger_status_code,
    elapsedMs: row.elapsed_ms,
    outcome: row.outcome,
  };
}

function encodeRecentCursor(row: ProviderCutoverRow): string {
  return `${row.triggered_at}|${row.id}`;
}

function parseRecentCursor(cursor: string): { triggeredAt: string; id: string } {
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === cursor.length - 1) {
    throw new Error("Invalid provider cutover cursor");
  }
  return {
    triggeredAt: cursor.slice(0, separatorIndex),
    id: cursor.slice(separatorIndex + 1),
  };
}

export async function getWorkspaceIdForWorkItem(workItemId: string): Promise<string | null> {
  return withRepositoryLogging(
    {
      repository: "provider_cutovers",
      method: "getWorkspaceIdForWorkItem",
      table: "work_items",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
    },
    async () => {
      const { data, error } = await workItemsTable().select("workspace_id").eq("id", workItemId).maybeSingle();

      if (error) throw normalizeSupabaseError("work_items query", error);
      return parseNullableSupabaseRow("work_items query", WorkItemWorkspaceRowSchema, data)?.workspace_id ?? null;
    },
  );
}

export async function listForWorkItem(workItemId: string): Promise<ProviderCutover[]> {
  return withRepositoryLogging(
    {
      repository: "provider_cutovers",
      method: "listForWorkItem",
      table: "provider_cutover",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
    },
    async () => {
      const { data, error } = await providerCutoverTable()
        .select(PROVIDER_CUTOVER_SELECT)
        .eq("work_item_id", workItemId)
        .order("triggered_at", { ascending: false });

      if (error) throw normalizeSupabaseError("provider_cutover query", error);
      return parseSupabaseRows("provider_cutover query", ProviderCutoverRowSchema, Array.isArray(data) ? data : []).map(
        mapProviderCutover,
      );
    },
  );
}

export async function listRecentForWorkspace(
  workspaceId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: ProviderCutover[]; nextCursor: string | null }> {
  return withRepositoryLogging(
    {
      repository: "provider_cutovers",
      method: "listRecentForWorkspace",
      table: "provider_cutover",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId,
    },
    async () => {
      let query = providerCutoverTable()
        .select(PROVIDER_CUTOVER_SELECT)
        .eq("workspace_id", workspaceId)
        .order("triggered_at", { ascending: false })
        .order("id", { ascending: false });

      if (cursor) {
        const parsedCursor = parseRecentCursor(cursor);
        query = query.or(
          `triggered_at.lt.${parsedCursor.triggeredAt},and(triggered_at.eq.${parsedCursor.triggeredAt},id.lt.${parsedCursor.id})`,
        );
      }

      const { data, error } = await query.limit(limit + 1);
      if (error) throw normalizeSupabaseError("provider_cutover recent query", error);

      const rows = parseSupabaseRows(
        "provider_cutover recent query",
        ProviderCutoverRowSchema,
        Array.isArray(data) ? data : [],
      );
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map(mapProviderCutover),
        nextCursor: rows.length > limit && lastRow ? encodeRecentCursor(lastRow) : null,
      };
    },
  );
}

export async function create(input: {
  workItemId: string;
  workspaceId: string;
  cutover: CreateProviderCutoverRequest;
}): Promise<ProviderCutover> {
  const metadata = {
    repository: "provider_cutovers",
    method: "create",
    table: "provider_cutover",
    operation: "insert",
    expectedCardinality: "exactly_one",
    access: "service_role",
    workspaceId: input.workspaceId,
  } as const;

  return withRepositoryLogging(metadata, async () => {
    const { data, error } = await providerCutoverTable()
      .insert({
        workspace_id: input.workspaceId,
        agent_id: input.cutover.agentId,
        work_item_id: input.workItemId,
        triggered_at: input.cutover.triggeredAt ?? new Date().toISOString(),
        from_provider: input.cutover.fromProvider,
        from_model: input.cutover.fromModel,
        from_credential_id: input.cutover.fromCredentialId,
        to_provider: input.cutover.toProvider,
        to_model: input.cutover.toModel,
        to_credential_id: input.cutover.toCredentialId,
        trigger_error_code: input.cutover.triggerErrorCode,
        trigger_status_code: input.cutover.triggerStatusCode,
        elapsed_ms: input.cutover.elapsedMs,
        outcome: input.cutover.outcome,
      })
      .select(PROVIDER_CUTOVER_SELECT)
      .single();

    if (error) throw normalizeSupabaseError("provider_cutover insert", error);
    const row = parseSupabaseRow("provider_cutover insert", ProviderCutoverRowSchema, data);
    if (!row) throw missingRepositoryRow(metadata, "Provider cutover insert returned no row");
    return mapProviderCutover(row);
  });
}
