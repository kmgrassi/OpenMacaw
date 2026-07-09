import { z } from "zod";

import type { CredentialReference } from "../../../../contracts/credentials.js";
import type { ModelTierFloor } from "../../../../contracts/model-tiers.js";
import { RunnerKindSchema } from "../../../../contracts/execution-profile.js";
import { getServiceRoleSupabase, normalizeSupabaseError } from "../supabase-client.js";
import { normalizeCredentialAlias } from "./credentials.js";
import { missingRepositoryRow, withRepositoryLogging } from "./logging.js";
import { parseNullableSupabaseRow, parseSupabaseRow, parseSupabaseRows } from "../lib/supabase-row-parsers.js";

/**
 * Mirrors the `routing_rule_runner_kind_check` / `routing_rule_provider_check`
 * DB allowlists (platform/supabase/migrations/, most recently
 * 20260612120000_drop_local_runtime_runner_kind.sql). The contract
 * test in routing-rules.test.ts asserts every value the platform writes
 * stays inside these sets — drift between platform enums and DB
 * constraints has bitten us twice already (credential.kind, then
 * routing_rule.provider when openai_codex shipped). When the platform
 * adds a runner_kind or execution provider, update these constants and
 * land the matching migration in the same change.
 */
export const ROUTING_RULE_RUNNER_KIND_ALLOWED = new Set<string>([
  "codex",
  "claude_code",
  "openclaw",
  "local_model_coding",
  "llm_tool_runner",
  "planner",
  "openclaw_ws",
  "openclaw_http_sse",
  "computer_use",
  "local_relay",
]);

export const ROUTING_RULE_PROVIDER_ALLOWED = new Set<string>([
  // Cloud LLM credential providers (mirror CREDENTIAL_PROVIDER_IDS).
  "openai",
  "anthropic",
  "openai_compatible",
  "openai_codex",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "azure",
  // Runtime-family providers.
  "codex",
  "openclaw",
  "computer_use",
  "local",
]);

class RoutingRuleConstraintError extends Error {
  constructor(column: "runner_kind" | "provider", value: string) {
    super(
      `routing_rule.${column}=${JSON.stringify(value)} would violate the DB check constraint. ` +
        `Add it to the harper-server allowlist before writing, or pick a value from ` +
        `ROUTING_RULE_${column.toUpperCase()}_ALLOWED.`,
    );
    this.name = "RoutingRuleConstraintError";
  }
}

function assertRoutingRuleValuesAllowed(runnerKind: string, provider: string | null) {
  if (!ROUTING_RULE_RUNNER_KIND_ALLOWED.has(runnerKind)) {
    throw new RoutingRuleConstraintError("runner_kind", runnerKind);
  }
  if (provider !== null && !ROUTING_RULE_PROVIDER_ALLOWED.has(provider)) {
    throw new RoutingRuleConstraintError("provider", provider);
  }
}

const AgentCredentialReferenceRuleSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  runner_kind: RunnerKindSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  credential_id: z.string().nullable(),
  credential_alias: z.string().nullable(),
  model_tier_floor: z.enum(["any", "local", "mid", "frontier"]).nullable().optional(),
  updated_at: z.string(),
});

const RoutingRuleFallbackSchema = z.object({
  routing_rule_id: z.string(),
  workspace_id: z.string(),
  position: z.number().int(),
  provider: z.string(),
  model: z.string(),
  credential_id: z.string().nullable(),
  credential_alias: z.string().nullable(),
});

const RoutingRuleMatchIdSchema = z.object({
  id: z.string(),
});

export type AgentCredentialReferenceRule = z.infer<typeof AgentCredentialReferenceRuleSchema>;
export type RoutingRuleFallback = z.infer<typeof RoutingRuleFallbackSchema>;

export type RoutingRuleFallbackInput = {
  provider: string;
  model: string;
  credentialRef: CredentialReference | null;
};

const AGENT_CREDENTIAL_RULE_SELECT =
  "id,workspace_id,name,runner_kind,provider,model,credential_id,credential_alias,model_tier_floor,updated_at" as const;

