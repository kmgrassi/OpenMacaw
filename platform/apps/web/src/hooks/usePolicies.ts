import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateSessionPolicyRequest,
  UpsertAgentPolicyRequest,
} from "../../../../contracts/policy";
import {
  createSessionPolicy,
  deleteAgentPolicy,
  deleteSessionPolicy,
  fetchAgentPolicies,
  fetchSessionPolicies,
  fetchSessionPolicyState,
  saveAgentPolicy,
} from "../api/policies";
import { queryKeys } from "../api/query-keys";

export function useAgentPoliciesQuery(
  agentId: string,
  workspaceId?: string | null,
) {
  return useQuery({
    queryKey: queryKeys.agents.policies(agentId, workspaceId),
    queryFn: () => fetchAgentPolicies(agentId, workspaceId),
    enabled: Boolean(agentId && workspaceId),
  });
}

export function useSaveAgentPolicyMutation(
  agentId: string,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      policyId: string;
      request: UpsertAgentPolicyRequest;
    }) => saveAgentPolicy(agentId, input.policyId, input.request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents.policies(agentId, workspaceId),
      });
    },
  });
}

export function useDeleteAgentPolicyMutation(
  agentId: string,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) =>
      deleteAgentPolicy(agentId, policyId, workspaceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents.policies(agentId, workspaceId),
      });
    },
  });
}

export function useSessionPoliciesQuery(
  sessionThreadId?: string | null,
  workspaceId?: string | null,
) {
  return useQuery({
    queryKey: queryKeys.sessions.policies(sessionThreadId ?? "", workspaceId),
    queryFn: () => fetchSessionPolicies(sessionThreadId ?? "", workspaceId),
    enabled: Boolean(sessionThreadId && workspaceId),
  });
}

export function useCreateSessionPolicyMutation(
  sessionThreadId?: string | null,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateSessionPolicyRequest) =>
      createSessionPolicy(sessionThreadId ?? "", request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.policies(
            sessionThreadId ?? "",
            workspaceId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.policyState(
            sessionThreadId ?? "",
            workspaceId,
          ),
        }),
      ]);
    },
  });
}

export function useDeleteSessionPolicyMutation(
  sessionThreadId?: string | null,
  workspaceId?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) =>
      deleteSessionPolicy(sessionThreadId ?? "", policyId, workspaceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.policies(
          sessionThreadId ?? "",
          workspaceId,
        ),
      });
    },
  });
}

export function useSessionPolicyStateQuery(
  sessionThreadId?: string | null,
  workspaceId?: string | null,
) {
  return useQuery({
    queryKey: queryKeys.sessions.policyState(
      sessionThreadId ?? "",
      workspaceId,
    ),
    queryFn: () => fetchSessionPolicyState(sessionThreadId ?? "", workspaceId),
    enabled: Boolean(sessionThreadId && workspaceId),
    refetchInterval: 5000,
  });
}
