import { useMemo } from "react";

import { useAuthStore } from "../../stores/auth";

export type DefaultAgentKey = "planning" | "coding" | "manager" | "learning" | "router";

export type DefaultAgentRow = {
  role: string;
  key: DefaultAgentKey;
  description: string;
  agentId: string | null;
};

export const DEFAULT_AGENT_DESCRIPTIONS: Array<
  Omit<DefaultAgentRow, "agentId">
> = [
  {
    role: "Planning agent",
    key: "planning",
    description:
      "This is the planning agent that helps you plan things.",
  },
  {
    role: "Coding agent",
    key: "coding",
    description: "This is the coding agent that helps with coding tasks.",
  },
  {
    role: "Manager agent",
    key: "manager",
    description:
      "This is the manager agent that helps keep track of stuff.",
  },
  {
    role: "Learning agent",
    key: "learning",
    description:
      "Reviews recent runs and suggests durable memory or operating improvements.",
  },
  {
    role: "Router agent",
    key: "router",
    description:
      "Reviews routing performance and keeps model routing rules current.",
  },
];

export function useDefaultAgentRows(): DefaultAgentRow[] {
  const { defaultAgents, existingAgents, managerAgent } = useAuthStore();
  return useMemo(
    () =>
      DEFAULT_AGENT_DESCRIPTIONS.map((agent) => ({
        ...agent,
        agentId:
          agent.key === "manager"
            ? managerAgent.agentId
            : agent.key === "learning" || agent.key === "router"
              ? (existingAgents.find((row) => row.type === agent.key)?.id ?? null)
              : defaultAgents[agent.key].agentId,
      })),
    [defaultAgents, existingAgents, managerAgent.agentId],
  );
}
