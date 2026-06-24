function normalizeAgentRole(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (["planning", "coding", "manager", "router"].includes(normalized)) {
    return normalized;
  }
  return "custom";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function managerRunnerConfig(config) {
  const runners = config ? config.runners : null;
  if (Array.isArray(runners)) return asObject(runners[0]);
  const runnerMap = asObject(runners);
  return asObject(runnerMap?.manager);
}

function summarizeRunner(runner) {
  if (!runner) return null;
  return {
    kind: typeof runner.kind === "string" ? runner.kind : null,
    provider: typeof runner.provider === "string" ? runner.provider : null,
    model: typeof runner.model === "string" ? runner.model : null,
    hasToolDefinitions: Array.isArray(runner.tool_definitions),
  };
}

function summarizeExecutionProfile(profile) {
  if (!profile) return null;
  return {
    runnerKind:
      typeof profile.runner_kind === "string" ? profile.runner_kind : null,
    provider: typeof profile.provider === "string" ? profile.provider : null,
    model: typeof profile.model === "string" ? profile.model : null,
    toolProfile:
      typeof profile.tool_profile === "string" ? profile.tool_profile : null,
    hasToolDefinitions: Array.isArray(profile.tool_definitions),
    adapterConfig: summarizeObject(asObject(profile.adapter_config)),
    sourceMetadata: summarizeObject(asObject(profile.source_metadata)),
  };
}

function summarizeObject(value) {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
        ? entry
        : entry == null
          ? null
          : "[object]",
    ]),
  );
}

function metadataMatches(matches) {
  const metadata = {};
  for (const match of matches) {
    const kind =
      typeof match.kind === "string" ? match.kind.trim().toLowerCase() : "";
    if (!isRoutingMetadataMatch(match)) continue;
    metadata[kind] =
      typeof match.value === "string" ? match.value.trim() : match.value;
  }
  return metadata;
}

function isRoutingMetadataMatch(match) {
  const kind =
    typeof match.kind === "string" ? match.kind.trim().toLowerCase() : "";
  return (
    kind === "local_endpoint" ||
    kind === "local_workspace_root" ||
    kind === "local_machine" ||
    kind === "local_model_capability"
  );
}

function matchValue(input, match) {
  const kind =
    typeof match.kind === "string" ? match.kind.trim().toLowerCase() : "";
  const key = typeof match.key === "string" ? match.key.trim() : "";
  const value = typeof match.value === "string" ? match.value.trim() : "";
  if (isRoutingMetadataMatch(match)) return true;
  if (kind === "agent_id") {
    return (
      (!key || key === "id" || key === "agent_id") && value === input.agent.id
    );
  }
  if (kind === "agent_type" || kind === "role") {
    return (!key || key === "type") && value === input.role;
  }
  if (kind === "intent") return false;
  return false;
}

