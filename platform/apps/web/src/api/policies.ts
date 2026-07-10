import {
  AgentPolicySettingsResponseSchema,
  PolicyMutationResponseSchema,
  SessionPoliciesResponseSchema,
  SessionPolicyStateResponseSchema,
  type AgentPolicySettingsResponse,
  type CreateSessionPolicyRequest,
  type Policy,
  type SessionPoliciesResponse,
  type SessionPolicyStateResponse,
  type UpsertAgentPolicyRequest,
} from "../../../../contracts/policy";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function fetchAgentPolicies(
  agentId: string,
  workspaceId?: string | null,
): Promise<AgentPolicySettingsResponse> {
  return apiFetch(ROUTES.agentPolicies(agentId, workspaceId), {
    schema: AgentPolicySettingsResponseSchema,
    defaultErrorMessage: "Could not load agent policies",
  });
}

export async function saveAgentPolicy(
  agentId: string,
  policyId: string,
  input: UpsertAgentPolicyRequest,
): Promise<Policy> {
  const response = await apiFetch(ROUTES.agentPolicy(agentId, policyId), {
    method: "PUT",
    body: input,
    schema: PolicyMutationResponseSchema,
    defaultErrorMessage: "Could not save policy",
  });
  return response.policy;
}

export async function deleteAgentPolicy(
  agentId: string,
  policyId: string,
  workspaceId?: string | null,
): Promise<void> {
  await apiFetch(ROUTES.agentPolicy(agentId, policyId, workspaceId), {
    method: "DELETE",
    defaultErrorMessage: "Could not delete policy",
  });
}

export async function fetchSessionPolicies(
  sessionThreadId: string,
  workspaceId?: string | null,
): Promise<SessionPoliciesResponse> {
  return apiFetch(ROUTES.sessionPolicies(sessionThreadId, workspaceId), {
    schema: SessionPoliciesResponseSchema,
    defaultErrorMessage: "Could not load session policies",
  });
}

export async function createSessionPolicy(
  sessionThreadId: string,
  input: CreateSessionPolicyRequest,
): Promise<Policy> {
  const response = await apiFetch(ROUTES.sessionPolicies(sessionThreadId), {
    method: "POST",
    body: input,
    schema: PolicyMutationResponseSchema,
    defaultErrorMessage: "Could not create session policy",
  });
  return response.policy;
}

export async function saveSessionPolicy(
  sessionThreadId: string,
  policyId: string,
  input: CreateSessionPolicyRequest,
): Promise<Policy> {
  const response = await apiFetch(
    ROUTES.sessionPolicy(sessionThreadId, policyId),
    {
      method: "PUT",
      body: input,
      schema: PolicyMutationResponseSchema,
      defaultErrorMessage: "Could not save session policy",
    },
  );
  return response.policy;
}

export async function deleteSessionPolicy(
  sessionThreadId: string,
  policyId: string,
  workspaceId?: string | null,
): Promise<void> {
  await apiFetch(ROUTES.sessionPolicy(sessionThreadId, policyId, workspaceId), {
    method: "DELETE",
    defaultErrorMessage: "Could not delete session policy",
  });
}

export async function fetchSessionPolicyState(
  sessionThreadId: string,
  workspaceId?: string | null,
): Promise<SessionPolicyStateResponse> {
  return apiFetch(ROUTES.sessionPolicyState(sessionThreadId, workspaceId), {
    schema: SessionPolicyStateResponseSchema,
    defaultErrorMessage: "Could not load policy state",
  });
}
