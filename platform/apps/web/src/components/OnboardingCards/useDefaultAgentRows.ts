import { useMemo } from "react";

import { useAuthStore } from "../../stores/auth";

export type DefaultAgentKey = "planning" | "coding" | "manager";

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
];

export function useDefaultAgentRows(): DefaultAgentRow[] {
  const { defaultAgents, managerAgent } = useAuthStore();
  return useMemo(
    () =>
      DEFAULT_AGENT_DESCRIPTIONS.map((agent) => ({
        ...agent,
        agentId:
          agent.key === "manager"
            ? managerAgent.agentId
            : defaultAgents[agent.key].agentId,
      })),
    [defaultAgents, managerAgent.agentId],
  );
}