function selectRoutingRule({ agent, role, rules, matches }) {
  const matchesByRule = new Map();
  for (const match of matches) {
    const existing = matchesByRule.get(match.rule_id) ?? [];
    existing.push(match);
    matchesByRule.set(match.rule_id, existing);
  }

  const candidates = rules
    .map((rule, index) => {
      const ruleMatches = matchesByRule.get(rule.id) ?? [];
      const predicateMatches = ruleMatches.filter(
        (match) => !isRoutingMetadataMatch(match),
      );
      const matched = ruleMatches.every((match) =>
        matchValue({ agent, role }, match),
      );
      return { index, matched, predicateMatches, rule };
    })
    .filter((candidate) => candidate.matched);

  candidates.sort((left, right) => {
    const priorityDelta =
      Number(right.rule.priority ?? 0) - Number(left.rule.priority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;

    const specificityDelta =
      right.predicateMatches.length - left.predicateMatches.length;
    if (specificityDelta !== 0) return specificityDelta;

    const localCodingDelta =
      Number(right.rule.runner_kind === "local_model_coding") -
      Number(left.rule.runner_kind === "local_model_coding");
    if (localCodingDelta !== 0) return localCodingDelta;

    return left.index - right.index;
  });

  return candidates[0]?.rule ?? null;
}

const localManagerRunnerKinds = new Set([
  "llm_tool_runner",
  "manager",
  "local_relay",
]);

export async function loadResolvedTools({
  agentId,
  workspaceId,
  postgrestGet,
}) {
  const [agent, grants, globalTools, workspaceTools] = await Promise.all([
    postgrestGet("agent", {
      select: "id,workspace_id",
      id: `eq.${agentId}`,
      limit: "1",
    }),
    postgrestGet("agent_tool_grant", {
      select: "id,agent_id,workspace_id,tool_id,mode,source",
      agent_id: `eq.${agentId}`,
      workspace_id: `eq.${workspaceId}`,
    }),
    postgrestGet("tool", {
      select:
        "id,workspace_id,slug,name,description,function_name,execution_kind,runner_kind,enabled",
      workspace_id: "is.null",
    }),
    postgrestGet("tool", {
      select:
        "id,workspace_id,slug,name,description,function_name,execution_kind,runner_kind,enabled",
      workspace_id: `eq.${workspaceId}`,
    }),
  ]);
  if (agent.length === 0) throw new Error(`Agent not found: ${agentId}`);

  const toolsById = new Map(
    [...globalTools, ...workspaceTools].map((tool) => [tool.id, tool]),
  );
  return grants
    .filter((grant) => grant.mode !== "exclude")
    .map((grant) => toolsById.get(grant.tool_id))
    .filter(Boolean)
    .filter((tool) => tool.enabled !== false)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function loadManagerRuntimePreflight({
  agentId,
  workspaceId,
  expectedToolSlugs = [],
  mode = "manager",
  postgrestGet,
}) {
  const [agentRows, gatewayConfigRows, routingRules, resolvedTools] =
    await Promise.all([
      postgrestGet("agent", {
        select: "id,workspace_id,type,model_settings,tool_policy",
        id: `eq.${agentId}`,
        limit: "1",
      }),
      postgrestGet("gateway_config", {
        select: "id,scope_type,scope_id,version,config_json,updated_at",
        scope_type: "eq.agent",
        scope_id: `eq.${agentId}`,
        order: "version.desc",
        limit: "1",
      }),
      postgrestGet("routing_rule", {
        select:
          "id,name,workspace_id,priority,runner_kind,provider,model,credential_id,credential_alias,enabled,created_at,model_tier_floor",
        workspace_id: `eq.${workspaceId}`,
        enabled: "eq.true",
        order: "priority.desc,created_at.asc",
      }),
      loadResolvedTools({ agentId, workspaceId, postgrestGet }),
    ]);

  const agent = agentRows[0] ?? null;
  const ruleIds = routingRules.map((rule) => rule.id).filter(Boolean);
  const routingMatches =
    ruleIds.length === 0
      ? []
      : await postgrestGet("routing_rule_match", {
          select: "rule_id,kind,key,value",
          workspace_id: `eq.${workspaceId}`,
          rule_id: `in.(${ruleIds.join(",")})`,
        });
  const selectedRule = agent
    ? selectRoutingRule({
        agent,
        role: normalizeAgentRole(agent.type),
        rules: routingRules,
        matches: routingMatches,
      })
    : null;
  const selectedRuleMatches = selectedRule
    ? routingMatches.filter((match) => match.rule_id === selectedRule.id)
    : [];
  const gatewayConfig = gatewayConfigRows[0] ?? null;
  const gatewayConfigJson = asObject(gatewayConfig?.config_json);
  const gatewayManagerRunner = managerRunnerConfig(gatewayConfigJson);
  const gatewayExecutionProfile = asObject(
    gatewayConfigJson?.execution_profile,
  );
  const routingMetadata = metadataMatches(selectedRuleMatches);
  const resolvedToolSlugs = resolvedTools.map((tool) => tool.slug).sort();
  const expectedSlugs = Array.from(new Set(expectedToolSlugs)).sort();
  const failures = [];
  const warnings = [];
  const managerMode = mode === "manager";

  if (!agent) {
    failures.push(`Agent not found: ${agentId}`);
  } else if (agent.workspace_id !== workspaceId) {
    failures.push(
      `Agent workspace mismatch: agent.workspace_id=${agent.workspace_id}, expected ${workspaceId}`,
    );
  }

  if (!managerMode) {
    warnings.push(
      `manager-specific gateway_config checks skipped for ${mode} preflight`,
    );
  } else if (!gatewayConfig) {
    failures.push(`gateway_config missing for manager agent ${agentId}`);
  } else {
    if (!gatewayConfigJson) {
      failures.push("gateway_config.config_json is not an object");
    }
    if (!gatewayManagerRunner && !gatewayExecutionProfile) {
      failures.push(
        "gateway_config.config_json has neither runners.manager nor execution_profile",
      );
    }
    if (!asObject(gatewayConfigJson?.tracker)?.kind) {
      failures.push("gateway_config.config_json.tracker.kind is missing");
    }
    if (!asObject(gatewayConfigJson?.workflow_template)?.id) {
      failures.push(
        "gateway_config.config_json.workflow_template.id is missing",
      );
    }
  }

  if (!selectedRule) {
    failures.push(`No enabled routing_rule matches agent ${agentId}`);
  } else {
    if (managerMode && !localManagerRunnerKinds.has(selectedRule.runner_kind)) {
      failures.push(
        `Selected routing_rule.runner_kind=${selectedRule.runner_kind} is not a local manager runner`,
      );
    }
    if (selectedRule.provider !== "local") {
      failures.push(
        `Selected routing_rule.provider=${selectedRule.provider} is not local`,
      );
    }
    if (!selectedRule.model) {
      failures.push("Selected routing_rule.model is missing");
    }
    if (!routingMetadata.local_machine) {
      if (routingMetadata.local_endpoint) {
        warnings.push(
          "Selected routing_rule has local_endpoint but no local_machine metadata",
        );
      } else {
        failures.push(
          "Selected routing_rule is missing local_endpoint or local_machine routing metadata",
        );
      }
    }
  }

  if (managerMode && gatewayManagerRunner) {
    if (
      selectedRule?.provider &&
      gatewayManagerRunner.provider &&
      gatewayManagerRunner.provider !== selectedRule.provider
    ) {
      failures.push(
        `gateway_config runners.manager.provider=${gatewayManagerRunner.provider} does not match selected route provider=${selectedRule.provider}`,
      );
    }
    if (
      selectedRule?.model &&
      gatewayManagerRunner.model &&
      gatewayManagerRunner.model !== selectedRule.model
    ) {
      warnings.push(
        `gateway_config runners.manager.model=${gatewayManagerRunner.model} differs from selected route model=${selectedRule.model}`,
      );
    }
  }

  if (managerMode && gatewayExecutionProfile) {
    if (
      selectedRule?.provider &&
      gatewayExecutionProfile.provider &&
      gatewayExecutionProfile.provider !== selectedRule.provider
    ) {
      failures.push(
        `gateway_config execution_profile.provider=${gatewayExecutionProfile.provider} does not match selected route provider=${selectedRule.provider}`,
      );
    }
    if (
      selectedRule?.model &&
      gatewayExecutionProfile.model &&
      gatewayExecutionProfile.model !== selectedRule.model
    ) {
      warnings.push(
        `gateway_config execution_profile.model=${gatewayExecutionProfile.model} differs from selected route model=${selectedRule.model}`,
      );
    }
  } else if (managerMode) {
    warnings.push("gateway_config.config_json.execution_profile is missing");
  }

  for (const slug of expectedSlugs) {
    if (!resolvedToolSlugs.includes(slug)) {
      failures.push(`Expected tool is not resolved for manager: ${slug}`);
    }
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    warnings,
    mode,
    agent: agent
      ? {
          id: agent.id,
          workspaceId: agent.workspace_id,
          type: agent.type,
        }
      : null,
    gatewayConfig: gatewayConfig
      ? {
          id: gatewayConfig.id,
          version: gatewayConfig.version,
          updatedAt: gatewayConfig.updated_at,
          hasExecutionProfile: Boolean(gatewayExecutionProfile),
          hasManagerRunner: Boolean(gatewayManagerRunner),
          trackerKind: asObject(gatewayConfigJson?.tracker)?.kind ?? null,
          workflowTemplateId:
            asObject(gatewayConfigJson?.workflow_template)?.id ?? null,
          managerRunner: summarizeRunner(gatewayManagerRunner),
          executionProfile: summarizeExecutionProfile(gatewayExecutionProfile),
        }
      : null,
    routing: {
      selectedRule: selectedRule
        ? {
            id: selectedRule.id,
            name: selectedRule.name,
            priority: selectedRule.priority,
            runnerKind: selectedRule.runner_kind,
            provider: selectedRule.provider,
            model: selectedRule.model,
            modelTierFloor: selectedRule.model_tier_floor,
          }
        : null,
      selectedRuleMatches: selectedRuleMatches.map((match) => ({
        kind: match.kind,
        key: match.key,
        value: match.value,
      })),
      metadata: routingMetadata,
      enabledRuleCount: routingRules.length,
    },
    resolvedTools: resolvedToolSlugs,
    expectedToolSlugs: expectedSlugs,
  };
}
