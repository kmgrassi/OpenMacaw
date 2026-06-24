import { describe, expect, it } from "vitest";

import type { AgentHealthResponse } from "../../../../../contracts/agent-health";
import type { Agent } from "../../hooks/useAgents";
import {
  summarizeWorkspaceAgentHealth,
  workspaceAgents,
} from "./workspace-agent-health";

function agent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    id: input.id,
    name: input.name ?? input.id,
    workspaceId: input.workspaceId,
    agentType: input.agentType ?? "coding",
    model: input.model ?? null,
    provider: input.provider ?? null,
    context: input.context ?? null,
    runnerKind: input.runnerKind ?? null,
    hasCredentials: input.hasCredentials ?? false,
    configurationStatus: input.configurationStatus ?? null,
    planningDestination: input.planningDestination ?? null,
    localModelCoding: input.localModelCoding ?? null,
    customTarget: input.customTarget ?? null,
    identity: input.identity ?? { name: input.name },
  };
}

function health(
  status: AgentHealthResponse["status"],
  message?: string,
): AgentHealthResponse {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    checkedAt: "2026-05-22T12:00:00.000Z",
    status,
    config: {
      configured: true,
      missing: [],
      gatewaySyncStatus: null,
      gatewayApplyStatus: null,
      lastError: null,
    },
    launcher: {
      reachable: true,
      status: "reachable",
      service: null,
      lastError: null,
    },
    database: {
      configured: true,
      started: true,
      connected: true,
      status: "connected",
      source: null,
      lastError: null,
    },
    runtime: {
      state: "running",
      engineStatus: "running",
      instanceId: "engine-1",
      lastHeartbeatAt: "2026-05-22T12:00:00.000Z",
      startedAt: "2026-05-22T11:55:00.000Z",
      lastError: null,
    },
    lastFailure: message
      ? {
          sourceLayer: "runtime",
          code: "runtime_unhealthy",
          message,
          occurredAt: "2026-05-22T12:00:00.000Z",
          retryable: true,
        }
      : null,
  };
}

describe("workspace agent health helpers", () => {
  it("filters and deduplicates agents for the active workspace", () => {
    expect(
      workspaceAgents(
        [
          agent({ id: "agent-1", workspaceId: "workspace-1" }),
          agent({ id: "agent-1", workspaceId: "workspace-1" }),
          agent({ id: "agent-2", workspaceId: "workspace-2" }),
          agent({ id: "agent-3" }),
        ],
        "workspace-1",
      ).map((candidate) => candidate.id),
    ).toEqual(["agent-1"]);
  });

  it("counts degraded, unhealthy, and failed probes as needing attention", () => {
    const summary = summarizeWorkspaceAgentHealth([
      {
        agentId: "agent-1",
        agentName: "Healthy agent",
        health: health("healthy"),
        error: null,
      },
      {
        agentId: "agent-2",
        agentName: "Degraded agent",
        health: health("degraded", "Runtime heartbeat is stale."),
        error: null,
      },
      {
        agentId: "agent-3",
        agentName: "Probe failed agent",
        health: null,
        error: new Error("Diagnostic endpoint failed"),
      },
    ]);

    expect(summary.checkedCount).toBe(3);
    expect(summary.issueCount).toBe(2);
    expect(summary.firstIssue).toMatchObject({
      agentId: "agent-2",
      message: "Runtime heartbeat is stale.",
    });
  });
});
