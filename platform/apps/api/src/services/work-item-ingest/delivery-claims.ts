import { executeSupabaseRows, getServiceRoleSupabase, normalizeSupabaseQueryError } from "../../supabase-client.js";

type WebhookDeliverySource = "github" | "linear";

type WebhookDeliveryRow = {
  id: string;
};

type WebhookDeliveryInsertRow = {
  source: WebhookDeliverySource;
  delivery_id: string;
  event_name: string;
  workspace_id: string;
  external_id: string;
};

type UntypedSupabaseInsertBuilder = {
  select(columns: string): PromiseLike<{ data: unknown; error: unknown | null }>;
};

type UntypedSupabaseQueryBuilder = {
  select(columns: string): UntypedSupabaseQueryBuilder;
  eq(column: string, value: unknown): UntypedSupabaseQueryBuilder;
  limit(count: number): UntypedSupabaseQueryBuilder;
  insert(value: WebhookDeliveryInsertRow): UntypedSupabaseInsertBuilder;
  delete(): UntypedSupabaseQueryBuilder;
};

type UntypedSupabaseClient = {
  from(table: string): UntypedSupabaseQueryBuilder;
};

function deliverySupabase() {
  return getServiceRoleSupabase() as never as UntypedSupabaseClient;
}

function isUniqueViolation(error: unknown): boolean {
  const normalized = normalizeSupabaseQueryError(error as never, "webhook delivery insert");
  return normalized?.code === "23505";
}

export async function claimWebhookDelivery(input: {
  source: WebhookDeliverySource;
  deliveryId: string;
  eventName: string;
  workspaceId: string;
  externalId: string;
}): Promise<boolean> {
  const existing = await executeSupabaseRows<WebhookDeliveryRow>(
    "webhook delivery lookup",
    deliverySupabase()
      .from("webhook_delivery")
      .select("id")
      .eq("source", input.source)
      .eq("delivery_id", input.deliveryId)
      .limit(1) as never,
  );
  if (existing.length > 0) {
    return false;
  }

  const { error } = await deliverySupabase()
    .from("webhook_delivery")
    .insert({
      source: input.source,
      delivery_id: input.deliveryId,
      event_name: input.eventName,
      workspace_id: input.workspaceId,
      external_id: input.externalId,
    })
    .select("id");

  if (!error) {
    return true;
  }
  if (isUniqueViolation(error)) {
    return false;
  }
  throw error;
}

export async function releaseWebhookDeliveryClaim(input: {
  source: WebhookDeliverySource;
  deliveryId: string;
}): Promise<void> {
  await deliverySupabase()
    .from("webhook_delivery")
    .delete()
    .eq("source", input.source)
    .eq("delivery_id", input.deliveryId);
}