function agentCredentialRuleName(agentId: string): string {
  return `agent:${agentId}:execution-profile`;
}

function isDuplicateRuleNameError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "23505" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("uq_routing_rule_workspace_name")
  );
}

export function credentialRefFromRoutingRule(rule: AgentCredentialReferenceRule | null): CredentialReference | null {
  if (rule?.credential_alias) {
    return { type: "alias", value: rule.credential_alias };
  }
  if (rule?.credential_id) {
    return { type: "credential_id", value: rule.credential_id };
  }
  return null;
}

export function credentialRefFromRoutingRuleFallback(fallback: RoutingRuleFallback): CredentialReference | null {
  if (fallback.credential_alias) {
    return { type: "alias", value: fallback.credential_alias };
  }
  if (fallback.credential_id) {
    return { type: "credential_id", value: fallback.credential_id };
  }
  return null;
}

export async function getAgentCredentialReferenceRule(input: {
  agentId: string;
  workspaceId: string;
}): Promise<AgentCredentialReferenceRule | null> {
  return withRepositoryLogging(
    {
      repository: "routing_rules",
      method: "getAgentCredentialReferenceRule",
      table: "routing_rule",
      operation: "select",
      expectedCardinality: "zero_or_one",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("routing_rule")
        .select(AGENT_CREDENTIAL_RULE_SELECT)
        .eq("workspace_id", input.workspaceId)
        .eq("name", agentCredentialRuleName(input.agentId))
        .maybeSingle();

      if (error) throw normalizeSupabaseError("routing_rule query", error);
      return parseNullableSupabaseRow("routing_rule query", AgentCredentialReferenceRuleSchema, data);
    },
  );
}

export async function listRoutingRuleFallbacks(input: {
  ruleId: string;
  workspaceId: string;
}): Promise<RoutingRuleFallback[]> {
  return withRepositoryLogging(
    {
      repository: "routing_rules",
      method: "listRoutingRuleFallbacks",
      table: "routing_rule_fallback",
      operation: "select",
      expectedCardinality: "zero_or_more",
      access: "service_role",
      workspaceId: input.workspaceId,
    },
    async () => {
      const { data, error } = await getServiceRoleSupabase()
        .from("routing_rule_fallback" as never)
        .select("routing_rule_id,workspace_id,position,provider,model,credential_id,credential_alias")
        .eq("routing_rule_id", input.ruleId)
        .eq("workspace_id", input.workspaceId)
        .order("position", { ascending: true });
      if (error) throw normalizeSupabaseError("routing_rule_fallback query", error);
      return parseSupabaseRows("routing_rule_fallback query", RoutingRuleFallbackSchema, data);
    },
  );
}

