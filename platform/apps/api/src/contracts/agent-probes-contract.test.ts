import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  AgentDispatchDryRunResponseSchema,
  AgentProbeDiagnosticSummarySchema,
  AgentScenarioFixtureSchema,
  LogSummarySnapshotSchema,
  SupportArtifactRedactionSchema,
  ToolInvocationProbeErrorCodeSchema,
  ToolInvocationProbeResponseSchema,
} from "../../../../contracts/agent-probes.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const logsSummaryScript = join(repoRoot, "scripts/logs-summary.mjs");

const agentId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const toolId = "33333333-3333-4333-8333-333333333333";
const machineId = "44444444-4444-4444-8444-444444444444";

describe("agent probe contracts", () => {
  it("keeps diagnostic blocker codes specific enough for CLI next steps", () => {
    const diagnostic = AgentProbeDiagnosticSummarySchema.parse({
      canChat: false,
      blockers: [
        {
          code: "missing_requirement",
          message: "Execution profile is missing requirement: credential",
          nextStep: "Configure an execution credential, then rerun doctor.",
        },
        {
          code: "launcher_unhealthy",
          message: "Launcher health check failed",
          nextStep: "Start parallel-agent-runtime with pnpm run start:local.",
        },
      ],
    });

    expect(diagnostic.canChat).toBe(false);
    expect(diagnostic.blockers.map((blocker) => blocker.code)).toEqual(["missing_requirement", "launcher_unhealthy"]);
    expect(
      AgentProbeDiagnosticSummarySchema.safeParse({
        canChat: false,
        blockers: [{ code: "blocked", message: "ambiguous" }],
      }).success,
    ).toBe(false);
  });

  it("locks down tool invocation error codes for probe recommendations", () => {
    expect(ToolInvocationProbeErrorCodeSchema.options).toEqual([
      "tool_not_found",
      "tool_not_granted",
      "tool_input_invalid",
      "tool_execution_failed",
    ]);

    const failed = ToolInvocationProbeResponseSchema.parse({
      status: "failed",
      agentId,
      workspaceId,
      toolSlug: "repo.read_file",
      errorCode: "tool_not_granted",
      message: "repo.read_file is not granted to this agent.",
      nextStep: "Grant repo.read_file to the agent before rerunning the smoke.",
    });

    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.errorCode).toBe("tool_not_granted");
    }
    expect(
      ToolInvocationProbeResponseSchema.safeParse({
        ...failed,
        errorCode: "permission_denied",
      }).success,
    ).toBe(false);
  });

  it("validates shared scenario fixtures without environment-specific secrets", () => {
    const fixture = AgentScenarioFixtureSchema.parse({
      scenario: "coding-agent-filesystem-read",
      description: "Read package.json through the local coding tool profile.",
      agentId: null,
      workspaceId: null,
      runnerKind: "local_model_coding",
      provider: "openai",
      expectedTool: "repo.read_file",
      expectedDatabaseAssertion: "tool_call_recorded",
      requestId: null,
      messageId: null,
      runId: null,
      toolCallId: null,
      preconditions: ["agentId and workspaceId are supplied by flags"],
      actions: ["send a prompt that asks to inspect package.json"],
      expectedOutcomes: ["repo.read_file tool call is observed"],
    });

    expect(fixture.scenario).toBe("coding-agent-filesystem-read");
    expect(fixture.preconditions).toHaveLength(1);
    expect(
      AgentScenarioFixtureSchema.safeParse({
        ...fixture,
        provider: "openai-compatible",
      }).success,
    ).toBe(false);
  });

  it("validates dry-run dispatch payloads against execution contracts", () => {
    const dryRun = AgentDispatchDryRunResponseSchema.parse({
      status: "passed",
      agentId,
      workspaceId,
      requestId: "req_123",
      diagnosticBefore: {
        canChat: true,
        blockers: [],
      },
      dispatch: {
        executionProfile: {
          agentId,
          workspaceId,
          role: "coding",
          runnerKind: "local_model_coding",
          provider: "openai",
          model: "openai/gpt-5.2",
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
        },
        workspacePolicy: {
          sandbox: "workspace_write",
          approvalPolicy: "on_request",
        },
        executionTarget: {
          kind: "local_helper",
          workspaceId,
          runnerKind: "local_model_coding",
          machineId,
          workspaceRootRef: "workspace-root",
          workspaceRoot: "/tmp/repo",
        },
        toolAssignments: [
          {
            id: toolId,
            workspaceId,
            slug: "repo.read_file",
            name: "Read file",
            description: "Read a workspace file.",
            parameters: { type: "object" },
            examples: [],
            executionKind: "filesystem_read",
            runnerKind: "local_model_coding",
            enabled: true,
          },
        ],
      },
    });

    expect(dryRun.dispatch.executionTarget.kind).toBe("local_helper");
    if (dryRun.dispatch.executionTarget.kind === "local_helper") {
      expect(dryRun.dispatch.executionProfile.runnerKind).toBe(dryRun.dispatch.executionTarget.runnerKind);
    }
    expect(
      AgentDispatchDryRunResponseSchema.safeParse({
        ...dryRun,
        dispatch: {
          ...dryRun.dispatch,
          executionProfile: {
            ...dryRun.dispatch.executionProfile,
            provider: "openai-compatible",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("validates redaction metadata for support artifacts", () => {
    const redacted = SupportArtifactRedactionSchema.parse({
      key: "OPENAI_API_KEY",
      value: "[redacted]",
      redacted: true,
    });

    expect(redacted.redacted).toBe(true);
  });
});

describe("logs summary probe contract", () => {
  it("groups failures by agent, request, run, and tool call id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-probe-logs-"));

    try {
      await mkdir(join(cwd, ".run-logs"));
      await writeFile(
        join(cwd, ".run-logs", "api.log"),
        [
          JSON.stringify({
            level: "error",
            timestamp: "2026-05-11T12:01:00.000Z",
            event: "tool_execution_failed",
            service: "symphony-express-server",
            trace_id: "trc_1",
            request_id: "req_1",
            agent_id: "agent-1",
            workspace_id: "workspace-1",
            run_id: "run_1",
            tool_call_id: "tool_call_1",
            route_pattern: "/api/dev/tools/:toolSlug/invoke",
            status_code: 500,
            error_code: "tool_execution_failed",
            message: "Tool execution failed",
          }),
          "2026-05-11T12:02:00.000Z ERROR tool_execution_failed status=500 error_code=tool_execution_failed request_id=req_1 agent_id=agent-1 workspace_id=workspace-1 run_id=run_1 tool_call_id=tool_call_1",
        ].join("\n"),
      );
      await writeFile(join(cwd, ".run-logs", "web.log"), "");

      const { stdout } = await execFileAsync(
        process.execPath,
        [logsSummaryScript, "--since", "365d", "--agent-id", "agent-1", "--json"],
        { cwd },
      );
      const output = LogSummarySnapshotSchema.parse(JSON.parse(stdout));

      expect(output.summary.warningOrErrorRecords).toBe(2);
      expect(output.groups[0]?.group).toMatchObject({
        requestId: "req_1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        runId: "run_1",
        toolCallId: "tool_call_1",
        errorCode: "tool_execution_failed",
      });
      expect(output.recentRecords[0]).toMatchObject({
        runId: "run_1",
        toolCallId: "tool_call_1",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
