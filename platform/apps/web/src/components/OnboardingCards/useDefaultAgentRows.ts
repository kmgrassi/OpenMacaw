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
      "This is the agent you talk to. It plans work and hands coding tasks off to your coding agent.",
  },
  {
    role: "Coding agent",
    key: "coding",
    description:
      "Works in the background. The planning agent sends it coding tasks; you rarely need to message it directly.",
  },
  {
    role: "Manager agent",
    key: "manager",
    description:
      "Works in the background to coordinate work across your agents.",
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
