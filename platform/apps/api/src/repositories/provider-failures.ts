import { z } from "zod";

import {
  ProviderFailureErrorCodeSchema,
  ProviderFailureProviderSchema,
  ProviderFailureRunnerKindSchema,
  type ProviderFailure,
  type ProviderFailureSummaryEntry,
} from "../../../../contracts/provider-failures.js";
import { narrowSupabase } from "../lib/narrow-supabase.js";
import { parseSupabaseRows } from "../lib/supabase-row-parsers.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { withRepositoryLogging } from "./logging.js";

const PROVIDER_FAILURE_SELECT =
  "id,created_at,workspace_id,agent_id,work_item_id,run_id,runner_kind,provider,model,error_code,status_code,attempt" as const;
type SupabaseError = Parameters<typeof normalizeSupabaseError>[1];

const ProviderFailureRowSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  workspace_id: z.string(),
  agent_id: z.string().nullable(),
  work_item_id: z.string().nullable(),
  run_id: z.string().nullable(),
  runner_kind: ProviderFailureRunnerKindSchema,
  provider: ProviderFailureProviderSchema,
  model: z.string(),
  error_code: ProviderFailureErrorCodeSchema,
  status_code: z.number().int().nullable(),
  attempt: z.number().int(),
});

type ProviderFailureRow = z.infer<typeof ProviderFailureRowSchema>;

function providerFailureTable() {
  return narrowSupabase(getServiceRoleSupabase()).from<ProviderFailureRow>("provider_failure");
}

function mapProviderFailureRow(row: ProviderFailureRow): ProviderFailure {
  return {
    id: row.id,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    runnerKind: row.runner_kind,
    provider: row.provider,
    model: row.model,
    errorCode: row.error_code,
    statusCode: row.status_code,
    attempt: row.attempt,
  };
}

function parseRows(context: string, data: ProviderFailureRow[] | ProviderFailureRow | null): ProviderFailure[] {
  const rows = parseSupabaseRows(context, ProviderFailureRowSchema, Array.isArray(data) ? data : []);
  return rows.map(mapProviderFailureRow);
}

function pageOffset(cursor?: string | null): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function listRecentProviderFailures(input: {
  workspaceId: string;
  limit: number;
  cursor?: string | null;
}): Promise<{ items: ProviderFailure[]; nextCursor: string | null }> {
  return withRepositoryLogging(
    {
      repository: "provider_failures",
      method: "listRecentProviderFailures",
      table: "provider_failure",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      const offset = pageOffset(input.cursor);
      const { data, error } = await providerFailureTable()
        .select(PROVIDER_FAILURE_SELECT)
        .eq("workspace_id", input.workspaceId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit);

      if (error) throw normalizeSupabaseError("provider_failure recent query", error as SupabaseError);
      const rows = parseRows("provider_failure recent query", data);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? String(offset + limit) : null,
      };
    },
  );
}

export async function summarizeProviderFailures(input: {
  workspaceId: string;
  since: string;
}): Promise<ProviderFailureSummaryEntry[]> {
  return withRepositoryLogging(
    {
      repository: "provider_failures",
      method: "summarizeProviderFailures",
      table: "provider_failure",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const groups = new Map<string, ProviderFailureSummaryEntry>();
      const pageSize = 1000;
      let offset = 0;

      for (;;) {
        const { data, error } = await providerFailureTable()
          .select(PROVIDER_FAILURE_SELECT)
          .eq("workspace_id", input.workspaceId)
          .gte("created_at", input.since)
          .order("created_at", { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) throw normalizeSupabaseError("provider_failure summary query", error as SupabaseError);
        const rows = parseRows("provider_failure summary query", data);

        for (const row of rows) {
          const key = `${row.provider}\u0000${row.model}\u0000${row.errorCode}`;
          const existing = groups.get(key);
          if (existing) {
            existing.count += 1;
            continue;
          }
          groups.set(key, {
            provider: row.provider,
            model: row.model,
            errorCode: row.errorCode,
            count: 1,
          });
        }

        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      return Array.from(groups.values()).sort((left, right) => right.count - left.count);
    },
  );
}
