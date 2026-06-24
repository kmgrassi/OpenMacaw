import crypto from "node:crypto";

import type { TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import type { getServiceRoleSupabase } from "../../supabase-client.js";

/**
 * Generate the local-runtime-helper token to hand the helper, prefixed with
 * `lrh_`.
 *
 * Local-dev escape hatch: the dev orchestrator validates tokens against a
 * static allowlist (runtime `apps/orchestrator/config/dev.exs`) instead of the
 * DB, so a freshly-generated random token is rejected — which is the
 * cloud-token-against-the-local-endpoint failure. When `LOCAL_RELAY_DEV_TOKEN`
 * is set, registration hands back that fixed token instead so it matches the
 * dev allowlist. Ignored when `NODE_ENV === "production"` so it can never
 * weaken real token issuance, even if the variable leaks into a prod env.
 */
export function generateMachineToken(): string {
  const devToken = process.env.LOCAL_RELAY_DEV_TOKEN?.trim();
  if (devToken && process.env.NODE_ENV !== "production") return devToken;
  return `lrh_${crypto.randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex digest of a plaintext token (stored in DB, never the plaintext). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

type SupabaseClient = ReturnType<typeof getServiceRoleSupabase>;
const MACHINE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function createMachineToken(input: { supabase: SupabaseClient; machineId: string; workspaceId: string }) {
  const plaintextToken = generateMachineToken();
  const tokenRow: TablesInsert<"local_runtime_token"> & { expires_at: string } = {
    machine_id: input.machineId,
    workspace_id: input.workspaceId,
    token_hash: hashToken(plaintextToken),
    expires_at: new Date(Date.now() + MACHINE_TOKEN_TTL_MS).toISOString(),
  };
  const { error } = await narrowSupabase(input.supabase).from("local_runtime_token").insert(tokenRow);

  return { plaintextToken, error };
}

export async function revokeActiveMachineTokens(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineIds: string[];
  revokedAt: string;
}) {
  const machineIds = Array.from(new Set(input.machineIds.filter((id) => id.trim().length > 0)));
  if (machineIds.length === 0) return;

  const { error } = await input.supabase
    .from("local_runtime_token")
    .update({ revoked_at: input.revokedAt } satisfies TablesUpdate<"local_runtime_token">)
    .eq("workspace_id", input.workspaceId)
    .in("machine_id", machineIds)
    .is("revoked_at", null);

  if (error) {
    assertSupabaseSuccess("revoke local runtime machine tokens", null, error);
  }
}

export async function rotateMachineToken(input: { supabase: SupabaseClient; workspaceId: string; machineId: string }) {
  await revokeActiveMachineTokens({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    machineIds: [input.machineId],
    revokedAt: new Date().toISOString(),
  });

  const { plaintextToken, error } = await createMachineToken(input);
  if (error) {
    assertSupabaseSuccess("rotate local runtime machine token", null, error);
  }

  return plaintextToken;
}
