import { describe, expect, it } from "vitest";

import { ApiRouteError } from "../../../http.js";
import { pickClaimableAgent, requireAgentRow } from "./agent-row-helpers.js";
import type { AgentRow } from "../types.js";

function agent(overrides: Partial<AgentRow> & Pick<AgentRow, "id">): AgentRow {
  const { id, ...rest } = overrides;
  return {
    id,
    workspace_id: "workspace-1",
    name: "Agent",
    status: "paused",
    type: "planning",
    model_settings: {},
    tool_policy: {},
    created_by_user_id: "user-1",
    updated_at: "2026-06-18T00:00:00.000Z",
    ...rest,
  };
}

describe("setup store agent row helpers", () => {
  it("prefers the first active agent when claiming existing rows", () => {
    const claimed = pickClaimableAgent([
      agent({ id: "oldest-paused", status: "paused" }),
      agent({ id: "active-agent", status: "active" }),
      agent({ id: "newest-paused", status: "paused" }),
    ]);

    expect(claimed?.id).toBe("active-agent");
  });

  it("falls back to the oldest row when no active agent exists", () => {
    const claimed = pickClaimableAgent([
      agent({ id: "oldest-paused", status: "paused" }),
      agent({ id: "newest-paused", status: "paused" }),
    ]);

    expect(claimed?.id).toBe("oldest-paused");
  });

  it("requires agent mutations to return a row", () => {
    expect(() => requireAgentRow([], "default_agent_create_failed", "Default agent creation returned no row")).toThrow(
      ApiRouteError,
    );
    expect(() => requireAgentRow([], "default_agent_create_failed", "Default agent creation returned no row")).toThrow(
      "Default agent creation returned no row",
    );
  });
});
