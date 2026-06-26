/** Build a human-readable blocker list from the diagnostic data. */
export function buildBlockers(sections: {
  agentFound: boolean;
  resolutionMissing: string[];
  selectedRule: { id: string } | null;
  rulesInWorkspace: number;
  matchDetails: Array<{
    ruleId: string;
    allMatchesPass: boolean;
    matches: Array<{ kind: string; key: string | null; value: string; wouldMatch: boolean }>;
  }>;
  localRuntime: { isLocal: boolean; machineFound: boolean; endpointReachable: boolean | null } | null;
  codexOAuth?: { applicable: boolean; blockers: string[] };
  claudeCode?: { applicable: boolean; blockers: string[] };
  launcherHealthy: boolean;
}): string[] {
  const blockers: string[] = [];

  if (!sections.agentFound) {
    blockers.push("Agent not found in database");
    return blockers;
  }

  if (sections.rulesInWorkspace === 0) {
    blockers.push("No routing rules exist in this workspace");
  } else if (!sections.selectedRule) {
    if (sections.matchDetails.length === 0) {
      blockers.push("No routing rules have matches that reference this agent");
    } else {
      for (const rule of sections.matchDetails) {
        if (!rule.allMatchesPass) {
          const failedMatches = rule.matches
            .filter((m) => !m.wouldMatch)
            .map((m) => `kind=${m.kind}${m.key ? ` key=${m.key}` : ""} value=${m.value}`)
            .join(", ");
          blockers.push(`Routing rule ${rule.ruleId} matched but matchValue returned false for: ${failedMatches}`);
        }
      }
    }
  }

  for (const req of sections.resolutionMissing) {
    blockers.push(`Execution profile is missing requirement: ${req}`);
  }

  if (sections.localRuntime) {
    if (!sections.localRuntime.machineFound) {
      blockers.push("No registered local runtime relay is connected for this workspace");
    }
    if (sections.localRuntime.endpointReachable === false) {
      blockers.push("The local model endpoint is unreachable (for example Ollama is not running)");
    }
  }

  if (sections.codexOAuth?.applicable) {
    blockers.push(...sections.codexOAuth.blockers);
  }

  if (sections.claudeCode?.applicable) {
    blockers.push(...sections.claudeCode.blockers);
  }

  if (!sections.launcherHealthy) {
    blockers.push("Launcher health check failed — launcher may be down");
  }

  return blockers;
}
