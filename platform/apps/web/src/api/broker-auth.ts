import { StoredAgentAuthStateSchema } from "../../../../contracts/agents";
import { SetupAuthStateSchema } from "../../../../contracts/setup";
import type { SetupAuthState } from "../../../../contracts/setup";
import {
  deriveProviderFromModel,
  extractPrimaryModel,
} from "../../../../contracts/agent-helpers";
import {
  API_PATHS,
  asRecord,
  asStringList,
  resolveBrokerBase,
  safeParseJsonResponse,
} from "./broker";
import { listStoredAgents } from "./stored-agents";
import { getSupabaseAccessToken } from "./supabase";
import { isValidUuid } from "./ws-types";
import type { AgentId, AuthStateResponse } from "./ws-types";

function resolveSetupAgentId(auth: SetupAuthState): AgentId | null {
  if (auth.resolvedAgentId) {
    return auth.resolvedAgentId;
  }
  if (
    auth.defaultAgents.planning.configured &&
    auth.defaultAgents.planning.agentId
  ) {
    return auth.defaultAgents.planning.agentId;
  }
  if (
    auth.defaultAgents.coding.configured &&
    auth.defaultAgents.coding.agentId
  ) {
    return auth.defaultAgents.coding.agentId;
  }
  return (
    auth.defaultAgents.planning.agentId ??
    auth.defaultAgents.coding.agentId ??
    null
  );
}

function authAgentFromStoredAgent(
  agent: Awaited<ReturnType<typeof listStoredAgents>>[number],
) {
  return {
    id: agent.id,
    name: agent.name?.trim() || agent.id,
    model: agent.model,
    provider: agent.provider ?? null,
    workspaceId: agent.workspaceId,
    hasCredentials: agent.hasCredentials ?? false,
    isResolved: agent.isResolved ?? false,
  };
}

export async function fetchAuthState(): Promise<AuthStateResponse> {
  const base = resolveBrokerBase();
  let accessToken = "";
  try {
    accessToken = await getSupabaseAccessToken();
  } catch {
    accessToken = "";
  }

  const agentsResult = await safeParseJsonResponse<unknown>(
    `${base}${API_PATHS.authState}`,
    {
      method: "GET",
      credentials: "include",
      headers: accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : undefined,
    },
  );

  if (!agentsResult.ok) {
    try {
      const storedAgents = await listStoredAgents();
      const fallbackAgents = storedAgents.map(authAgentFromStoredAgent);
      const resolved =
        fallbackAgents.find((agent) => agent.isResolved) ||
        fallbackAgents[0] ||
        null;
      const reasons = new Set<string>(
        agentsResult.status === 404 || agentsResult.status === 0
          ? ["broker_unavailable"]
          : ["broker_error"],
      );
      const agentBody = asRecord(agentsResult.body);
      for (const reason of asStringList(agentBody?.reasons)) {
        reasons.add(reason);
      }
      if (storedAgents.length === 0) {
        reasons.add("missing_usable_agent");
      }

      return {
        readyToPrepare: false,
        reasons: Array.from(reasons),
        resolvedAgentId: resolved?.id ?? null,
        workspaceId: resolved?.workspaceId ?? null,
        agents: fallbackAgents,
      };
    } catch {
      const reasons = new Set<string>(
        agentsResult.status === 404 || agentsResult.status === 0
          ? ["broker_unavailable"]
          : ["broker_error"],
      );
      const agentBody = asRecord(agentsResult.body);
      for (const reason of asStringList(agentBody?.reasons)) {
        reasons.add(reason);
      }

      return {
        readyToPrepare: false,
        reasons: Array.from(reasons),
        resolvedAgentId: null,
        workspaceId: null,
        agents: [],
      };
    }
  }

  try {
    const parsed = SetupAuthStateSchema.parse(agentsResult.body);
    const resolvedAgentId = resolveSetupAgentId(parsed);
    const agents = parsed.agents.map(
      (agent: (typeof parsed.agents)[number], index: number) => {
        const model = extractPrimaryModel(agent.modelSettings);
        return {
          id: agent.id,
          name: agent.name?.trim() || agent.id,
          model,
          provider: deriveProviderFromModel(model),
          hasCredentials: true,
          isResolved:
            agent.id === resolvedAgentId || (!resolvedAgentId && index === 0),
        };
      },
    );
    return {
      readyToPrepare: Boolean(resolvedAgentId && parsed.workspaceId),
      reasons: resolvedAgentId
        ? parsed.onboarding.reasons
        : ["missing_usable_agent"],
      resolvedAgentId,
      workspaceId: parsed.workspaceId,
      agents,
    };
  } catch {
    const parsed = StoredAgentAuthStateSchema.parse(agentsResult.body);
    const agents = parsed.agents.map(authAgentFromStoredAgent);
    const reasons = new Set<string>(parsed.reasons);

    if (!agents.length) {
      reasons.add("missing_usable_agent");
    }
    const resolved =
      agents.find((agent: (typeof agents)[number]) =>
        Boolean(agent.isResolved),
      ) ||
      agents[0] ||
      null;

    const workspaceId = parsed.workspaceId || null;
    const resolvedAgentId =
      resolved?.id && isValidUuid(resolved.id) ? resolved.id : null;

    return {
      readyToPrepare: Boolean(resolvedAgentId && workspaceId),
      reasons: Array.from(reasons),
      resolvedAgentId,
      workspaceId,
      agents,
    };
  }
}
