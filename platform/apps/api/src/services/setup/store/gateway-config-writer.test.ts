import { beforeEach, describe, expect, it, vi } from "vitest";

import { getUserScopedSupabase } from "../../../supabase-client.js";
import { resolveExecutionProfile } from "../../execution-profile-resolver.js";
import { getGatewayConfig } from "./readers.js";
import { writeGatewayConfigForDefaultAgent, writeGatewayConfigForManagerAgent } from "./gateway-config-writer.js";

vi.mock("../../../supabase-client.js", () => ({
  getUserScopedSupabase: vi.fn(),
  normalizeSupabaseError: (_context: string, error: Error) => error,
}));

vi.mock("../../execution-profile-resolver.js", () => ({
  resolveExecutionProfile: vi.fn(),
}));

vi.mock("./readers.js", () => ({
  getGatewayConfig: vi.fn(),
}));

const agent = {
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Agent",
  status: "active",
  type: "coding",
  context: null,
  model_settings: { primary: "openai/gpt-5.2" },
  tool_policy: {},
  created_by_user_id: "user-1",
  updated_at: "2026-06-10T00:00:00.000Z",
};

const existingGatewayConfig = {
  id: "gateway-config-1",
  scope_type: "agent",
  scope_id: "agent-1",
  version: 1,
  config_hash: "old-hash",
  config_json: {
    runners: [{ kind: "codex", provider: "openai", model: "openai/gpt-5.1" }],
  },
  updated_at: "2026-06-10T00:00:00.000Z",
  updated_by: "user-1",
};

function duplicateInsertError() {
  return {
    code: "23505",
    message: "duplicate key value violates unique constraint",
    details: null,
    hint: null,
    name: "PostgrestError",
  };
}

function mockSupabaseForCreateRace() {
  const insertGatewayConfig = vi.fn(() => ({
    select: vi.fn(async () => ({ data: [], error: duplicateInsertError() })),
  }));
  const updateGatewayConfig = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(async () => ({
        data: [{ ...existingGatewayConfig, version: 2, config_hash: "new-hash" }],
        error: null,
      })),
    })),
  }));
  const insertVersion = vi.fn(async () => ({ error: null }));

  vi.mocked(getUserScopedSupabase).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "gateway_config") {
        return {
          insert: insertGatewayConfig,
          update: updateGatewayConfig,
        };
      }
      if (table === "gateway_config_versions") {
        return {
          insert: insertVersion,
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  } as never);

  return { insertGatewayConfig, updateGatewayConfig, insertVersion };
}

describe("gateway config writer create races", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveExecutionProfile).mockResolvedValue({
      agent: { agentId: "agent-1", workspaceId: "workspace-1", role: "coding" },
      profile: null,
      missing: [],
      source: {
        routingRuleId: null,
        credentialAlias: null,
        fallbackUsed: false,
        legacyGatewayConfigUsed: false,
      },
    });
  });

  it("retries default-agent writes through the update path after a duplicate insert race", async () => {
    const supabase = mockSupabaseForCreateRace();
    vi.mocked(getGatewayConfig).mockResolvedValueOnce(null).mockResolvedValueOnce(existingGatewayConfig);

    await writeGatewayConfigForDefaultAgent("token-1", "user-1", agent, "coding", "openai", "openai/gpt-5.2", "codex");

    expect(getGatewayConfig).toHaveBeenCalledTimes(2);
    expect(supabase.insertGatewayConfig).toHaveBeenCalledTimes(1);
    expect(supabase.updateGatewayConfig).toHaveBeenCalledTimes(1);
    expect(supabase.insertVersion).toHaveBeenCalledTimes(1);
  });

  it("retries manager writes through the update path after a duplicate insert race", async () => {
    const supabase = mockSupabaseForCreateRace();
    vi.mocked(getGatewayConfig)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...existingGatewayConfig,
        config_json: {
          runners: {
            manager: { kind: "llm_tool_runner", provider: "openai", model: "openai/gpt-5.1" },
          },
        },
      });

    await writeGatewayConfigForManagerAgent({
      accessToken: "token-1",
      userId: "user-1",
      agent,
      provider: "local",
      model: "qwen3-coder:30b",
      runnerKind: "llm_tool_runner",
    });

    expect(getGatewayConfig).toHaveBeenCalledTimes(2);
    expect(supabase.insertGatewayConfig).toHaveBeenCalledTimes(1);
    expect(supabase.updateGatewayConfig).toHaveBeenCalledTimes(1);
    expect(supabase.insertVersion).toHaveBeenCalledTimes(1);
  });
});
