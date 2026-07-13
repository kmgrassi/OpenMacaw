import type { Tables } from "@kmgrassi/supabase-schema";

import { isLocalRunnerKind } from "../../../../../contracts/runner-kinds.js";
import type { WorkerBridgeSessionRow } from "../../../../../contracts/worker-bridge.js";
import { logEvent } from "../../logger.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";
import { isRoutingMetadataMatch, matchValue, resolveExecutionProfile } from "../execution-profile-resolver.js";
import { resolveSessionPolicies } from "../policy-resolver.js";
import { buildBlockers } from "./blockers.js";
import { buildClaudeCodeDiagnostic, selectClaudeBridgeSession } from "./claude-code.js";
import { buildCodexOAuthDiagnostic, selectCodexBridgeSession } from "./codex-oauth.js";
import { probeOllamaEndpoint } from "./ollama.js";
import { loadWorkItemSnoozeDiagnostic } from "./work-item-snooze.js";
import { listSavedCredentialsForAgentFromSupabase, type ResolvedSavedCredential } from "../saved-credentials.js";

function isLocalExecutionProfile(profile: { runnerKind: string | null; provider: string | null } | null): boolean {
  if (!profile?.runnerKind) return false;
  return isLocalRunnerKind(profile.runnerKind) || (profile.runnerKind === "planner" && profile.provider === "local");
}

type LocalRuntimeMachineDiagnosticRow = Pick<Tables<"local_runtime_machine">, "id" | "display_name">;

