import { ApiRouteError } from "../../../http.js";
import type { AgentRow } from "../types.js";

export function pickClaimableAgent(agents: AgentRow[]): AgentRow | null {
  return agents.find((agent) => agent.status === "active") ?? agents[0] ?? null;
}

export function requireAgentRow(rows: AgentRow[] | null | undefined, errorCode: string, message: string): AgentRow {
  const agent = rows?.[0];
  if (!agent) throw new ApiRouteError(502, errorCode, message);
  return agent;
}
