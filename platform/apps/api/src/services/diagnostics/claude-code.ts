import type { WorkerBridgeSessionRow } from "../../../../../contracts/worker-bridge.js";

type ClaudeCodeDiagnosticStatus =
  | "not_applicable"
  | "missing_anthropic_credential"
  | "unsupported_runtime_runner"
  | "runtime_bridge_startup_failed"
  | "ready";

export type ClaudeCodeDiagnostic = {
  applicable: boolean;
  status: ClaudeCodeDiagnosticStatus;
  runnerKind: "claude_code" | null;
  provider: string | null;
  model: string | null;
  credential: {
    provider: "anthropic";
    required: boolean;
    ready: boolean;
    reference: unknown;
  };
  runtimeBridge: {
    reported: boolean;
    available: boolean | null;
    status: string | null;
    sessionId: string | null;
    failure: string | null;
  };
  permissions: {
    toolProfile: string | null;
    permissionMode: "acceptEdits";
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
  };
  blockers: string[];
};

const CLAUDE_CODE_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] as const;

function isFailedBridgeStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "error" || normalized === "unsupported_runner";
}

function isUnsupportedRunnerBridgeStatus(status: string | null | undefined) {
  return status?.trim().toLowerCase() === "unsupported_runner";
}

function isRunningBridgeStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === "running" || normalized === "ready";
}

export function selectClaudeBridgeSession(
  sessions: WorkerBridgeSessionRow[],
  input: { agentId: string; workspaceId: string | null },
) {
  const candidates = sessions.filter((session) => {
    if (session.kind !== "claude_code") return false;
    if (session.agent_id && session.agent_id !== input.agentId) return false;
    if (session.workspace_id && input.workspaceId && session.workspace_id !== input.workspaceId) return false;
    return true;
  });

  const newestFirst = candidates.sort((left, right) => {
    const rightStartedAt = Date.parse(right.started_at);
    const leftStartedAt = Date.parse(left.started_at);
    return (Number.isNaN(rightStartedAt) ? 0 : rightStartedAt) - (Number.isNaN(leftStartedAt) ? 0 : leftStartedAt);
  });

  return (
    newestFirst.find((session) => isRunningBridgeStatus(session.status)) ??
    newestFirst.find((session) => isFailedBridgeStatus(session.status)) ??
    newestFirst[0] ??
    null
  );
}

export function buildClaudeCodeDiagnostic(input: {
  requestedRunnerKind: string | null;
  executionProfile: {
    resolved: boolean;
    missing: string[];
    profile: {
      runnerKind: string | null;
      provider: string | null;
      model: string | null;
      credentialRef: unknown;
      toolProfile: string | null;
    } | null;
  };
  launcherHealthy: boolean;
  bridgeSession: WorkerBridgeSessionRow | null;
}): ClaudeCodeDiagnostic {
  const profile = input.executionProfile.profile;
  const applicable = input.requestedRunnerKind === "claude_code" || profile?.runnerKind === "claude_code";
  const credentialReady =
    applicable &&
    profile?.provider === "anthropic" &&
    Boolean(profile.credentialRef) &&
    !input.executionProfile.missing.includes("credential");
  const runnerSupported = profile?.runnerKind === "claude_code";
  const bridgeFailure = input.bridgeSession
    ? isFailedBridgeStatus(input.bridgeSession.status) ||
      (input.bridgeSession.exit_status !== null && input.bridgeSession.exit_status !== 0)
    : false;
  const runtimeUnsupportedRunner = input.bridgeSession
    ? isUnsupportedRunnerBridgeStatus(input.bridgeSession.status)
    : false;
  const bridgeAvailable = input.bridgeSession
    ? !bridgeFailure && isRunningBridgeStatus(input.bridgeSession.status)
    : null;

  const blockers: string[] = [];
  if (applicable && !credentialReady) blockers.push("Missing Anthropic credential for Claude Code");
  if (applicable && (!runnerSupported || runtimeUnsupportedRunner))
    blockers.push("Runtime does not support runner_kind claude_code");
  if (applicable && !input.launcherHealthy)
    blockers.push("Launcher health check failed before Claude bridge availability could be verified");
  if (applicable && bridgeFailure && !runtimeUnsupportedRunner)
    blockers.push("Runtime reported Claude Code bridge startup failure");

  let status: ClaudeCodeDiagnosticStatus = "not_applicable";
  if (applicable && !credentialReady) {
    status = "missing_anthropic_credential";
  } else if (applicable && (!runnerSupported || runtimeUnsupportedRunner)) {
    status = "unsupported_runtime_runner";
  } else if (applicable && bridgeFailure) {
    status = "runtime_bridge_startup_failed";
  } else if (applicable) {
    status = "ready";
  }

  return {
    applicable,
    status,
    runnerKind: runnerSupported ? "claude_code" : null,
    provider: profile?.provider ?? null,
    model: profile?.model ?? null,
    credential: {
      provider: "anthropic",
      required: applicable,
      ready: credentialReady,
      reference: profile?.credentialRef ?? null,
    },
    runtimeBridge: {
      reported: Boolean(input.bridgeSession),
      available: bridgeAvailable,
      status: input.bridgeSession?.status ?? null,
      sessionId: input.bridgeSession?.id ?? null,
      failure: bridgeFailure ? (input.bridgeSession?.status ?? "failed") : null,
    },
    permissions: {
      toolProfile: profile?.toolProfile ?? null,
      permissionMode: "acceptEdits",
      tools: [...CLAUDE_CODE_TOOLS],
      allowedTools: [...CLAUDE_CODE_TOOLS],
      disallowedTools: [],
    },
    blockers,
  };
}
