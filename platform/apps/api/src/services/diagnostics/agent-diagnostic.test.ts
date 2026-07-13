import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveExecutionProfile } from "../execution-profile-resolver.js";
import { getServiceRoleSupabase } from "../../supabase-client.js";
import { createMockSupabaseClient } from "../../test-utils/supabase-client-mock.js";
import { loadAgentDiagnostic } from "./agent-diagnostic.js";
import { probeOllamaEndpoint } from "./ollama.js";

vi.mock("../../supabase-client.js", async () => {
  const actual = await vi.importActual("../../supabase-client.js");
  return {
    ...actual,
    getServiceRoleSupabase: vi.fn(),
  };
});

vi.mock("../execution-profile-resolver.js", () => ({
  isRoutingMetadataMatch: vi.fn(() => false),
  matchValue: vi.fn(() => false),
  resolveExecutionProfile: vi.fn(async () => ({
    missing: [],
    profile: {
      runnerKind: "local_relay",
      provider: "openai_compatible",
      model: "qwen3-coder:30b",
      credentialRef: null,
      toolProfile: null,
    },
    source: {
      routingRuleId: null,
      fallbackUsed: false,
      legacyGatewayConfigUsed: false,
    },
  })),
}));

vi.mock("./ollama.js", () => ({
  probeOllamaEndpoint: vi.fn(),
}));

vi.mock("./work-item-snooze.js", () => ({
  loadWorkItemSnoozeDiagnostic: vi.fn(async () => ({ found: false, snoozed: false })),
}));

vi.mock("../saved-credentials.js", () => ({
  listSavedCredentialsForAgentFromSupabase: vi.fn(async () => []),
}));

const fetchMock = vi.fn(async () => {
  throw new Error("launcher unavailable");
});

describe("loadAgentDiagnostic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads the local runtime machine with generated table fields and probes the derived endpoint", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        agent: [
          {
            id: "agent-1",
            workspace_id: "workspace-1",
            name: "Coding Agent",
            type: "coding",
            model_settings: null,
          },
        ],
        routing_rule: [],
        routing_rule_match: [],
        local_runtime_machine: [
          {
            id: "machine-revoked",
            workspace_id: "workspace-1",
            display_name: "old@127.0.0.1:11434",
            revoked_at: "2026-05-01T00:00:00.000Z",
          },
          {
            id: "machine-active",
            workspace_id: "workspace-1",
            display_name: "qwen@127.0.0.1:11434",
            revoked_at: null,
          },
        ],
      }) as never,
    );
    vi.mocked(probeOllamaEndpoint).mockResolvedValue({
      reachable: true,
      models: ["qwen3-coder:30b"],
    });

    const diagnostic = await loadAgentDiagnostic({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      workItemId: null,
    });

    expect(diagnostic.localRuntime).toEqual({
      isLocal: true,
      machineFound: true,
      machineId: "machine-active",
      machineDisplayName: "qwen@127.0.0.1:11434",
      endpoint: "http://127.0.0.1:11434",
      endpointReachable: true,
      ollamaModels: ["qwen3-coder:30b"],
      relayHelper: {
        registered: true,
        machineId: "machine-active",
        displayName: "qwen@127.0.0.1:11434",
      },
      modelEndpoint: {
        url: "http://127.0.0.1:11434",
        reachable: true,
        ollamaModels: ["qwen3-coder:30b"],
      },
    });
    expect(probeOllamaEndpoint).toHaveBeenCalledWith("http://127.0.0.1:11434");
  });

  it("does not disclose an agent from another workspace when a workspaceId is provided", async () => {
    vi.mocked(getServiceRoleSupabase).mockReturnValue(
      createMockSupabaseClient({
        agent: [
          {
            id: "agent-1",
            workspace_id: "workspace-2",
            name: "Secret Agent",
            type: "coding",
            model_settings: { model: "secret-model" },
          },
        ],
        routing_rule: [],
        routing_rule_match: [],
        local_runtime_machine: [],
      }) as never,
    );

    const diagnostic = await loadAgentDiagnostic({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      workItemId: null,
    });

    expect(diagnostic.agent).toEqual({
      found: false,
      name: null,
      type: null,
      model_settings: null,
    });
    expect(diagnostic.workspaceId).toBe("workspace-1");
    expect(diagnostic.canChat).toBe(false);
    expect(diagnostic.executionProfile).toEqual({
      resolved: false,
      missing: ["agent_not_found"],
      profile: null,
      source: {
        routingRuleId: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    });
    expect(diagnostic.launcher).toEqual({
      healthy: false,
      agentRegistered: false,
    });
    expect(diagnostic.blockers).toEqual(["Agent not found in authorized workspace"]);
    expect(resolveExecutionProfile).not.toHaveBeenCalled();
    expect(probeOllamaEndpoint).not.toHaveBeenCalled();
  });
});
