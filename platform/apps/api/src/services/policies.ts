import type { Json } from "@kmgrassi/supabase-schema";
import {
  POLICY_KIND_DEFINITIONS,
  PolicyRowSchema,
  PolicySessionStateRowSchema,
  type AgentPoliciesResponse,
  type CreateSessionPolicyRequest,
  type Policy,
  type PolicyRow,
  type PolicySessionState,
  type UpsertAgentPolicyRequest,
} from "../../../../contracts/policy.js";
import { ApiRouteError } from "../http.js";
import { normalizeSupabaseError } from "../supabase-client.js";
import { getServiceRoleSupabase } from "../supabase-client.js";
import { assertAgentAccess, assertWorkspaceAccess } from "./agent-tools/access.js";

type PolicyTableRow = PolicyRow;

function db() {
  return getServiceRoleSupabase();
}

function policyTable() {
  return db().from("policy" as never);
}

function policySessionStateTable() {
  return db().from("policy_session_state" as never);
}

function mapPolicy(row: unknown): Policy {
  const parsed = PolicyRowSchema.parse(row);
  return {
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    scope: parsed.scope,
    agentId: parsed.agent_id,
    sessionThreadId: parsed.session_thread_id,
    kind: parsed.kind,
    params: parsed.params,
    priority: parsed.priority,
    enabled: parsed.enabled,
    source: parsed.source,
    reason: parsed.reason,
    createdByUserId: parsed.created_by_user_id,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at ?? null,
  };
}

function mapPolicyState(row: unknown): PolicySessionState {
  const parsed = PolicySessionStateRowSchema.parse(row);
  return {
    workspaceId: parsed.workspace_id,
    sessionThreadId: parsed.session_thread_id,
    key: parsed.key,
    valueNumeric: parsed.value_numeric,
    valueJson: parsed.value_json,
    updatedAt: parsed.updated_at,
  };
}

function sortPolicies(policies: Policy[]) {
  return [...policies].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.scope.localeCompare(right.scope) ||
      left.kind.localeCompare(right.kind) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function loadAgentAndWorkspacePolicies(input: { workspaceId: string; agentId: string }) {
  const { data, error } = await policyTable()
    .select(
      "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at,updated_at",
    )
    .eq("workspace_id", input.workspaceId)
    .in("scope", ["workspace", "agent"])
    .or(`scope.eq.workspace,and(scope.eq.agent,agent_id.eq.${input.agentId})`)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw normalizeSupabaseError("policy query", error);
  return sortPolicies((data ?? []).map(mapPolicy));
}

export async function getAgentPolicies(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<AgentPoliciesResponse> {
  const { workspaceId } = await assertAgentAccess(input);
  const policies = await loadAgentAndWorkspacePolicies({ workspaceId, agentId: input.agentId });
  return {
    policies,
    effectivePolicies: sortPolicies(policies.filter((policy) => policy.enabled)),
    availableKinds: [...POLICY_KIND_DEFINITIONS],
  };
}

export async function upsertAgentPolicy(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  policyId: string;
  request: UpsertAgentPolicyRequest;
}) {
  const { workspaceId } = await assertAgentAccess({
    accessToken: input.accessToken,
    userId: input.userId,
    agentId: input.agentId,
    workspaceId: input.request.workspaceId,
  });

  const { data: existing, error: existingError } = await policyTable()
    .select("id,scope,agent_id,workspace_id")
    .eq("id", input.policyId)
    .maybeSingle<Pick<PolicyTableRow, "id" | "scope" | "agent_id" | "workspace_id">>();

  if (existingError) throw normalizeSupabaseError("policy lookup", existingError);
  if (
    existing &&
    (existing.workspace_id !== workspaceId || existing.scope !== "agent" || existing.agent_id !== input.agentId)
  ) {
    throw new ApiRouteError(409, "policy_scope_mismatch", "Only agent-scoped policies can be edited here");
  }

  const payload = {
    id: input.policyId,
    workspace_id: workspaceId,
    scope: "agent",
    agent_id: input.agentId,
    session_thread_id: null,
    kind: input.request.kind,
    params: input.request.params as Json,
    priority: input.request.priority,
    enabled: input.request.enabled,
    source: "manual",
    reason: input.request.reason ?? null,
    created_by_user_id: input.userId,
  };

  const { data, error } = await policyTable()
    .upsert(payload as never, { onConflict: "id" })
    .select(
      "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at,updated_at",
    )
    .single<PolicyTableRow>();

  if (error) throw normalizeSupabaseError("policy upsert", error);
  if (!data) throw new ApiRouteError(502, "policy_upsert_failed", "Could not save policy");
  return mapPolicy(data);
}

export async function deleteAgentPolicy(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  policyId: string;
  workspaceId?: string | null;
}) {
  const { workspaceId } = await assertAgentAccess(input);
  const { error } = await policyTable()
    .delete()
    .eq("id", input.policyId)
    .eq("workspace_id", workspaceId)
    .eq("scope", "agent")
    .eq("agent_id", input.agentId);

  if (error) throw normalizeSupabaseError("policy delete", error);
}

