import { ApiRouteError } from "../../http.js";
import { narrowSupabase, type NarrowSupabaseQuery } from "../../lib/narrow-supabase.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../../supabase-client.js";

export function queryFrom<Row = Record<string, unknown>>(table: string): NarrowSupabaseQuery<Row> {
  return narrowSupabase(getServiceRoleSupabase()).from<Row>(table);
}

function missingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "PGRST204" ||
    code === "PGRST205" ||
    code === "42703" ||
    message.includes("PGRST204") ||
    message.includes("PGRST205") ||
    message.includes("42703") ||
    message.includes("Could not find") ||
    message.includes("schema cache")
  );
}

export async function executeSchemaAwareRows<Row>(
  context: string,
  query: PromiseLike<{ data: unknown; error: unknown | null }>,
): Promise<Row[]> {
  try {
    const { data, error } = await query;
    if (error) throw normalizeSupabaseError(context, error as never);
    if (!data) return [];
    return (Array.isArray(data) ? data : [data]) as Row[];
  } catch (error) {
    if (missingSchema(error)) {
      throw new ApiRouteError(
        503,
        "routing_tool_schema_unavailable",
        "Routing tools require the intelligent cutover routing schema migrations before they can be used",
        { context },
      );
    }
    throw error;
  }
}
