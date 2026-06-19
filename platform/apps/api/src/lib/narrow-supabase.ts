import type { PostgrestError } from "@supabase/supabase-js";

import type { ApiSupabaseClient } from "../supabase-client.js";

type JsonRecord = Record<string, unknown>;

export type NarrowSupabaseResult<Row> = PromiseLike<{
  data: Row[] | Row | null;
  error: PostgrestError | null;
}>;

export type NarrowSupabaseQuery<Row = JsonRecord> = NarrowSupabaseResult<Row> & {
  select(columns?: string): NarrowSupabaseQuery<Row>;
  eq(column: string, value: unknown): NarrowSupabaseQuery<Row>;
  gte(column: string, value: unknown): NarrowSupabaseQuery<Row>;
  in(column: string, values: unknown[]): NarrowSupabaseQuery<Row>;
  is(column: string, value: unknown): NarrowSupabaseQuery<Row>;
  or(expression: string): NarrowSupabaseQuery<Row>;
  order(column: string, options?: { ascending?: boolean }): NarrowSupabaseQuery<Row>;
  limit(count: number): NarrowSupabaseQuery<Row>;
  range(from: number, to: number): NarrowSupabaseQuery<Row>;
  insert(body: unknown): NarrowSupabaseQuery<Row>;
  update(body: unknown): NarrowSupabaseQuery<Row>;
  upsert(body: unknown, options?: { onConflict?: string }): NarrowSupabaseQuery<Row>;
  delete(): NarrowSupabaseQuery<Row>;
  single(): Promise<{ data: Row | null; error: PostgrestError | null }>;
  maybeSingle(): Promise<{ data: Row | null; error: PostgrestError | null }>;
};

export type NarrowSupabaseClient = {
  from<Row = JsonRecord>(table: string): NarrowSupabaseQuery<Row>;
};

export function narrowSupabase(client: ApiSupabaseClient): NarrowSupabaseClient {
  return client as unknown as NarrowSupabaseClient;
}
