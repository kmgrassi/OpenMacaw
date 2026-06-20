import { useMutation, useQuery } from "@tanstack/react-query";

import { invalidateAgentData, queryClient } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import {
  createStoredAgent,
  deleteStoredAgent,
  listStoredAgents,
  updateStoredAgent,
  type AgentFormInput,
  type AgentUpdateInput,
} from "../api/stored-agents";
import {
  saveStoredCredential,
  type CredentialProvider,
} from "../api/credentials";
import type { Agent, AgentPatch } from "../types/agents";
import { useAgentsStore } from "../stores/agents";

export type { Agent };

export function mapStoredAgentToAgent(
  storedAgent: Awaited<ReturnType<typeof listStoredAgents>>[number],
): Agent {
  return {
    id: storedAgent.id,
    name: storedAgent.name || storedAgent.id,
    workspaceId: storedAgent.workspaceId ?? undefined,
    agentType: storedAgent.agentType,
    model: storedAgent.model,
    provider: storedAgent.provider ?? null,
    context: storedAgent.context ?? null,
    runnerKind: storedAgent.runnerKind ?? null,
    hasCredentials: storedAgent.hasCredentials ?? false,
    configurationStatus: storedAgent.configurationStatus ?? null,
    planningDestination: storedAgent.planningDestination,
    localModelCoding: storedAgent.localModelCoding ?? null,
    customTarget: storedAgent.customTarget
      ? {
          backendType: storedAgent.customTarget.backendType,
          baseUrl: storedAgent.customTarget.baseUrl,
          agentId: storedAgent.customTarget.agentId,
        }
      : null,
    identity: { name: storedAgent.name },
  };
}

export function useAgentsQuery(workspaceId?: string | null) {
  return useQuery({
    queryKey: queryKeys.agents.list(workspaceId),
    queryFn: async () => {
      const agents = (await listStoredAgents()).map(mapStoredAgentToAgent);
      return workspaceId
        ? agents.filter((agent) => agent.workspaceId === workspaceId)
        : agents;
    },
  });
}

function buildAgentUpdateInput(agent: Agent, patch: AgentPatch) {
  return {
    name: patch.name ?? agent.name,
    type: patch.type ?? agent.agentType,
    model: patch.model !== undefined ? patch.model : agent.model,
    context: patch.context !== undefined ? patch.context : agent.context,
    planningDestination:
      patch.planningDestination ?? agent.planningDestination ?? "database",
    localModelCoding:
      patch.localModelCoding === undefined
        ? agent.localModelCoding
          ? {
              enabled: agent.localModelCoding.enabled,
              approvalPolicy: agent.localModelCoding.approvalPolicy,
              workspaceWrite: agent.localModelCoding.workspaceWrite,
              localModelId: agent.localModelCoding.localModelId,
            }
          : undefined
        : patch.localModelCoding,
    customTarget:
      patch.customTarget ??
      (agent.customTarget
        ? {
            backendType: agent.customTarget.backendType ?? "openclaw_ws",
            baseUrl: agent.customTarget.baseUrl ?? "ws://127.0.0.1:7788",
            agentId: agent.customTarget.agentId ?? "",
          }
        : undefined),
  } satisfies AgentUpdateInput;
}

function findCachedAgent(agentId: string) {
  const matches = queryClient.getQueriesData<Agent[]>({
    queryKey: queryKeys.agents.lists(),
  });
  for (const [, agents] of matches) {
    if (!Array.isArray(agents)) continue;
    const agent = agents?.find((candidate) => candidate.id === agentId);
    if (agent) return agent;
  }
  return null;
}

function setCachedAgentLists(
  updater: (agents: Agent[] | undefined) => Agent[] | undefined,
) {
  queryClient.setQueriesData<Agent[]>(
    { queryKey: queryKeys.agents.lists() },
    (agents) => {
      if (!Array.isArray(agents)) return agents;
      return updater(agents);
    },
  );
}

export function useCreateAgentMutation() {
  const select = useAgentsStore((state) => state.select);
  return useMutation({
    mutationFn: (input: AgentFormInput) => createStoredAgent(input),
    onSuccess: async (agent) => {
      const mappedAgent = mapStoredAgentToAgent(agent);
      const appendCreated = (agents: Agent[] | undefined) => {
        if (!agents) return agents;
        if (agents.some((candidate) => candidate.id === mappedAgent.id)) {
          return agents;
        }
        return [mappedAgent, ...agents];
      };
      queryClient.setQueryData(queryKeys.agents.list(null), appendCreated);
      queryClient.setQueryData(
        queryKeys.agents.list(agent.workspaceId),
        appendCreated,
      );
      select(agent.id);
      await invalidateAgentData({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
      });
    },
  });
}

export function useUpdateAgentMutation() {
  return useMutation({
    mutationFn: async ({
      agentId,
      patch,
    }: {
      agentId: string;
      patch: AgentPatch;
    }) => {
      const current = findCachedAgent(agentId);
      if (!current) throw new Error("Agent was not found");
      await updateStoredAgent(agentId, buildAgentUpdateInput(current, patch));
    },
    onSuccess: async (_result, variables) => {
      const current = findCachedAgent(variables.agentId);
      await invalidateAgentData({
        agentId: variables.agentId,
        workspaceId: current?.workspaceId,
      });
    },
  });
}

export function useDeleteAgentMutation() {
  const selectedId = useAgentsStore((state) => state.selectedId);
  const select = useAgentsStore((state) => state.select);
  return useMutation({
    mutationFn: (agentId: string) => deleteStoredAgent(agentId),
    onSuccess: async (_result, agentId) => {
      setCachedAgentLists((agents) =>
        agents?.filter((agent) => agent.id !== agentId),
      );
      if (selectedId === agentId) select(null);
      await invalidateAgentData({ agentId });
    },
  });
}

export function useSaveAgentCredentialMutation() {
  return useMutation({
    mutationFn: async ({
      agentId,
      workspaceId,
      provider,
      apiKey,
    }: {
      agentId: string;
      workspaceId: string;
      provider: CredentialProvider;
      apiKey: string;
    }) => {
      await saveStoredCredential({
        scope: { kind: "agent", agentId, workspaceId },
        provider,
        apiKey,
      });
    },
    onSuccess: async (_result, variables) => {
      await invalidateAgentData({
        agentId: variables.agentId,
        workspaceId: variables.workspaceId,
      });
    },
  });
}
