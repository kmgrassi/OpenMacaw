import { describe, expect, it } from "vitest";

import { PlatformApiContracts } from "../../../../contracts/platform-api-contracts.js";

describe("Platform API route contracts", () => {
  it("requires workspaceId for available tool listing", () => {
    const contract = PlatformApiContracts.listTools;

    expect(contract).toBeDefined();
    expect(contract.query.safeParse({}).success).toBe(false);
    expect(
      contract.query.safeParse({
        workspaceId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
  });

  it("requires workspaceId for deleting a tool definition", () => {
    const contract = PlatformApiContracts.deleteToolDefinition;

    expect(contract).toBeDefined();
    expect(contract.query.safeParse({}).success).toBe(false);
    expect(
      contract.query.safeParse({
        workspaceId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
  });

  it("requires workspaceId in tool mutation bodies that need workspace scope", () => {
    expect(
      PlatformApiContracts.createToolDefinition.body.safeParse({
        slug: "read_file",
        name: "Read File",
      }).success,
    ).toBe(false);
    expect(PlatformApiContracts.updateToolDefinition.body.safeParse({ name: "Read File" }).success).toBe(false);
    expect(
      PlatformApiContracts.upsertAgentToolGrant.body.safeParse({
        mode: "include",
      }).success,
    ).toBe(false);
  });

  it("uses unique route contract keys", () => {
    const keys = Object.keys(PlatformApiContracts);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes agent live I/O route contracts", () => {
    expect(PlatformApiContracts.sendAgentLiveInput.path).toBe("/api/agents/:agentId/input");
    expect(PlatformApiContracts.interruptAgentLiveSession.path).toBe("/api/agents/:agentId/interrupt");
    expect(PlatformApiContracts.streamAgentLiveEvents.path).toBe("/api/agents/:agentId/stream");
  });
});
