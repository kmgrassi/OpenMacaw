import { describe, expect, it } from "vitest";

import { buildBlockers } from "../services/diagnostics/blockers.js";
import { buildClaudeCodeDiagnostic, selectClaudeBridgeSession } from "../services/diagnostics/claude-code.js";
import { buildCodexOAuthDiagnostic, selectCodexBridgeSession } from "../services/diagnostics/codex-oauth.js";
import { buildWorkItemSnoozeDiagnostic } from "../services/diagnostics/work-item-snooze.js";
import type { ResolvedSavedCredential } from "../services/saved-credentials.js";

describe("agent diagnostic — canChat / blockers logic", () => {
  it("reports canChat=true when all checks pass", () => {
    const agentFound = true;
    const resolutionMissing: string[] = [];
    const blockers = buildBlockers({
      agentFound,
      resolutionMissing,
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [
        {
          ruleId: "rule-1",
          allMatchesPass: true,
          matches: [{ kind: "agent_id", key: null, value: "agent-1", wouldMatch: true }],
        },
      ],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    const canChat = agentFound && resolutionMissing.length === 0 && blockers.length === 0;

    expect(canChat).toBe(true);
    expect(blockers).toEqual([]);
  });

  it("reports blocker when routing rule does not match", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: null,
      rulesInWorkspace: 1,
      matchDetails: [
        {
          ruleId: "rule-1",
          allMatchesPass: false,
          matches: [{ kind: "agent_id", key: null, value: "other-agent", wouldMatch: false }],
        },
      ],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers[0]).toContain("matchValue returned false");
    expect(blockers[0]).toContain("rule-1");
  });

  it("reports blocker when agent is not found", () => {
    const blockers = buildBlockers({
      agentFound: false,
      resolutionMissing: [],
      selectedRule: null,
      rulesInWorkspace: 0,
      matchDetails: [],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toEqual(["Agent not found in database"]);
  });

  it("reports blocker when no routing rules exist", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: null,
      rulesInWorkspace: 0,
      matchDetails: [],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toContain("No routing rules exist in this workspace");
  });

  it("reports missing execution profile requirements as blockers", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: ["credential", "model"],
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toContain("Execution profile is missing requirement: credential");
    expect(blockers).toContain("Execution profile is missing requirement: model");
  });

  it("reports local runtime blockers", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [],
      localRuntime: { isLocal: true, machineFound: false, endpointReachable: null },
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toContain("No registered local runtime relay is connected for this workspace");
  });

  it("reports relay and local model endpoint blockers separately without legacy helper ports", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [],
      localRuntime: { isLocal: true, machineFound: false, endpointReachable: false },
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toContain("No registered local runtime relay is connected for this workspace");
    expect(blockers).toContain("The local model endpoint is unreachable (for example Ollama is not running)");
    expect(JSON.stringify(blockers)).not.toContain("17654");
  });

  it("reports Claude Code diagnostic blockers separately", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [],
      localRuntime: null,
      codexOAuth: { applicable: false, blockers: [] },
      claudeCode: {
        applicable: true,
        blockers: ["Missing Anthropic credential for Claude Code"],
      },
      launcherHealthy: true,
    });

    expect(blockers).toContain("Missing Anthropic credential for Claude Code");
  });

  it("reports Codex OAuth diagnostic blockers separately", () => {
    const blockers = buildBlockers({
      agentFound: true,
      resolutionMissing: [],
      selectedRule: { id: "rule-1" },
      rulesInWorkspace: 1,
      matchDetails: [],
      localRuntime: null,
      codexOAuth: {
        applicable: true,
        blockers: ["Missing launchable ChatGPT OAuth credential for Codex"],
      },
      claudeCode: { applicable: false, blockers: [] },
      launcherHealthy: true,
    });

    expect(blockers).toContain("Missing launchable ChatGPT OAuth credential for Codex");
  });
});