export async function loadAgentDiagnostic(input: {
  agentId: string;
  workspaceId: string | null;
  workItemId: string | null;
}) {
  const { agentId, workItemId } = input;
  const workspaceIdParam = input.workspaceId;

  const supabase = getServiceRoleSupabase();

  // -----------------------------------------------------------------
  // Step 1: Agent lookup
  // -----------------------------------------------------------------
  let agentQuery = supabase.from("agent").select("id, workspace_id, name, type, model_settings").eq("id", agentId);
  if (workspaceIdParam) {
    agentQuery = agentQuery.eq("workspace_id", workspaceIdParam);
  }

  const { data: agentRows } = await agentQuery.limit(1);

  const agentRow = (agentRows ?? [])[0] as
    | { id: string; workspace_id: string; name: string | null; type: string | null; model_settings: unknown }
    | undefined;
  const agentFound = Boolean(agentRow);

  const agentSection = {
    found: agentFound,
    name: agentRow?.name ?? null,
    type: agentRow?.type ?? null,
    model_settings: agentRow?.model_settings ?? null,
  };

  // Determine workspaceId — prefer query param, fall back to agent's workspace
  let workspaceId = workspaceIdParam;
  if (!workspaceId && agentFound) {
    workspaceId = agentRow?.workspace_id ?? null;
  }

  if (workspaceIdParam && !agentFound) {
    return {
      timestamp: new Date().toISOString(),
      agentId,
      workspaceId: workspaceIdParam,
      agent: agentSection,
      routing: {
        rulesInWorkspace: 0,
        matchesForAgent: [],
        selectedRule: null,
        selectionReason: "agent not found in workspace",
      },
      executionProfile: {
        resolved: false,
        missing: ["agent_not_found"],
        profile: null,
        source: {
          routingRuleId: null,
          fallbackUsed: false,
          legacyGatewayConfigUsed: false,
        },
      },
      policies: {
        resolved: false,
        workspacePolicies: [],
        agentPolicies: [],
        sessionPolicies: [],
        effectivePolicies: [],
        error: "agent not found in workspace",
      },
      localRuntime: null,
      codexOAuth: null,
      claudeCode: null,
      workItems: {
        found: false,
        snoozed: false,
      },
      launcher: {
        healthy: false,
        agentRegistered: false,
      },
      canChat: false,
      blockers: ["Agent not found in authorized workspace"],
    };
  }

  // -----------------------------------------------------------------
  // Step 2: Routing rules
  // -----------------------------------------------------------------
  let rulesInWorkspace = 0;
  type MatchDetail = {
    ruleId: string;
    ruleName: string | null;
    runnerKind: string | null;
    provider: string | null;
    model: string | null;
    matches: Array<{ kind: string; key: string | null; value: string; wouldMatch: boolean }>;
    allMatchesPass: boolean;
  };
  const matchesForAgent: MatchDetail[] = [];
  let selectedRuleInfo: { id: string; runnerKind: string; model: string } | null = null;
  let selectionReason = "no workspace";

  if (workspaceId) {
    // Fetch all enabled rules for workspace
    const { data: rules } = await supabase
      .from("routing_rule")
      .select("id, name, runner_kind, provider, model, priority, enabled")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .order("priority", { ascending: false });

    const ruleRows = (rules ?? []) as Array<{
      id: string;
      name: string;
      runner_kind: string;
      provider: string | null;
      model: string | null;
      priority: number;
      enabled: boolean;
    }>;
    rulesInWorkspace = ruleRows.length;

    if (ruleRows.length > 0) {
      // Fetch all matches for these rules
      const ruleIds = ruleRows.map((r) => r.id);
      const { data: allMatches } = await supabase
        .from("routing_rule_match")
        .select("rule_id, kind, key, value")
        .eq("workspace_id", workspaceId)
        .in("rule_id", ruleIds);

      const matchRows = (allMatches ?? []) as Array<{
        rule_id: string;
        kind: string;
        key: string | null;
        value: string;
      }>;

      // Group matches by rule
      const matchesByRule = new Map<string, typeof matchRows>();
      for (const m of matchRows) {
        const existing = matchesByRule.get(m.rule_id) ?? [];
        existing.push(m);
        matchesByRule.set(m.rule_id, existing);
      }

      // Evaluate each rule
      const agentRole = (agentRow?.type?.trim().toLowerCase() ?? "coding") as string;
      const diagnosticMatchInput = {
        agent: { id: agentId },
        role: agentRole === "planning" || agentRole === "manager" || agentRole === "custom" ? agentRole : "coding",
        intent: null,
        intentKey: null,
      } as const;

      for (const rule of ruleRows) {
        const ruleMatches = matchesByRule.get(rule.id) ?? [];
        const evaluatedMatches = ruleMatches.map((m) => {
          const wouldMatch = isRoutingMetadataMatch(m) || matchValue(diagnosticMatchInput, m);
          return { kind: m.kind, key: m.key, value: m.value, wouldMatch };
        });

        const allMatchesPass = evaluatedMatches.every((m) => m.wouldMatch);

        matchesForAgent.push({
          ruleId: rule.id,
          ruleName: rule.name ?? null,
          runnerKind: rule.runner_kind ?? null,
          provider: rule.provider ?? null,
          model: rule.model ?? null,
          matches: evaluatedMatches,
          allMatchesPass,
        });
      }

      // Find the selected rule (first where all matches pass, by priority desc)
      const selected = matchesForAgent.find((r) => r.allMatchesPass);
      if (selected) {
        selectedRuleInfo = {
          id: selected.ruleId,
          runnerKind: selected.runnerKind ?? "",
          model: selected.model ?? "",
        };
        selectionReason = "rule matched";
      } else {
        const hasAnyMatches = matchesForAgent.some((r) => r.matches.length > 0);
        selectionReason = hasAnyMatches
          ? `no rules fully matched — ${matchesForAgent.filter((r) => !r.allMatchesPass && r.matches.length > 0).length} rule(s) had partial match failures`
          : "no rules have matches referencing this agent";
      }
    } else {
      selectionReason = "no rules in workspace";
    }
  }

  const routingSection = {
    rulesInWorkspace,
    matchesForAgent,
    selectedRule: selectedRuleInfo,
    selectionReason,
  };

  // -----------------------------------------------------------------
  // Step 3: Execution profile resolution
  // -----------------------------------------------------------------
  let executionProfileSection: {
    resolved: boolean;
    missing: string[];
    profile: {
      runnerKind: string | null;
      provider: string | null;
      model: string | null;
      credentialRef: unknown;
      toolProfile: string | null;
    } | null;
    source: {
      routingRuleId: string | null;
      fallbackUsed: boolean;
      legacyGatewayConfigUsed: boolean;
    };
  };

  try {
    const resolution = await resolveExecutionProfile({
      agentId,
      skipCredentialCheck: true,
    });

    executionProfileSection = {
      resolved: resolution.missing.length === 0,
      missing: resolution.missing,
      profile: resolution.profile
        ? {
            runnerKind: resolution.profile.runnerKind,
            provider: resolution.profile.provider,
            model: resolution.profile.model,
            credentialRef: resolution.profile.credentialRef,
            toolProfile: resolution.profile.toolProfile,
          }
        : null,
      source: {
        routingRuleId: resolution.source.routingRuleId,
        fallbackUsed: resolution.source.fallbackUsed,
        legacyGatewayConfigUsed: resolution.source.legacyGatewayConfigUsed,
      },
    };
  } catch (error) {
    executionProfileSection = {
      resolved: false,
      missing: [error instanceof Error ? error.message : String(error)],
      profile: null,
      source: { routingRuleId: null, fallbackUsed: false, legacyGatewayConfigUsed: false },
    };
  }

  let policiesSection: {
    resolved: boolean;
    workspacePolicies: unknown[];
    agentPolicies: unknown[];
    sessionPolicies: unknown[];
    effectivePolicies: unknown[];
    error: string | null;
  } = {
    resolved: false,
    workspacePolicies: [],
    agentPolicies: [],
    sessionPolicies: [],
    effectivePolicies: [],
    error: workspaceId ? null : "no workspace",
  };

  if (workspaceId) {
    try {
      const policyResolution = await resolveSessionPolicies({
        agentId,
        workspaceId,
        supabase,
      });
      policiesSection = {
        resolved: true,
        workspacePolicies: policyResolution.workspacePolicies,
        agentPolicies: policyResolution.agentPolicies,
        sessionPolicies: policyResolution.sessionPolicies,
        effectivePolicies: policyResolution.effectivePolicies,
        error: null,
      };
    } catch (error) {
      policiesSection = {
        resolved: false,
        workspacePolicies: [],
        agentPolicies: [],
        sessionPolicies: [],
        effectivePolicies: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -----------------------------------------------------------------
  // Step 4: Local runtime status
  // -----------------------------------------------------------------
  const resolvedRunnerKind = executionProfileSection.profile?.runnerKind ?? selectedRuleInfo?.runnerKind ?? null;
  const isLocal =
    isLocalExecutionProfile(executionProfileSection.profile) ||
    (resolvedRunnerKind ? isLocalRunnerKind(resolvedRunnerKind) : false);
  let localRuntimeSection: {
    isLocal: boolean;
    machineFound: boolean;
    machineId: string | null;
    machineDisplayName: string | null;
    endpoint: string | null;
    endpointReachable: boolean | null;
    ollamaModels: string[] | null;
    relayHelper: {
      registered: boolean;
      machineId: string | null;
      displayName: string | null;
    };
    modelEndpoint: {
      url: string | null;
      reachable: boolean | null;
      ollamaModels: string[] | null;
    };
  } | null = null;

  if (isLocal && workspaceId) {
    const machines = await executeSupabaseRows<LocalRuntimeMachineDiagnosticRow>(
      "local runtime machine diagnostic query",
      supabase
        .from("local_runtime_machine")
        .select("id,display_name")
        .eq("workspace_id", workspaceId)
        .is("revoked_at", null)
        .limit(1),
    );

    const machine = machines[0];

    // Try to extract endpoint from machine display_name (format: "model@host:port")
    let endpoint: string | null = null;
    if (machine?.display_name) {
      const atIndex = machine.display_name.indexOf("@");
      if (atIndex >= 0) {
        const host = machine.display_name.slice(atIndex + 1);
        endpoint = host.startsWith("http") ? host : `http://${host}`;
      }
    }

    let endpointReachable: boolean | null = null;
    let ollamaModels: string[] | null = null;

    if (endpoint) {
      const probe = await probeOllamaEndpoint(endpoint);
      endpointReachable = probe.reachable;
      ollamaModels = probe.models;
    }

    localRuntimeSection = {
      isLocal: true,
      machineFound: Boolean(machine),
      machineId: machine?.id ?? null,
      machineDisplayName: machine?.display_name ?? null,
      endpoint,
      endpointReachable,
      ollamaModels,
      relayHelper: {
        registered: Boolean(machine),
        machineId: machine?.id ?? null,
        displayName: machine?.display_name ?? null,
      },
      modelEndpoint: {
        url: endpoint,
        reachable: endpointReachable,
        ollamaModels,
      },
    };
  } else {
    localRuntimeSection = isLocal
      ? {
          isLocal: true,
          machineFound: false,
          machineId: null,
          machineDisplayName: null,
          endpoint: null,
          endpointReachable: null,
          ollamaModels: null,
          relayHelper: {
            registered: false,
            machineId: null,
            displayName: null,
          },
          modelEndpoint: {
            url: null,
            reachable: null,
            ollamaModels: null,
          },
        }
      : null;
  }

  // -----------------------------------------------------------------
  // Step 5: Launcher health
  // -----------------------------------------------------------------
  let launcherHealthy = false;
  let agentRegistered = false;
  let workerBridgeSessions: WorkerBridgeSessionRow[] = [];
  const launcherBaseUrl = (process.env.LAUNCHER_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");

  try {
    const healthRes = await fetch(`${launcherBaseUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    launcherHealthy = healthRes.ok;
  } catch {
    launcherHealthy = false;
  }

  if (launcherHealthy) {
    try {
      const agentRes = await fetch(`${launcherBaseUrl}/agents/${encodeURIComponent(agentId)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      agentRegistered = agentRes.ok;
    } catch {
      agentRegistered = false;
    }
  }

  if (launcherHealthy) {
    try {
      const sessionsRes = await fetch(`${launcherBaseUrl}/worker-bridge/sessions`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (sessionsRes.ok) {
        const body = (await sessionsRes.json()) as { data?: WorkerBridgeSessionRow[] };
        workerBridgeSessions = Array.isArray(body.data) ? body.data : [];
      }
    } catch {
      workerBridgeSessions = [];
    }
  }

  const launcherSection = {
    healthy: launcherHealthy,
    agentRegistered,
  };

  const claudeCodeSection = buildClaudeCodeDiagnostic({
    requestedRunnerKind: selectedRuleInfo?.runnerKind ?? null,
    executionProfile: executionProfileSection,
    launcherHealthy,
    bridgeSession: selectClaudeBridgeSession(workerBridgeSessions, {
      agentId,
      workspaceId: workspaceId ?? null,
    }),
  });

  let savedCredentials: ResolvedSavedCredential[] = [];
  if (workspaceId) {
    try {
      savedCredentials = await listSavedCredentialsForAgentFromSupabase(agentId, workspaceId);
    } catch {
      savedCredentials = [];
    }
  }

  const codexOAuthSection = buildCodexOAuthDiagnostic({
    requestedRunnerKind: selectedRuleInfo?.runnerKind ?? null,
    executionProfile: executionProfileSection,
    launcherHealthy,
    bridgeSession: selectCodexBridgeSession(workerBridgeSessions, {
      agentId,
      workspaceId: workspaceId ?? null,
    }),
    credentials: savedCredentials,
  });

  const workItemsSection = await loadWorkItemSnoozeDiagnostic({
    workspaceId: workspaceId ?? null,
    workItemId,
  });

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  const blockers = buildBlockers({
    agentFound,
    resolutionMissing: executionProfileSection.missing,
    selectedRule: selectedRuleInfo,
    rulesInWorkspace,
    matchDetails: matchesForAgent,
    localRuntime: localRuntimeSection,
    codexOAuth: codexOAuthSection,
    claudeCode: claudeCodeSection,
    launcherHealthy,
  });

  const canChat = agentFound && executionProfileSection.resolved && blockers.length === 0;

  logEvent({
    event: "agent_diagnostic",
    level: "info",
    agent_id: agentId,
    workspace_id: workspaceId,
    can_chat: canChat,
    blocker_count: blockers.length,
  });

  return {
    timestamp: new Date().toISOString(),
    agentId,
    workspaceId: workspaceId ?? null,
    agent: agentSection,
    routing: routingSection,
    executionProfile: executionProfileSection,
    policies: policiesSection,
    localRuntime: localRuntimeSection,
    codexOAuth: codexOAuthSection,
    claudeCode: claudeCodeSection,
    workItems: workItemsSection,
    launcher: launcherSection,
    canChat,
    blockers,
  };
}
