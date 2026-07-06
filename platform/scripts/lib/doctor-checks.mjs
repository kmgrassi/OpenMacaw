import fs from "node:fs";
import path from "node:path";

import {
  classifyPlatformFailure,
  findLocalEnvFile,
  hasEnvValue,
  loadRedactedEnv,
  probeHttpJson,
  probePort,
  readRecentLogInfo,
  workspaceDependencyStatus,
} from "./platform-probes.mjs";
import {
  apiPortTarget,
  authHeaders,
  compactJson,
  firstString,
} from "./doctor-config.mjs";

function lastFailureFromDiagnostic(diagnostic) {
  const claudeBridge = diagnostic?.claudeCode?.runtimeBridge?.lastFailure;
  return (
    diagnostic?.lastFailure ??
    diagnostic?.health?.lastFailure ??
    claudeBridge ??
    null
  );
}

function summarizeDiagnostic(diagnostic) {
  const profile = diagnostic?.executionProfile?.profile ?? null;
  const localRuntime = diagnostic?.localRuntime ?? null;

  return {
    canChat: diagnostic?.canChat ?? null,
    blockers: Array.isArray(diagnostic?.blockers) ? diagnostic.blockers : [],
    runnerKind: firstString(
      profile?.runnerKind,
      diagnostic?.routing?.selectedRule?.runnerKind,
    ),
    provider: firstString(profile?.provider),
    executionTarget: localRuntime
      ? {
          kind: "local_runtime",
          relayHelperRegistered:
            localRuntime.relayHelper?.registered ??
            localRuntime.machineFound ??
            null,
          modelEndpointReachable:
            localRuntime.modelEndpoint?.reachable ??
            localRuntime.endpointReachable ??
            null,
          modelEndpointUrl:
            localRuntime.modelEndpoint?.url ?? localRuntime.endpoint ?? null,
        }
      : null,
    credential: {
      resolved: Boolean(profile?.credentialRef),
      refType: profile?.credentialRef?.type ?? null,
    },
    executionProfile: {
      resolved: diagnostic?.executionProfile?.resolved ?? null,
      missing: Array.isArray(diagnostic?.executionProfile?.missing)
        ? diagnostic.executionProfile.missing
        : [],
      source: diagnostic?.executionProfile?.source ?? null,
    },
    launcherHealth: diagnostic?.launcher?.healthy ?? null,
    localHelperReady:
      localRuntime?.relayHelper?.registered ??
      localRuntime?.machineFound ??
      null,
    runtimeHealth: localRuntime
      ? {
          isLocal: localRuntime.isLocal ?? true,
          endpointReachable:
            localRuntime.modelEndpoint?.reachable ??
            localRuntime.endpointReachable ??
            null,
        }
      : null,
    lastFailure: lastFailureFromDiagnostic(diagnostic),
  };
}

function summarizeAgentHealth(health) {
  return {
    status: health?.status ?? null,
    launcherHealth: health?.launcher?.reachable ?? null,
    runtimeHealth: health?.runtime?.state ?? null,
    lastFailure: health?.lastFailure ?? null,
  };
}

function summarizeRuntimeHealth(runtimeHealth) {
  const target = runtimeHealth?.runtimeTarget ?? null;
  return {
    ok: runtimeHealth?.ok ?? null,
    executionTarget: target
      ? {
          agentId: target.agentId ?? null,
          host: target.host ?? null,
          port: target.port ?? null,
          instanceId: target.instanceId ?? null,
        }
      : null,
    launcherHealth: runtimeHealth?.launcherHealth ?? null,
    runtimeHealth: runtimeHealth?.orchestratorHealth ?? null,
  };
}

function relative(rootDir, filePath) {
  return path.relative(rootDir, filePath) || ".";
}

function createAddCheck(checks) {
  return (check) => {
    checks.push({
      status: check.status,
      name: check.name,
      summary: check.summary,
      details: check.details ?? undefined,
    });
  };
}