describe("agent diagnostic — Codex OAuth readiness", () => {
  const baseProfile = {
    resolved: true,
    missing: [],
    profile: {
      runnerKind: "codex",
      provider: "openai_codex",
      model: "openai_codex/gpt-5.3-codex",
      credentialRef: { type: "credential_id", value: "cred-oauth" },
      toolProfile: "coding",
    },
  };

  const baseCredential: ResolvedSavedCredential = {
    id: "cred-oauth:OPENAI_API_KEY",
    credentialRowId: "cred-oauth",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "openai_codex" as const,
    label: "ChatGPT",
    envVar: "OPENAI_API_KEY",
    updatedAt: "2026-05-28T00:00:00.000Z",
    validationState: "ok" as const,
    validatedAt: "2026-05-28T00:00:01.000Z",
    launchableKind: "codex" as const,
    secretValue: "access-token",
    secretRef: null,
    aliases: ["access_token"],
    endpoint: null,
    apiVersion: null,
    oauth: {
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3_600_000,
    },
  };

  it("reports ready for a routed Codex OAuth credential", () => {
    const diagnostic = buildCodexOAuthDiagnostic({
      requestedRunnerKind: "codex",
      executionProfile: baseProfile,
      launcherHealthy: true,
      bridgeSession: {
        id: "session-1",
        kind: "codex",
        command: "codex app-server",
        cwd: "/tmp/workspace",
        status: "running",
        started_at: "2026-05-28T00:00:02.000Z",
        stopped_at: null,
        exit_status: null,
        env_keys: ["OPENAI_API_KEY"],
        credential_keys: ["OPENAI_API_KEY"],
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        credential_id: "cred-oauth",
      },
      credentials: [baseCredential],
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.credential.ready).toBe(true);
    expect(diagnostic.credential.authMode).toBe("oauth");
    expect(diagnostic.credential.token.refreshable).toBe(true);
    expect(diagnostic.runtimeBridge.available).toBe(true);
    expect(diagnostic.blockers).toEqual([]);
  });

  it("distinguishes missing ChatGPT OAuth credentials", () => {
    const diagnostic = buildCodexOAuthDiagnostic({
      requestedRunnerKind: "codex",
      executionProfile: {
        ...baseProfile,
        missing: ["credential"],
        profile: { ...baseProfile.profile, credentialRef: null },
      },
      launcherHealthy: true,
      bridgeSession: null,
      credentials: [],
    });

    expect(diagnostic.status).toBe("missing_codex_oauth_credential");
    expect(diagnostic.credential.ready).toBe(false);
    expect(diagnostic.blockers).toContain("Missing launchable ChatGPT OAuth credential for Codex");
  });

  it("distinguishes runtime bridge startup failures", () => {
    const diagnostic = buildCodexOAuthDiagnostic({
      requestedRunnerKind: "codex",
      executionProfile: baseProfile,
      launcherHealthy: true,
      bridgeSession: {
        id: "session-1",
        kind: "codex",
        command: "codex app-server",
        cwd: "/tmp/workspace",
        status: "failed",
        started_at: "2026-05-28T00:00:02.000Z",
        stopped_at: "2026-05-28T00:00:03.000Z",
        exit_status: 1,
        env_keys: ["OPENAI_API_KEY"],
        credential_keys: ["OPENAI_API_KEY"],
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        credential_id: "cred-oauth",
      },
      credentials: [baseCredential],
    });

    expect(diagnostic.status).toBe("runtime_bridge_startup_failed");
    expect(diagnostic.runtimeBridge.available).toBe(false);
    expect(diagnostic.blockers).toContain("Runtime reported Codex bridge startup failure");
  });

  it("selects the newest matching Codex bridge session", () => {
    const selected = selectCodexBridgeSession(
      [
        {
          id: "older",
          kind: "codex",
          command: "codex app-server",
          cwd: "/tmp/older",
          status: "failed",
          started_at: "2026-05-28T00:00:00.000Z",
          stopped_at: null,
          exit_status: 1,
          env_keys: [],
          credential_keys: [],
          agent_id: "agent-1",
          workspace_id: "workspace-1",
        },
        {
          id: "newer",
          kind: "codex",
          command: "codex app-server",
          cwd: "/tmp/newer",
          status: "running",
          started_at: "2026-05-28T00:00:01.000Z",
          stopped_at: null,
          exit_status: null,
          env_keys: ["OPENAI_API_KEY"],
          credential_keys: ["OPENAI_API_KEY"],
          agent_id: "agent-1",
          workspace_id: "workspace-1",
        },
      ],
      { agentId: "agent-1", workspaceId: "workspace-1" },
    );

    expect(selected?.id).toBe("newer");
  });
});

describe("agent diagnostic — Claude Code readiness", () => {
  const baseProfile = {
    resolved: true,
    missing: [],
    profile: {
      runnerKind: "claude_code",
      provider: "anthropic",
      model: "sonnet",
      credentialRef: { type: "credential_id", value: "cred-1" },
      toolProfile: "coding",
    },
  };

  it("distinguishes missing Anthropic credentials", () => {
    const diagnostic = buildClaudeCodeDiagnostic({
      requestedRunnerKind: "claude_code",
      executionProfile: {
        ...baseProfile,
        missing: ["credential"],
        profile: { ...baseProfile.profile, credentialRef: null },
      },
      launcherHealthy: true,
      bridgeSession: null,
    });

    expect(diagnostic.status).toBe("missing_anthropic_credential");
    expect(diagnostic.credential.ready).toBe(false);
    expect(diagnostic.blockers).toContain("Missing Anthropic credential for Claude Code");
  });

  it("distinguishes unsupported runtime runner resolution", () => {
    const diagnostic = buildClaudeCodeDiagnostic({
      requestedRunnerKind: "claude_code",
      executionProfile: {
        ...baseProfile,
        profile: { ...baseProfile.profile, runnerKind: "codex" },
      },
      launcherHealthy: true,
      bridgeSession: null,
    });

    expect(diagnostic.status).toBe("unsupported_runtime_runner");
    expect(diagnostic.blockers).toContain("Runtime does not support runner_kind claude_code");
  });

  it("distinguishes runtime-reported unsupported runner from bridge startup failure", () => {
    const diagnostic = buildClaudeCodeDiagnostic({
      requestedRunnerKind: "claude_code",
      executionProfile: baseProfile,
      launcherHealthy: true,
      bridgeSession: {
        id: "session-1",
        kind: "claude_code",
        command: "claude",
        cwd: "/tmp/workspace",
        status: "unsupported_runner",
        started_at: "2026-04-29T00:00:00.000Z",
        stopped_at: "2026-04-29T00:00:01.000Z",
        exit_status: 1,
        env_keys: [],
        credential_keys: ["ANTHROPIC_API_KEY"],
      },
    });

    expect(diagnostic.status).toBe("unsupported_runtime_runner");
    expect(diagnostic.blockers).toContain("Runtime does not support runner_kind claude_code");
    expect(diagnostic.blockers).not.toContain("Runtime reported Claude Code bridge startup failure");
  });

  it("distinguishes runtime bridge startup failure", () => {
    const diagnostic = buildClaudeCodeDiagnostic({
      requestedRunnerKind: "claude_code",
      executionProfile: baseProfile,
      launcherHealthy: true,
      bridgeSession: {
        id: "session-1",
        kind: "claude_code",
        command: "claude",
        cwd: "/tmp/workspace",
        status: "failed",
        started_at: "2026-04-29T00:00:00.000Z",
        stopped_at: "2026-04-29T00:00:01.000Z",
        exit_status: 1,
        env_keys: [],
        credential_keys: ["ANTHROPIC_API_KEY"],
        agent_id: "agent-1",
        workspace_id: "workspace-1",
        credential_id: "cred-1",
      },
    });

    expect(diagnostic.status).toBe("runtime_bridge_startup_failed");
    expect(diagnostic.runtimeBridge.available).toBe(false);
    expect(diagnostic.blockers).toContain("Runtime reported Claude Code bridge startup failure");
  });

  it("reports ready when profile, credential, and bridge evidence are healthy", () => {
    const diagnostic = buildClaudeCodeDiagnostic({
      requestedRunnerKind: "claude_code",
      executionProfile: baseProfile,
      launcherHealthy: true,
      bridgeSession: {
        id: "session-1",
        kind: "claude_code",
        command: "claude",
        cwd: "/tmp/workspace",
        status: "running",
        started_at: "2026-04-29T00:00:00.000Z",
        stopped_at: null,
        exit_status: null,
        env_keys: [],
        credential_keys: ["ANTHROPIC_API_KEY"],
      },
    });

    expect(diagnostic.status).toBe("ready");
    expect(diagnostic.credential.ready).toBe(true);
    expect(diagnostic.runtimeBridge.available).toBe(true);
    expect(diagnostic.permissions).toMatchObject({
      toolProfile: "coding",
      permissionMode: "acceptEdits",
    });
  });
});

describe("agent diagnostic — Claude bridge session selection", () => {
  it("prefers a running Claude bridge session over older failed sessions", () => {
    const selected = selectClaudeBridgeSession(
      [
        {
          id: "failed-session",
          kind: "claude_code",
          command: "claude",
          cwd: "/tmp/workspace",
          status: "failed",
          started_at: "2026-04-29T00:00:00.000Z",
          stopped_at: "2026-04-29T00:00:01.000Z",
          exit_status: 1,
          env_keys: [],
          credential_keys: ["ANTHROPIC_API_KEY"],
          agent_id: "agent-1",
          workspace_id: "workspace-1",
        },
        {
          id: "running-session",
          kind: "claude_code",
          command: "claude",
          cwd: "/tmp/workspace",
          status: "running",
          started_at: "2026-04-29T00:01:00.000Z",
          stopped_at: null,
          exit_status: null,
          env_keys: [],
          credential_keys: ["ANTHROPIC_API_KEY"],
          agent_id: "agent-1",
          workspace_id: "workspace-1",
        },
      ],
      { agentId: "agent-1", workspaceId: "workspace-1" },
    );

    expect(selected?.id).toBe("running-session");
  });
});

describe("agent diagnostic — work-item snooze section", () => {
  it("maps next_poll_at and the latest snooze event for each work item", () => {
    const diagnostic = buildWorkItemSnoozeDiagnostic({
      queriedWorkItemId: "work-item-1",
      workItems: [
        {
          id: "work-item-1",
          title: "Investigate failing CI",
          state: "open",
          next_poll_at: "2026-04-30T21:00:00.000Z",
          last_polled_at: "2026-04-30T18:00:00.000Z",
          poll_cadence_seconds: 300,
          updated_at: "2026-04-30T18:01:00.000Z",
        },
      ],
      snoozeEvents: [
        {
          id: "event-older",
          created_at: "2026-04-30T18:30:00.000Z",
          kind: "work_item.snoozed",
          source: "platform",
          payload: { reason: "older" },
          raw_payload: null,
          work_item_id: "work-item-1",
          workspace_id: "workspace-1",
        },
        {
          id: "event-newer",
          created_at: "2026-04-30T19:00:00.000Z",
          kind: "work_item.snoozed",
          source: "platform",
          payload: { reason: "user asked to defer" },
          raw_payload: { actor: { kind: "user", user_id: "user-1" } },
          work_item_id: "work-item-1",
          workspace_id: "workspace-1",
        },
      ],
    });

    expect(diagnostic).toMatchObject({
      queriedWorkItemId: "work-item-1",
      count: 1,
      items: [
        {
          id: "work-item-1",
          nextPollAt: "2026-04-30T21:00:00.000Z",
          lastPolledAt: "2026-04-30T18:00:00.000Z",
          pollCadenceSeconds: 300,
          latestSnoozeEvent: {
            id: "event-newer",
            createdAt: "2026-04-30T19:00:00.000Z",
            payload: { reason: "user asked to defer" },
          },
        },
      ],
    });
  });
});
