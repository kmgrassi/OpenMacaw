import { describe, expect, it } from "vitest";

import { SkillCreateToolRequestSchema, SkillSchema } from "../../../../contracts/skills.js";

describe("skills contract", () => {
  it("parses draft skill rows", () => {
    expect(
      SkillSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        agentId: "33333333-3333-4333-8333-333333333333",
        name: "repo-debugging",
        description: "Use when debugging repository-specific failures.",
        body: "Check the API logs before changing code.",
        status: "draft",
        copiedFromSkillId: null,
        createdByAgentId: null,
        createdByUserId: null,
        sourceRunId: null,
        createdAt: "2026-04-25T00:00:00.000Z",
        updatedAt: "2026-04-25T00:00:00.000Z",
      }),
    ).toMatchObject({
      name: "repo-debugging",
      status: "draft",
    });
  });

  it("enforces Agent Skills name and description limits for tool creation", () => {
    expect(
      SkillCreateToolRequestSchema.safeParse({
        agentId: "33333333-3333-4333-8333-333333333333",
        name: "Claude",
        description: "Reserved name.",
        body: "Do not use.",
      }).success,
    ).toBe(false);
    expect(
      SkillCreateToolRequestSchema.safeParse({
        agentId: "33333333-3333-4333-8333-333333333333",
        name: "valid-skill",
        description: "x".repeat(1025),
        body: "Do this.",
      }).success,
    ).toBe(false);
  });
});
