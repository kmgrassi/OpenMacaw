import {
  POLICY_KINDS,
  PolicyRowSchema,
  RuntimePolicySchema,
  type AgentPolicySettingsResponse,
  type Policy,
  type PolicyKind,
  type PolicyKindMetadata,
  type PolicyRow,
  type RuntimePolicy,
  type PolicyScope,
} from "../../../../contracts/policy.js";
import { narrowSupabase } from "../lib/narrow-supabase.js";
import { normalizeSupabaseError, type ApiSupabaseClient } from "../supabase-client.js";

const POLICY_SELECT =
  "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at" as const;

const TIER_ORDER: Record<PolicyScope, number> = {
  session: 0,
  agent: 1,
  workspace: 2,
};

const PARAMS_SCHEMAS: Record<PolicyKind, Record<string, unknown>> = {
  max_tool_calls_per_session: {
    type: "object",
    required: ["kind", "limit"],
    properties: {
      kind: { const: "max_tool_calls_per_session" },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  cost_budget: {
    type: "object",
    required: ["kind", "max_cost_usd"],
    properties: {
      kind: { const: "cost_budget" },
      max_cost_usd: { type: "number", exclusiveMinimum: 0 },
      ask_thresholds_usd: {
        type: "array",
        items: { type: "number", exclusiveMinimum: 0 },
      },
    },
    additionalProperties: false,
  },
  ask_on_shell: {
    type: "object",
    required: ["kind"],
    properties: { kind: { const: "ask_on_shell" } },
    additionalProperties: false,
  },
  ask_on_tool: {
    type: "object",
    required: ["kind", "tools"],
    properties: {
      kind: { const: "ask_on_tool" },
      tools: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    additionalProperties: false,
  },
  block_tools: {
    type: "object",
    required: ["kind", "tools"],
    properties: {
      kind: { const: "block_tools" },
      tools: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    additionalProperties: false,
  },
  risk_score: {
    type: "object",
    required: ["kind", "guarded_tools", "threshold"],
    properties: {
      kind: { const: "risk_score" },
      guarded_tools: { type: "array", items: { type: "string" }, minItems: 1 },
      threshold: { type: "number", exclusiveMinimum: 0 },
      weights: {
        type: "object",
        additionalProperties: { type: "number", exclusiveMinimum: 0 },
      },
    },
    additionalProperties: false,
  },
};

export function listPolicyKindMetadata(): PolicyKindMetadata[] {
  return POLICY_KINDS.map((kind) => ({
    kind,
    paramsSchema: PARAMS_SCHEMAS[kind],
  }));
}

function rowsFromResult<Row>(data: Row[] | Row | null): Row[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    agentId: row.agent_id,
    sessionThreadId: row.session_thread_id,
    kind: row.kind,
    params: row.params,
    priority: row.priority,
    enabled: row.enabled,
    source: row.source,
    reason: row.reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

function toRuntimePolicy(policy: Policy): RuntimePolicy {
  return RuntimePolicySchema.parse({
    id: policy.id,
    workspaceId: policy.workspaceId,
    scope: policy.scope,
    agentId: policy.agentId,
    sessionThreadId: policy.sessionThreadId,
    kind: policy.kind,
    params: policy.params,
    priority: policy.priority,
    source: policy.source,
    reason: policy.reason,
  });
}

function sortPolicies(policies: Policy[]) {
  return [...policies].sort(
    (left, right) =>
      TIER_ORDER[left.scope] - TIER_ORDER[right.scope] ||
      left.priority - right.priority ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

async function listPolicyRows(input: {
  workspaceId: string;
  agentId: string;
  sessionThreadId?: string | null;
  supabase: ApiSupabaseClient;
  enabledOnly: boolean;
}) {
  const supabase = narrowSupabase(input.supabase);
  const workspacePolicies = supabase
    .from<PolicyRow>("policy")
    .select(POLICY_SELECT)
    .eq("workspace_id", input.workspaceId)
    .eq("scope", "workspace");
  if (input.enabledOnly) workspacePolicies.eq("enabled", true);
  const agentPolicies = supabase
    .from<PolicyRow>("policy")
    .select(POLICY_SELECT)
    .eq("workspace_id", input.workspaceId)
    .eq("scope", "agent")
    .eq("agent_id", input.agentId);
  if (input.enabledOnly) agentPolicies.eq("enabled", true);
  const sessionPolicies = input.sessionThreadId
    ? (() => {
        const query = supabase
          .from<PolicyRow>("policy")
          .select(POLICY_SELECT)
          .eq("workspace_id", input.workspaceId)
          .eq("scope", "session")
          .eq("session_thread_id", input.sessionThreadId);
        if (input.enabledOnly) query.eq("enabled", true);
        return query;
      })()
    : Promise.resolve({ data: [], error: null });

  const results = await Promise.all([workspacePolicies, agentPolicies, sessionPolicies]);
  const errorResult = results.find((result) => result.error);
  if (errorResult?.error) throw normalizeSupabaseError("policy query", errorResult.error);
  return results.flatMap((result) => rowsFromResult(result.data)).map((row) => PolicyRowSchema.parse(row));
}

function resolvePolicyRows(rows: PolicyRow[]) {
  const policies = rows.map(toPolicy);
  const workspacePolicies = sortPolicies(policies.filter((policy) => policy.scope === "workspace"));
  const agentPolicies = sortPolicies(policies.filter((policy) => policy.scope === "agent"));
  const sessionPolicies = sortPolicies(policies.filter((policy) => policy.scope === "session"));
  const effectivePolicies = sortPolicies(
    [...sessionPolicies, ...agentPolicies, ...workspacePolicies].filter((policy) => policy.enabled),
  ).map(toRuntimePolicy);

  return {
    workspacePolicies,
    agentPolicies,
    sessionPolicies,
    effectivePolicies,
  };
}

export async function resolveSessionPolicies(input: {
  agentId: string;
  workspaceId: string;
  sessionThreadId?: string | null;
  supabase: ApiSupabaseClient;
}): Promise<{
  workspacePolicies: Policy[];
  agentPolicies: Policy[];
  sessionPolicies: Policy[];
  effectivePolicies: RuntimePolicy[];
}> {
  const rows = await listPolicyRows({ ...input, enabledOnly: true });
  return resolvePolicyRows(rows);
}

export async function getAgentPolicySettings(input: {
  agentId: string;
  workspaceId: string;
  sessionThreadId?: string | null;
  supabase: ApiSupabaseClient;
}): Promise<AgentPolicySettingsResponse> {
  const rows = await listPolicyRows({ ...input, enabledOnly: false });
  const resolution = resolvePolicyRows(rows);
  return {
    availableKinds: listPolicyKindMetadata(),
    ...resolution,
  };
}