async function assertSessionAccess(input: { userId: string; workspaceId: string; sessionThreadId: string }) {
  await assertWorkspaceAccess(input.userId, input.workspaceId);

  let query = db()
    .from("session_thread" as never)
    .select("id,workspace_id,session_key")
    .eq("workspace_id", input.workspaceId);

  query = isUuid(input.sessionThreadId)
    ? query.eq("id", input.sessionThreadId)
    : query.eq("session_key", input.sessionThreadId);

  const { data, error } = await query.maybeSingle<{ id: string; workspace_id: string }>();

  if (error) throw normalizeSupabaseError("session_thread query", error);
  if (!data) throw new ApiRouteError(404, "session_not_found", "Session was not found");
  return data.id;
}

export async function getSessionPolicies(input: { userId: string; workspaceId: string; sessionThreadId: string }) {
  const sessionThreadId = await assertSessionAccess(input);
  const { data, error } = await policyTable()
    .select(
      "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at,updated_at",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("scope", "session")
    .eq("session_thread_id", sessionThreadId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw normalizeSupabaseError("policy query", error);
  return {
    policies: sortPolicies((data ?? []).map(mapPolicy)),
    availableKinds: [...POLICY_KIND_DEFINITIONS],
  };
}

export async function createSessionPolicy(input: {
  userId: string;
  sessionThreadId: string;
  request: CreateSessionPolicyRequest;
}) {
  const sessionThreadId = await assertSessionAccess({
    userId: input.userId,
    workspaceId: input.request.workspaceId,
    sessionThreadId: input.sessionThreadId,
  });

  const { data, error } = await policyTable()
    .insert({
      workspace_id: input.request.workspaceId,
      scope: "session",
      agent_id: null,
      session_thread_id: sessionThreadId,
      kind: input.request.kind,
      params: input.request.params as Json,
      priority: input.request.priority,
      enabled: input.request.enabled,
      source: "manual",
      reason: input.request.reason ?? null,
      created_by_user_id: input.userId,
    } as never)
    .select(
      "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at,updated_at",
    )
    .single<PolicyTableRow>();

  if (error) throw normalizeSupabaseError("policy insert", error);
  if (!data) throw new ApiRouteError(502, "policy_insert_failed", "Could not create policy");
  return mapPolicy(data);
}

export async function updateSessionPolicy(input: {
  userId: string;
  sessionThreadId: string;
  policyId: string;
  request: CreateSessionPolicyRequest;
}) {
  const sessionThreadId = await assertSessionAccess({
    userId: input.userId,
    workspaceId: input.request.workspaceId,
    sessionThreadId: input.sessionThreadId,
  });

  const payload = {
    workspace_id: input.request.workspaceId,
    scope: "session",
    agent_id: null,
    session_thread_id: sessionThreadId,
    kind: input.request.kind,
    params: input.request.params as Json,
    priority: input.request.priority,
    enabled: input.request.enabled,
    source: "manual",
    reason: input.request.reason ?? null,
    created_by_user_id: input.userId,
  };

  const { data, error } = await policyTable()
    .update(payload as never)
    .eq("id", input.policyId)
    .eq("workspace_id", input.request.workspaceId)
    .eq("scope", "session")
    .eq("session_thread_id", sessionThreadId)
    .select(
      "id,workspace_id,scope,agent_id,session_thread_id,kind,params,priority,enabled,source,reason,created_by_user_id,created_at,updated_at",
    )
    .maybeSingle<PolicyTableRow>();

  if (error) throw normalizeSupabaseError("policy update", error);
  if (!data) throw new ApiRouteError(404, "policy_not_found", "Session policy was not found");
  return mapPolicy(data);
}

export async function deleteSessionPolicy(input: {
  userId: string;
  workspaceId: string;
  sessionThreadId: string;
  policyId: string;
}) {
  const sessionThreadId = await assertSessionAccess(input);
  const { error } = await policyTable()
    .delete()
    .eq("id", input.policyId)
    .eq("workspace_id", input.workspaceId)
    .eq("scope", "session")
    .eq("session_thread_id", sessionThreadId);

  if (error) throw normalizeSupabaseError("policy delete", error);
}

export async function getSessionPolicyState(input: { userId: string; workspaceId: string; sessionThreadId: string }) {
  const sessionThreadId = await assertSessionAccess(input);
  const { data, error } = await policySessionStateTable()
    .select("workspace_id,session_thread_id,key,value_numeric,value_json,updated_at")
    .eq("workspace_id", input.workspaceId)
    .eq("session_thread_id", sessionThreadId)
    .order("key", { ascending: true });

  if (error) throw normalizeSupabaseError("policy_session_state query", error);
  return (data ?? []).map(mapPolicyState);
}
