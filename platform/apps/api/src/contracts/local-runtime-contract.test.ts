import { describe, expect, it } from "vitest";

import {
  AgentLocalRuntimeAssignRequestSchema,
  LocalModelCatalogResponseSchema,
  LocalModelProbeRequestSchema,
  LocalRuntimeRegistrationRequestSchema,
} from "../../../../contracts/local-runtime.js";
import { agentAssignLocalModelRoute } from "../../../../contracts/routes.js";

describe("local runtime contract", () => {
  it("rejects local model providers outside the execution provider enum", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "ollama",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("defaults openai_compatible runner provider to the OpenAI-compatible value", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
        },
      ],
    });
    const first = parsed.runners[0]!;
    if (first.kind !== "openai_compatible") {
      throw new Error("Expected discriminator to narrow to openai_compatible");
    }
    expect(first.provider).toBe("openai_compatible");
  });

  it("accepts an openclaw-only registration with just an endpoint", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
        },
      ],
    });
    const first = parsed.runners[0]!;
    expect(first.kind).toBe("openclaw");
    expect(first.endpoint).toBe("http://localhost:7100");
  });

  it("accepts bracketed IPv6 loopback endpoints", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openai_compatible",
          endpoint: "http://[::1]:11434/v1",
          model: "qwen3-coder:30b",
        },
      ],
    });
    const first = parsed.runners[0]!;
    expect(first.endpoint).toBe("http://[::1]:11434/v1");
  });

  it("accepts a multi-kind registration carrying both openai_compatible and openclaw runners", () => {
    const parsed = LocalRuntimeRegistrationRequestSchema.parse({
      runners: [
        {
          kind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
        },
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
          apiKey: "sk-openclaw",
        },
      ],
    });
    expect(parsed.runners).toHaveLength(2);
    expect(parsed.runners.map((runner) => runner.kind).sort()).toEqual(["openai_compatible", "openclaw"]);
  });

  it("rejects a registration with duplicate runner kinds", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [
          { kind: "openclaw", endpoint: "http://localhost:7100" },
          { kind: "openclaw", endpoint: "http://localhost:7200" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a registration with no runners", () => {
    expect(LocalRuntimeRegistrationRequestSchema.safeParse({ runners: [] }).success).toBe(false);
  });

  it("rejects non-loopback local runtime endpoints", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://169.254.169.254/latest/meta-data",
            model: "qwen3-coder:30b",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects local runtime endpoints with embedded credentials", () => {
    expect(
      LocalRuntimeRegistrationRequestSchema.safeParse({
        runners: [{ kind: "openclaw", endpoint: "http://user:pass@localhost:7100" }],
      }).success,
    ).toBe(false);
  });

  it("rejects probe endpoints outside loopback", () => {
    expect(
      LocalModelProbeRequestSchema.safeParse({
        endpoint: "https://example.com/v1",
        model: "qwen3-coder:30b",
      }).success,
    ).toBe(false);
  });

  it("accepts model catalog entries when either id or name is present", () => {
    const parsed = LocalModelCatalogResponseSchema.parse({
      data: [{ id: "qwen3-coder:30b" }, { name: "Qwen 3 Coder" }],
    });

    expect(parsed.data).toEqual([{ id: "qwen3-coder:30b" }, { name: "Qwen 3 Coder" }]);
  });

  it("rejects model catalog entries with neither id nor name", () => {
    expect(
      LocalModelCatalogResponseSchema.safeParse({
        data: [{}],
      }).success,
    ).toBe(false);
  });

  it("defines the canonical agent local model assignment request", () => {
    const parsed = AgentLocalRuntimeAssignRequestSchema.parse({
      machineId: "machine-1",
      localRuntimeId: "local-rule-1",
    });

    expect(parsed).toEqual({
      machineId: "machine-1",
      localRuntimeId: "local-rule-1",
    });
    expect(agentAssignLocalModelRoute("agent-1", "workspace-1")).toBe(
      "/api/agents/agent-1/assign-local-model?workspaceId=workspace-1",
    );
  });
});
