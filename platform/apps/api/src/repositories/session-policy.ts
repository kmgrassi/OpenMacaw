import type { PostgrestError } from "@supabase/supabase-js";

import { ApiRouteError } from "../http.js";
import { assertSupabaseNoError } from "../lib/supabase-errors.js";
import { getServiceRoleSupabase } from "../supabase-client.js";

type SessionThreadRow = {
  id: string;
  workspace_id: string;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
};

type PolicySessionStateRow = {
  key: string;
  value_numeric: number | string | null;
  value_json: unknown | null;
  updated_at: string | null;
};

type UntypedQueryResult<T> = PromiseLike<{ data: T | null; error: PostgrestError | null }>;

type UntypedQueryBuilder<T = unknown> = UntypedQueryResult<T[]> & {
  select(columns: string): UntypedQueryBuilder<T>;
  eq(column: string, value: string): UntypedQueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): UntypedQueryBuilder<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: PostgrestError | null }>;
};

type UntypedSupabaseClient = {
  from(tableName: string): UntypedQueryBuilder;
};

export type PolicySessionStateEntry = {
  key: string;
  valueNumeric: number | null;
  valueJson: unknown | null;
  updatedAt: string | null;
};

export type SessionPolicyState = {
  sessionThreadId: string;
  workspaceId: string;
  counters: {
    toolCallCount: number;
    accruedCostUsd: number;
    riskPoints: number;
  };
  state: PolicySessionStateEntry[];
};

function table(name: string) {
  return (getServiceRoleSupabase() as unknown as UntypedSupabaseClient).from(name);
}

async function assertWorkspaceMember(input: { workspaceId: string; userId: string }) {
  const { data, error } = await table("workspace_members")
    .select("workspace_id,user_id")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .maybeSingle();

  assertSupabaseNoError("workspace_members policy-state authorization query", error);
  if (!(data as WorkspaceMemberRow | null)) {
    throw new ApiRouteError(403, "workspace_forbidden", "You do not have access to this workspace");
  }
}

async function getSessionThread(input: { workspaceId: string; sessionThreadId: string }) {
  const { data, error } = await table("session_thread")
    .select("id,workspace_id")
    .eq("id", input.sessionThreadId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  assertSupabaseNoError("session_thread policy-state query", error);
  const row = data as SessionThreadRow | null;
  if (!row) {
    throw new ApiRouteError(404, "session_not_found", "Session thread was not found");
  }
  return row;
}

function numericValue(row: PolicySessionStateRow): number | null {
  if (typeof row.value_numeric === "number") return Number.isFinite(row.value_numeric) ? row.value_numeric : null;
  if (typeof row.value_numeric === "string") {
    const parsed = Number(row.value_numeric);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function counter(entries: PolicySessionStateEntry[], key: string) {
  return entries.find((entry) => entry.key === key)?.valueNumeric ?? 0;
}

export async function getSessionPolicyState(input: {
  userId: string;
  workspaceId: string;
  sessionThreadId: string;
}): Promise<SessionPolicyState> {
  await assertWorkspaceMember({ workspaceId: input.workspaceId, userId: input.userId });
  const session = await getSessionThread({
    workspaceId: input.workspaceId,
    sessionThreadId: input.sessionThreadId,
  });

  const { data, error } = await table("policy_session_state")
    .select("key,value_numeric,value_json,updated_at")
    .eq("workspace_id", input.workspaceId)
    .eq("session_thread_id", input.sessionThreadId)
    .order("key", { ascending: true });

  assertSupabaseNoError("policy_session_state query", error);

  const state = ((data ?? []) as PolicySessionStateRow[]).map((row) => ({
    key: row.key,
    valueNumeric: numericValue(row),
    valueJson: row.value_json,
    updatedAt: row.updated_at,
  }));

  return {
    sessionThreadId: session.id,
    workspaceId: session.workspace_id,
    counters: {
      toolCallCount: counter(state, "tool_call_count"),
      accruedCostUsd: counter(state, "accrued_cost_usd"),
      riskPoints: counter(state, "risk_points"),
    },
    state,
  };
}
