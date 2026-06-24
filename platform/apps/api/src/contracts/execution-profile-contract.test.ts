import { describe, expect, it } from "vitest";

import {
  ContainerExecutionDispatchMetadataSchema,
  deriveExecutionProviderFromModel,
  ExecutionProfileSchema,
  RuntimeDispatchContextSchema,
  resolveExecutionProvider,
} from "../../../../contracts/execution-profile.js";
import { modelTier } from "../../../../contracts/model-tiers.js";
import {
  RUNNER_KINDS,
  RUNNER_REGISTRY,
  capabilitiesForRunnerKind,
  dimensionsForRunnerKind,
  isCredentiallessRunnerKind,
  isLocalCodingRunnerKind,
} from "../../../../contracts/runner-kinds.js";
import {
  LocalCodingEventEnvelopeSchema,
  LocalCodingNormalizedEventSchema,
  LocalCodingToolArgumentsSchema,
  LocalCodingToolResultEnvelopeSchema,
  LocalCodingToolResultPayloadSchema,
} from "../../../../contracts/local-model-coding.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const planningAgentId = "33333333-3333-4333-8333-333333333333";
const codingAgentId = "44444444-4444-4444-8444-444444444444";

describe("execution profile contract", () => {
  it("classifies model tiers with exact and wildcard provider entries", () => {
    expect(modelTier("anthropic", "claude-opus-4-7")).toBe("frontier");
    expect(modelTier("openai_compatible", "qwen-2.5")).toBe("local");
    expect(modelTier("anthropic", "unknown-claude")).toBeNull();
  });

  it("maps every runner kind into explicit routing dimensions", () => {
    expect(RUNNER_KINDS).toEqual(Object.keys(RUNNER_REGISTRY));
    expect(RUNNER_KINDS.map((kind) => [kind, dimensionsForRunnerKind(kind)])).toEqual([
      [
        "codex",
        {
          runnerFamily: "workspace_coding",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "claude_code",
        {
          runnerFamily: "workspace_coding",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "openclaw",
        {
          runnerFamily: "custom_runtime",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "local_model_coding",
        {
          runnerFamily: "workspace_coding",
          executionLocation: "local",
          transport: "local_relay",
        },
      ],
      [
        "llm_tool_runner",
        {
          runnerFamily: "tool_calling_llm",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "planner",
        {
          runnerFamily: "tool_calling_llm",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "openclaw_ws",
        {
          runnerFamily: "custom_runtime",
          executionLocation: "external",
          transport: "websocket",
        },
      ],
      [
        "openclaw_http_sse",
        {
          runnerFamily: "custom_runtime",
          executionLocation: "external",
          transport: "http_sse",
        },
      ],
      [
        "computer_use",
        {
          runnerFamily: "computer_use",
          executionLocation: "cloud",
          transport: "launcher",
        },
      ],
      [
        "local_relay",
        {
          runnerFamily: "model_chat",
          executionLocation: "local",
          transport: "local_relay",
        },
      ],
    ]);
  });

  it("derives runner capabilities and credential policy from the registry", () => {
    expect(isCredentiallessRunnerKind("local_relay")).toBe(true);
    expect(isCredentiallessRunnerKind("local_model_coding")).toBe(true);
    expect(isLocalCodingRunnerKind("local_model_coding")).toBe(true);
    expect(capabilitiesForRunnerKind("codex", "custom")).toMatchObject({
      toolCalls: false,
      workspaceWrite: true,
      interrupt: true,
    });
    expect(capabilitiesForRunnerKind("local_model_coding", "coding")).toMatchObject({
      toolCalls: true,
      workspaceWrite: true,
      structuredOutput: true,
    });
  });

  it("parses a planning agent profile backed by Anthropic", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: planningAgentId,
      workspaceId,
      role: "planning",
      runnerKind: "llm_tool_runner",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      credentialRef: {
        type: "alias",
        value: "default-anthropic",
      },
      toolProfile: "planning",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
        interrupt: true,
      },
    });

    expect(parsed.role).toBe("planning");
    expect(parsed.runnerKind).toBe("llm_tool_runner");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.toolProfile).toBe("planning");
    expect(parsed.capabilities.workspaceWrite).toBe(false);
    expect(parsed.fallbacks).toEqual([]);
    expect(parsed.modelTierFloor).toBe("any");
  });

  it("parses a coding agent profile backed by Codex", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "codex",
      provider: "openai_codex",
      model: "openai_codex/gpt-5.3-codex",
      credentialRef: {
        type: "credential_id",
        value: "55555555-5555-4555-8555-555555555555",
      },
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: true,
      },
    });

    expect(parsed.role).toBe("coding");
    expect(parsed.runnerKind).toBe("codex");
    expect(parsed.provider).toBe("openai_codex");
    expect(parsed.toolProfile).toBe("coding");
    expect(parsed.capabilities.workspaceWrite).toBe(true);
  });

  it("parses a coding agent profile backed by Claude Code and Anthropic", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "sonnet",
      credentialRef: {
        type: "alias",
        value: "anthropic/default",
      },
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: false,
      },
    });

    expect(parsed.role).toBe("coding");
    expect(parsed.runnerKind).toBe("claude_code");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("sonnet");
    expect(parsed.toolProfile).toBe("coding");
  });

  it("parses a Claude Code profile with a full Anthropic model id", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      credentialRef: {
        type: "credential_id",
        value: "55555555-5555-4555-8555-555555555555",
      },
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: false,
      },
    });

    expect(parsed.runnerKind).toBe("claude_code");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("keeps provider and runner kind as separate concepts", () => {
    const profile = {
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "openclaw_ws",
      provider: "openclaw",
      model: "openclaw/default-coder",
      credentialRef: null,
      toolProfile: "coding",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: true,
      },
    };

    expect(ExecutionProfileSchema.parse(profile).runnerKind).toBe("openclaw_ws");
    expect(ExecutionProfileSchema.parse(profile).provider).toBe("openclaw");
  });

  it("parses a local model coding profile without Codex credential fields", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model: "qwen2.5-coder:latest",
      credentialRef: null,
      toolProfile: "coding",
      workspacePolicy: {
        sandbox: "workspace_write",
        approvalPolicy: "on_request",
      },
      capabilityRequirements: {
        toolCalls: true,
        jsonMode: true,
      },
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: true,
        interrupt: true,
      },
    });

    expect(parsed.runnerKind).toBe("local_model_coding");
    expect(parsed.provider).toBe("openai_compatible");
    expect(parsed.credentialRef).toBeNull();
    expect(parsed.workspacePolicy?.sandbox).toBe("workspace_write");
    expect(parsed.capabilityRequirements?.jsonMode).toBe(true);
  });

  it("parses a local planner profile without hosted credential fields", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: planningAgentId,
      workspaceId,
      role: "planning",
      runnerKind: "planner",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      toolProfile: "planning",
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: false,
        structuredOutput: true,
        interrupt: false,
      },
    });

    expect(parsed.runnerKind).toBe("planner");
    expect(parsed.provider).toBe("local");
    expect(parsed.credentialRef).toBeNull();
  });

  it("parses local coding shell, patch, and normalized event payloads", () => {
    const shellArguments = LocalCodingToolArgumentsSchema.parse({
      toolSlug: "shell.exec",
      arguments: {
        argv: ["rg", "local_model_coding", "contracts"],
        cwd: "/workspace/repo",
        timeout_ms: 30000,
      },
    });
    expect(shellArguments.toolSlug).toBe("shell.exec");
    if (shellArguments.toolSlug === "shell.exec") {
      expect(shellArguments.arguments.argv).toEqual(["rg", "local_model_coding", "contracts"]);
    }

    const shellResult = LocalCodingToolResultPayloadSchema.parse({
      toolSlug: "shell.exec",
      status: "completed",
      commandActions: ["search"],
      result: {
        exitCode: 0,
        stdout: "contracts/runner-kinds.ts",
        durationMs: 42,
        timedOut: false,
      },
    });
    expect(shellResult.toolSlug).toBe("shell.exec");
    if (shellResult.toolSlug === "shell.exec") {
      expect(shellResult.commandActions).toEqual(["search"]);
    }

    const gitResult = LocalCodingToolResultPayloadSchema.parse({
      toolSlug: "git.run",
      status: "completed",
      commandActions: ["unknown"],
      result: {
        exitCode: 0,
        stdout: "main",
      },
    });
    expect(gitResult.toolSlug).toBe("git.run");

    const patchResult = LocalCodingToolResultPayloadSchema.parse({
      toolSlug: "apply_patch",
      status: "completed",
      result: {
        applied: true,
        changes: [{ path: "README.md", changeType: "modified" }],
      },
    });
    expect(patchResult.toolSlug).toBe("apply_patch");

    expect(
      LocalCodingNormalizedEventSchema.parse({
        type: "file_change_applied",
        toolCallId: "tool-call-1",
        changes: [{ path: "contracts/runner-kinds.ts", changeType: "modified", additions: 1, deletions: 0 }],
      }).type,
    ).toBe("file_change_applied");

    expect(
      LocalCodingToolResultEnvelopeSchema.parse({
        source: "container",
        payload: shellResult,
      }).source,
    ).toBe("container");

    expect(
      LocalCodingEventEnvelopeSchema.parse({
        source: "local_helper",
        payload: {
          type: "file_change_applied",
          toolCallId: "tool-call-1",
          changes: [{ path: "contracts/runner-kinds.ts", changeType: "modified" }],
        },
      }).source,
    ).toBe("local_helper");
  });

  it("allows explicit tool definitions alongside a tool profile", () => {
    const parsed = ExecutionProfileSchema.parse({
      agentId: codingAgentId,
      workspaceId,
      role: "coding",
      runnerKind: "local_relay",
      provider: "openai_compatible",
      model: "openai_compatible/qwen",
      credentialRef: null,
      toolProfile: "coding",
      toolDefinitions: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          workspaceId: null,
          slug: "git_status",
          name: "git_status",
          description: "Read repository status.",
          parameters: { type: "object", properties: {} },
          examples: [],
          executionKind: "git",
          runnerKind: "local_relay",
          enabled: true,
        },
      ],
      capabilities: {
        streaming: true,
        toolCalls: true,
        workspaceWrite: true,
        structuredOutput: false,
        interrupt: true,
      },
    });

    expect(parsed.toolProfile).toBe("coding");
    expect(parsed.toolDefinitions?.[0]?.name).toBe("git_status");
  });

  it("parses local model coding dispatch context with tools and workspace policy", () => {
    const parsed = RuntimeDispatchContextSchema.parse({
      executionProfile: {
        agentId: codingAgentId,
        workspaceId,
        role: "coding",
        runnerKind: "local_model_coding",
        provider: "openai_compatible",
        model: "qwen2.5-coder:latest",
        credentialRef: {
          type: "credential_id",
          value: "55555555-5555-4555-8555-555555555555",
        },
        toolProfile: "coding",
        toolDefinitions: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            workspaceId: null,
            slug: "shell.exec",
            name: "Run Shell Command",
            description: "Execute a shell command in the workspace.",
            parameters: { type: "object", properties: {} },
            examples: [],
            executionKind: "shell",
            runnerKind: "local_model_coding",
            enabled: true,
          },
        ],
        capabilities: {
          streaming: true,
          toolCalls: true,
          workspaceWrite: true,
          structuredOutput: true,
          interrupt: true,
        },
      },
      workspacePolicy: {
        sandbox: "workspace_write",
        approvalPolicy: "on_request",
      },
      executionTarget: {
        kind: "local_helper",
        workspaceId,
        runnerKind: "local_model_coding",
        machineId: "77777777-7777-4777-8777-777777777777",
        workspaceRootRef: "local_runtime_machine:77777777-7777-4777-8777-777777777777",
      },
      toolAssignments: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          workspaceId: null,
          slug: "shell.exec",
          name: "Run Shell Command",
          description: "Execute a shell command in the workspace.",
          parameters: { type: "object", properties: {} },
          examples: [],
          executionKind: "shell",
          runnerKind: "local_model_coding",
          enabled: true,
        },
      ],
    });

    expect(parsed.executionProfile.runnerKind).toBe("local_model_coding");
    expect(parsed.workspacePolicy.sandbox).toBe("workspace_write");
    expect(parsed.toolAssignments[0]?.slug).toBe("shell.exec");
  });

  it("parses planner local dispatch context with planner tools", () => {
    const parsed = RuntimeDispatchContextSchema.parse({
      executionProfile: {
        agentId: planningAgentId,
        workspaceId,
        role: "planning",
        runnerKind: "planner",
        provider: "local",
        model: "qwen2.5-coder:7b",
        credentialRef: null,
        toolProfile: "planning",
        toolDefinitions: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            workspaceId: null,
            slug: "create_plan",
            name: "Create Plan",
            description: "Create a planning record.",
            parameters: { type: "object", properties: {} },
            examples: [],
            executionKind: "database",
            runnerKind: "planner",
            enabled: true,
          },
        ],
        capabilities: {
          streaming: true,
          toolCalls: true,
          workspaceWrite: false,
          structuredOutput: true,
          interrupt: false,
        },
      },
      workspacePolicy: {
        sandbox: "read_only",
        approvalPolicy: "never",
      },
      executionTarget: {
        kind: "local_helper",
        workspaceId,
        runnerKind: "planner",
        machineId: "77777777-7777-4777-8777-777777777777",
        workspaceRootRef: "local_runtime_machine:77777777-7777-4777-8777-777777777777",
      },
      toolAssignments: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          workspaceId: null,
          slug: "create_plan",
          name: "Create Plan",
          description: "Create a planning record.",
          parameters: { type: "object", properties: {} },
          examples: [],
          executionKind: "database",
          runnerKind: "planner",
          enabled: true,
        },
      ],
    });

    expect(parsed.executionProfile.runnerKind).toBe("planner");
    expect(parsed.executionTarget).toMatchObject({ kind: "local_helper", runnerKind: "planner" });
    expect(parsed.toolAssignments[0]?.slug).toBe("create_plan");
  });

  it("parses container dispatch metadata for coding execution", () => {
    const parsed = ContainerExecutionDispatchMetadataSchema.parse({
      workspaceId,
      sessionId: "session-123",
      resources: [
        {
          grantId: "55555555-5555-4555-8555-555555555555",
          resourceId: "66666666-6666-4666-8666-666666666666",
          resourceType: "git_repository",
          provider: "github",
          providerUrl: "https://github.com/kmgrassi/parallel-agent-platform.git",
          displayName: "parallel-agent-platform",
          alias: "parallel-agent-platform",
          credentialRef: null,
          accessMode: "read",
          requirement: "required",
          repositoryRef: {
            type: "git_ref",
            branch: "main",
            ref: "refs/heads/main",
            commitSha: "3165d7c",
          },
          networkPolicy: {
            mode: "allowlist",
            allowedHosts: ["github.com"],
          },
        },
      ],
      limits: {
        timeoutMs: 120000,
        maxCpuCores: 2,
        maxMemoryMb: 4096,
        maxDiskMb: 8192,
        maxProcessCount: 64,
      },
      artifactRetention: {
        retainDays: 14,
        storeCommandOutput: true,
        storePatchArtifact: true,
      },
      networkPolicy: {
        mode: "allowlist",
        allowedHosts: ["registry.npmjs.org", "github.com"],
      },
    });

    expect(parsed.sessionId).toBe("session-123");
    expect(parsed.resources[0]?.repositoryRef?.type).toBe("git_ref");
    expect(parsed.networkPolicy.mode).toBe("allowlist");
  });

  it("derives provider from model only as an explicit fallback", () => {
    expect(
      resolveExecutionProvider({
        provider: "anthropic",
        model: "openai/gpt-5.2",
      }),
    ).toBe("anthropic");
    expect(resolveExecutionProvider({ provider: null, model: " openai/gpt-5.2 " })).toBe("openai");
    expect(resolveExecutionProvider({ provider: null, model: "openai_codex/gpt-5.3-codex" })).toBe("openai_codex");
    expect(deriveExecutionProviderFromModel("gpt-5.2")).toBeNull();
    expect(deriveExecutionProviderFromModel(" /gpt-5.2")).toBeNull();
  });
});