export async function upsertAgentCredentialReferenceRule(input: {
  agentId: string;
  workspaceId: string;
  runnerKind: string;
  provider: string | null;
  model: string | null;
  credentialRef: CredentialReference | null;
  fallbacks?: RoutingRuleFallbackInput[];
  modelTierFloor?: ModelTierFloor;
  localEndpointUrl?: string | null;
  localMachineId?: string | null;
}): Promise<AgentCredentialReferenceRule> {
  // Fail fast with a clear message before the DB rejects the row. The
  // raw 23514 from PostgREST gives the failing values but obscures the
  // intent; surfacing here points the developer straight at the
  // platform/DB drift.
  assertRoutingRuleValuesAllowed(input.runnerKind, input.provider);

  const metadata = {
    repository: "routing_rules",
    method: "upsertAgentCredentialReferenceRule",
    table: "routing_rule",
    operation: "upsert",
    expectedCardinality: "exactly_one",
    access: "service_role",
    workspaceId: input.workspaceId,
  } as const;

  return withRepositoryLogging(metadata, async () => {
    const current = await getAgentCredentialReferenceRule(input);
    const now = new Date().toISOString();
    const credentialPatch =
      input.credentialRef?.type === "alias"
        ? {
            credential_alias: normalizeCredentialAlias(input.credentialRef.value),
            credential_id: null,
          }
        : input.credentialRef?.type === "credential_id"
          ? {
              credential_alias: null,
              credential_id: input.credentialRef.value,
            }
          : {
              credential_alias: null,
              credential_id: null,
            };

    const body = {
      runner_kind: input.runnerKind,
      provider: input.provider,
      model: input.model,
      enabled: true,
      updated_at: now,
      ...(input.modelTierFloor ? { model_tier_floor: input.modelTierFloor } : {}),
      ...credentialPatch,
    };

    async function updateExistingRule(rule: AgentCredentialReferenceRule): Promise<AgentCredentialReferenceRule> {
      const { data, error } = await getServiceRoleSupabase()
        .from("routing_rule")
        .update(body as never)
        .eq("id", rule.id)
        .eq("workspace_id", input.workspaceId)
        .select(AGENT_CREDENTIAL_RULE_SELECT)
        .maybeSingle();
      if (error) throw normalizeSupabaseError("routing_rule update", error);
      const updated = parseNullableSupabaseRow("routing_rule update", AgentCredentialReferenceRuleSchema, data);
      if (!updated) throw missingRepositoryRow(metadata, "Routing rule update returned no row");
      await ensureAgentCredentialReferenceRuleMatch({
        ruleId: updated.id,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
      });
      await syncAgentLocalEndpointMatch({
        ruleId: updated.id,
        workspaceId: input.workspaceId,
        endpointUrl: input.localEndpointUrl,
      });
      await syncAgentLocalMachineMatch({
        ruleId: updated.id,
        workspaceId: input.workspaceId,
        machineId: input.localMachineId,
      });
      if (input.fallbacks) {
        await syncRoutingRuleFallbacks({
          ruleId: updated.id,
          workspaceId: input.workspaceId,
          fallbacks: input.fallbacks,
        });
      }
      return updated;
    }

    if (current) {
      return updateExistingRule(current);
    }

    const { data, error } = await getServiceRoleSupabase()
      .from("routing_rule")
      .insert({
        workspace_id: input.workspaceId,
        name: agentCredentialRuleName(input.agentId),
        priority: 100,
        model_tier_floor: input.modelTierFloor ?? "any",
        ...body,
      } as never)
      .select(AGENT_CREDENTIAL_RULE_SELECT)
      .single();
    if (error) {
      if (isDuplicateRuleNameError(error)) {
        const concurrentRule = await getAgentCredentialReferenceRule(input);
        if (concurrentRule) return updateExistingRule(concurrentRule);
      }
      throw normalizeSupabaseError("routing_rule insert", error);
    }
    const inserted = parseSupabaseRow("routing_rule insert", AgentCredentialReferenceRuleSchema, data);
    await ensureAgentCredentialReferenceRuleMatch({
      ruleId: inserted.id,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    await syncAgentLocalEndpointMatch({
      ruleId: inserted.id,
      workspaceId: input.workspaceId,
      endpointUrl: input.localEndpointUrl,
    });
    await syncAgentLocalMachineMatch({
      ruleId: inserted.id,
      workspaceId: input.workspaceId,
      machineId: input.localMachineId,
    });
    if (input.fallbacks) {
      await syncRoutingRuleFallbacks({
        ruleId: inserted.id,
        workspaceId: input.workspaceId,
        fallbacks: input.fallbacks,
      });
    }
    return inserted;
  });
}

async function syncRoutingRuleFallbacks(input: {
  ruleId: string;
  workspaceId: string;
  fallbacks: RoutingRuleFallbackInput[];
}) {
  const supabase = getServiceRoleSupabase();
  const { error: deleteError } = await supabase
    .from("routing_rule_fallback" as never)
    .delete()
    .eq("routing_rule_id", input.ruleId)
    .eq("workspace_id", input.workspaceId);
  if (deleteError) throw normalizeSupabaseError("routing_rule_fallback delete", deleteError);

  if (input.fallbacks.length === 0) return;

  const rows = input.fallbacks.map((fallback, index) => {
    if (!ROUTING_RULE_PROVIDER_ALLOWED.has(fallback.provider)) {
      throw new RoutingRuleConstraintError("provider", fallback.provider);
    }

    const credentialPatch =
      fallback.credentialRef?.type === "alias"
        ? {
            credential_alias: normalizeCredentialAlias(fallback.credentialRef.value),
            credential_id: null,
          }
        : fallback.credentialRef?.type === "credential_id"
          ? {
              credential_alias: null,
              credential_id: fallback.credentialRef.value,
            }
          : {
              credential_alias: null,
              credential_id: null,
            };

    return {
      routing_rule_id: input.ruleId,
      workspace_id: input.workspaceId,
      position: index,
      provider: fallback.provider,
      model: fallback.model,
      ...credentialPatch,
    };
  });

  const { error: insertError } = await supabase.from("routing_rule_fallback" as never).insert(rows as never);
  if (insertError) throw normalizeSupabaseError("routing_rule_fallback insert", insertError);
}

export async function getRoutingRuleLocalEndpointUrl(input: {
  ruleId: string;
  workspaceId: string;
}): Promise<string | null> {
  const { data, error } = await getServiceRoleSupabase()
    .from("routing_rule_match")
    .select("value")
    .eq("rule_id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_endpoint")
    .eq("key", "url")
    .limit(1);
  if (error) throw normalizeSupabaseError("routing_rule_match query", error);

  const value = (data ?? [])[0]?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function ensureAgentCredentialReferenceRuleMatch(input: {
  ruleId: string;
  agentId: string;
  workspaceId: string;
}) {
  const { data, error } = await getServiceRoleSupabase()
    .from("routing_rule_match")
    .select("id")
    .eq("rule_id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "agent_id")
    .eq("key", "id")
    .eq("value", input.agentId)
    .limit(1);
  if (error) throw normalizeSupabaseError("routing_rule_match query", error);
  if (parseSupabaseRows("routing_rule_match query", RoutingRuleMatchIdSchema, data).length > 0) return;

  const { error: insertError } = await getServiceRoleSupabase().from("routing_rule_match").insert({
    rule_id: input.ruleId,
    workspace_id: input.workspaceId,
    kind: "agent_id",
    key: "id",
    value: input.agentId,
  });
  if (insertError) throw normalizeSupabaseError("routing_rule_match insert", insertError);
}

async function syncAgentLocalEndpointMatch(input: {
  ruleId: string;
  workspaceId: string;
  endpointUrl?: string | null;
}) {
  const supabase = getServiceRoleSupabase();
  const { error: deleteError } = await supabase
    .from("routing_rule_match")
    .delete()
    .eq("rule_id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_endpoint")
    .eq("key", "url");
  if (deleteError) throw normalizeSupabaseError("routing_rule_match delete", deleteError);

  if (!input.endpointUrl) return;

  const { error: insertError } = await supabase.from("routing_rule_match").insert({
    rule_id: input.ruleId,
    workspace_id: input.workspaceId,
    kind: "local_endpoint",
    key: "url",
    value: input.endpointUrl,
  });
  if (insertError) throw normalizeSupabaseError("routing_rule_match insert", insertError);
}

async function syncAgentLocalMachineMatch(input: { ruleId: string; workspaceId: string; machineId?: string | null }) {
  if (input.machineId === undefined) return;

  const supabase = getServiceRoleSupabase();
  const { error: deleteError } = await supabase
    .from("routing_rule_match")
    .delete()
    .eq("rule_id", input.ruleId)
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "local_machine")
    .eq("key", "id");
  if (deleteError) throw normalizeSupabaseError("routing_rule_match delete", deleteError);

  if (!input.machineId) return;

  const { error: insertError } = await supabase.from("routing_rule_match").insert({
    rule_id: input.ruleId,
    workspace_id: input.workspaceId,
    kind: "local_machine",
    key: "id",
    value: input.machineId,
  });
  if (insertError) throw normalizeSupabaseError("routing_rule_match insert", insertError);
}