function checkEnv(rootDir, addCheck) {
  const rootEnvPath = path.join(rootDir, ".env");
  const activeEnvPath = findLocalEnvFile(rootDir);
  const activeEnv = activeEnvPath ? loadRedactedEnv(activeEnvPath) : null;
  const requiredApiKeys = [
    "SUPABASE_URL",
    "SUPABASE_PROJECT_ID",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missingApiKeys = requiredApiKeys.filter(
    (key) => !activeEnv || !hasEnvValue(activeEnv, key),
  );

  if (!activeEnv) {
    addCheck({
      status: "fail",
      name: "api env",
      summary:
        ".env is missing; pnpm run dev reads repo-root .env or a sibling worktree .env",
      details: {
        envFile: relative(rootDir, rootEnvPath),
        requiredKeys: requiredApiKeys,
      },
    });
  } else if (missingApiKeys.length > 0) {
    addCheck({
      status: "fail",
      name: "api env",
      summary: `${relative(rootDir, activeEnvPath)} is missing ${missingApiKeys.join(", ")}`,
      details: {
        envFile: relative(rootDir, activeEnvPath),
        requiredKeys: requiredApiKeys,
        missingKeys: missingApiKeys,
        presentKeys: requiredApiKeys.filter((key) =>
          hasEnvValue(activeEnv, key),
        ),
      },
    });
  } else {
    addCheck({
      status: "ok",
      name: "api env",
      summary: `${relative(rootDir, activeEnvPath)} contains ${requiredApiKeys.join(", ")}`,
      details: {
        envFile: relative(rootDir, activeEnvPath),
        presentKeys: requiredApiKeys,
      },
    });
  }

  const devLoginKeys = ["VITE_DEV_LOGIN_EMAIL", "VITE_DEV_LOGIN_PASSWORD"];
  const missingDevLoginKeys = devLoginKeys.filter(
    (key) => !activeEnv || !hasEnvValue(activeEnv, key),
  );

  if (!activeEnv) {
    addCheck({
      status: "fail",
      name: "web env",
      summary:
        ".env is missing; Vite dev env is loaded from repo-root .env or a sibling worktree .env",
      details: {
        envFile: relative(rootDir, rootEnvPath),
        expectedKeys: devLoginKeys,
      },
    });
  } else if (missingDevLoginKeys.length > 0) {
    addCheck({
      status: "fail",
      name: "web env",
      summary: `${relative(rootDir, activeEnvPath)} is missing dev login keys ${missingDevLoginKeys.join(", ")}`,
      details: {
        envFile: relative(rootDir, activeEnvPath),
        expectedKeys: devLoginKeys,
        missingKeys: missingDevLoginKeys,
      },
    });
  } else {
    addCheck({
      status: "ok",
      name: "web env",
      summary: "dev login variables available",
      details: {
        envFile: relative(rootDir, activeEnvPath),
        presentKeys: devLoginKeys,
      },
    });
  }
}

function checkDependencies(rootDir, addCheck) {
  const deps = workspaceDependencyStatus(rootDir);

  if (deps.ok) {
    addCheck({
      status: "ok",
      name: "deps",
      summary: "node_modules exists and root packages resolve",
      details: {
        nodeModulesPath: relative(rootDir, deps.nodeModulesPath),
        lockfilePath: relative(rootDir, deps.lockfilePath),
        resolvedPackages: deps.resolvedPackages.map((item) => item.name),
      },
    });
    return;
  }

  const blockers = [];
  if (!deps.lockfileExists) {
    blockers.push("pnpm-lock.yaml missing");
  }
  if (!deps.nodeModulesExists) {
    blockers.push("node_modules missing");
  }
  if (deps.missingPackages.length > 0) {
    blockers.push(`missing packages: ${deps.missingPackages.join(", ")}`);
  }

  addCheck({
    status: "fail",
    name: "deps",
    summary: blockers.join("; "),
    details: {
      nodeModulesPath: relative(rootDir, deps.nodeModulesPath),
      lockfilePath: relative(rootDir, deps.lockfilePath),
      missingPackages: deps.missingPackages,
    },
  });
}

async function checkService({ name, label, port, endpoints, addCheck }) {
  const portProbe = await probePort("127.0.0.1", port);

  if (!portProbe.ok) {
    addCheck({
      status: "fail",
      name,
      summary: `http://127.0.0.1:${port} connection failed (${portProbe.error})`,
      details: { port, reachable: false, error: portProbe.error },
    });
    return;
  }

  for (const endpoint of endpoints) {
    const url = `http://127.0.0.1:${port}${endpoint}`;
    const response = await probeHttpJson(url);

    if (!response.ok) {
      addCheck({
        status: "fail",
        name,
        summary:
          response.status === null
            ? `${url} failed (${response.error})`
            : `${url} returned ${response.status}`,
        details: response,
      });
      return;
    }
  }

  addCheck({
    status: "ok",
    name,
    summary: `${label} port ${port} reachable${endpoints.length ? ` and ${endpoints.join(", ")} returned 2xx` : ""}`,
    details: { port, endpoints },
  });
}

async function checkApiService(args, addCheck) {
  const apiTarget = apiPortTarget(args.apiBaseUrl);
  const portProbe = await probePort(apiTarget.host, apiTarget.port);

  if (!portProbe.ok) {
    addCheck({
      status: "fail",
      name: "api",
      summary: `${apiTarget.host}:${apiTarget.port} connection failed (${portProbe.error})`,
      details: {
        apiBaseUrl: args.apiBaseUrl,
        host: apiTarget.host,
        port: apiTarget.port,
        reachable: false,
        error: portProbe.error,
      },
    });
    return;
  }

  const livez = await probeHttpJson(`${args.apiBaseUrl}/livez`);

  if (!livez.ok) {
    addCheck({
      status: "fail",
      name: "api",
      summary:
        livez.status === null
          ? `${args.apiBaseUrl}/livez failed (${livez.error})`
          : `${args.apiBaseUrl}/livez returned ${livez.status}`,
      details: livez,
    });
    return;
  }

  addCheck({
    status: "ok",
    name: "api",
    summary: `${apiTarget.host}:${apiTarget.port} reachable and /livez returned 2xx`,
    details: {
      apiBaseUrl: args.apiBaseUrl,
      host: apiTarget.host,
      port: apiTarget.port,
      livez,
    },
  });
}

function checkLogs(rootDir, addCheck) {
  const logDir = path.join(rootDir, ".run-logs");
  const apiLog = readRecentLogInfo(path.join(logDir, "api.log"));
  const webLog = readRecentLogInfo(path.join(logDir, "web.log"));
  const maxAgeSeconds = 10 * 60;
  const missing = [apiLog, webLog].filter((log) => !log.exists);
  const stale = [apiLog, webLog].filter(
    (log) => log.exists && (log.size === 0 || log.ageSeconds > maxAgeSeconds),
  );

  if (!fs.existsSync(logDir)) {
    addCheck({
      status: "fail",
      name: "logs",
      summary: ".run-logs is missing",
      details: { logDir: relative(rootDir, logDir) },
    });
  } else if (missing.length > 0 || stale.length > 0) {
    addCheck({
      status: "fail",
      name: "logs",
      summary: "API and web logs are missing, empty, or older than 10 minutes",
      details: {
        logDir: relative(rootDir, logDir),
        apiLog: { ...apiLog, path: relative(rootDir, apiLog.path) },
        webLog: { ...webLog, path: relative(rootDir, webLog.path) },
      },
    });
  } else {
    addCheck({
      status: "ok",
      name: "logs",
      summary: ".run-logs has recent API and web writes",
      details: {
        logDir: relative(rootDir, logDir),
        apiLog: { ...apiLog, path: relative(rootDir, apiLog.path) },
        webLog: { ...webLog, path: relative(rootDir, webLog.path) },
      },
    });
  }
}

async function checkAgentScope(args, addCheck) {
  if (!args.agentId && !args.workspaceId) {
    addCheck({
      status: "skip",
      name: "agent",
      summary: "pass --agent-id and --workspace-id for scoped diagnostics",
    });
    return;
  }

  if (!args.agentId || !args.workspaceId) {
    addCheck({
      status: "fail",
      name: "agent",
      summary:
        "both --agent-id and --workspace-id are required for scoped diagnostics",
      details: { agentId: args.agentId, workspaceId: args.workspaceId },
    });
    return;
  }

  const diagnosticUrl = new URL(
    `/api/diagnostic/agents/${encodeURIComponent(args.agentId)}`,
    args.apiBaseUrl,
  );
  diagnosticUrl.searchParams.set("workspaceId", args.workspaceId);
  const diagnostic = await probeHttpJson(diagnosticUrl.href, {
    timeoutMs: 8000,
  });

  const agentHealthUrl = new URL(
    `/api/agents/${encodeURIComponent(args.agentId)}/health`,
    args.apiBaseUrl,
  );
  const agentHealth = await probeHttpJson(agentHealthUrl.href, {
    timeoutMs: 8000,
    headers: authHeaders(args.token),
  });

  const runtimeHealthUrl = new URL("/health", args.apiBaseUrl);
  runtimeHealthUrl.searchParams.set("agentId", args.agentId);
  const runtimeHealth = await probeHttpJson(runtimeHealthUrl.href, {
    timeoutMs: 8000,
  });

  const diagnosticSummary = diagnostic.ok
    ? summarizeDiagnostic(diagnostic.json)
    : null;
  const agentHealthSummary = agentHealth.ok
    ? summarizeAgentHealth(agentHealth.json)
    : null;
  const runtimeHealthSummary = runtimeHealth.ok
    ? summarizeRuntimeHealth(runtimeHealth.json)
    : null;
  const agentSummary = {
    agentId: args.agentId,
    workspaceId: args.workspaceId,
    canChat: diagnosticSummary?.canChat ?? null,
    blockers: diagnosticSummary?.blockers ?? [],
    runnerKind: diagnosticSummary?.runnerKind ?? null,
    provider: diagnosticSummary?.provider ?? null,
    executionTarget:
      runtimeHealthSummary?.executionTarget ??
      diagnosticSummary?.executionTarget ??
      null,
    credential: diagnosticSummary?.credential ?? null,
    executionProfile: diagnosticSummary?.executionProfile ?? null,
    launcherHealth:
      agentHealthSummary?.launcherHealth ??
      runtimeHealthSummary?.launcherHealth?.ok ??
      diagnosticSummary?.launcherHealth ??
      null,
    runtimeHealth:
      agentHealthSummary?.runtimeHealth ??
      runtimeHealthSummary?.runtimeHealth ??
      diagnosticSummary?.runtimeHealth ??
      null,
    localHelperReady: diagnosticSummary?.localHelperReady ?? null,
    lastFailure:
      agentHealthSummary?.lastFailure ?? diagnosticSummary?.lastFailure ?? null,
  };

  const raw = args.verbose
    ? { diagnostic, agentHealth, runtimeHealth }
    : undefined;
  const blockerText =
    agentSummary.blockers.length > 0
      ? ` blockers=${agentSummary.blockers.length}`
      : "";

  if (!diagnostic.ok) {
    addCheck({
      status: "fail",
      name: "agent diagnostic",
      summary:
        diagnostic.status === null
          ? `${diagnostic.url} failed (${diagnostic.error})`
          : `${diagnostic.url} returned ${diagnostic.status}`,
      details: { agent: agentSummary, raw },
    });
    return;
  }

  if (agentSummary.canChat !== true) {
    addCheck({
      status: "fail",
      name: "agent diagnostic",
      summary: `canChat=${compactJson(agentSummary.canChat)}${blockerText}`,
      details: { agent: agentSummary, raw },
    });
    return;
  }

  if (!agentHealth.ok) {
    addCheck({
      status: "fail",
      name: "agent health",
      summary:
        agentHealth.status === 401 && !args.token
          ? `${agentHealth.url} returned 401; pass --api-token or PLATFORM_API_TOKEN`
          : agentHealth.status === null
            ? `${agentHealth.url} failed (${agentHealth.error})`
            : `${agentHealth.url} returned ${agentHealth.status}`,
      details: { agent: agentSummary, raw },
    });
    return;
  }

  if (!runtimeHealth.ok) {
    addCheck({
      status: "fail",
      name: "runtime health",
      summary:
        runtimeHealth.status === null
          ? `${runtimeHealth.url} failed (${runtimeHealth.error})`
          : `${runtimeHealth.url} returned ${runtimeHealth.status}`,
      details: { agent: agentSummary, raw },
    });
    return;
  }

  addCheck({
    status: "ok",
    name: "agent",
    summary: `canChat=true runner=${compactJson(agentSummary.runnerKind)} provider=${compactJson(agentSummary.provider)}`,
    details: { agent: agentSummary, raw },
  });
}

export async function runDoctorChecks({ rootDir, args }) {
  const checks = [];
  const addCheck = createAddCheck(checks);

  checkEnv(rootDir, addCheck);
  checkDependencies(rootDir, addCheck);

  await checkApiService(args, addCheck);
  await checkService({
    name: "web",
    label: "web",
    port: 5173,
    endpoints: [],
    addCheck,
  });
  await checkService({
    name: "launcher",
    label: "launcher",
    port: 4100,
    endpoints: ["/health"],
    addCheck,
  });
  await checkService({
    name: "orchestrator",
    label: "orchestrator",
    port: 4000,
    endpoints: ["/api/v1/health"],
    addCheck,
  });

  checkLogs(rootDir, addCheck);
  await checkAgentScope(args, addCheck);

  const failed = checks.some((check) => check.status === "fail");

  return {
    status: failed ? "fail" : "ok",
    checks,
    next: failed
      ? classifyPlatformFailure(checks)
      : "ready for local platform work",
  };
}
