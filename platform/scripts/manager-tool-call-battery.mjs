#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, printHelp } from "./lib/manager-tool-call-battery/args.mjs";
import {
  createEvalRun,
  loadManagerRuntimePreflight,
  loadResolvedTools,
  loadToolEvidence,
  persistEvalRunCase,
  postgrestGet,
  postgrestInsert,
  postgrestPatch,
  resolveAccessToken,
  sendBrowserGatewayMessage,
  updateEvalRun,
  waitForToolEvidence,
} from "./lib/manager-tool-call-battery/api.mjs";
import {
  evaluateAssertions,
  loadEvalCatalogBattery,
  mergeToolEvidence,
  normalizeBattery,
  selectCases,
  toolEvidenceFromGatewayEvents,
} from "./lib/manager-tool-call-battery/battery.mjs";
import { printResult } from "./lib/manager-tool-call-battery/format.mjs";
import { loadEnvFile, normalizeUrl, readJson, renderTemplate, requireValue, writeJson } from "./lib/manager-tool-call-battery/utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2), __dirname);

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(JSON.stringify({ status: "failed", error: message }, null, 2));
  } else {
    console.error(`manager tool battery failed: ${message}`);
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  loadEnvFile(path.join(platformRoot, ".env"));
  loadEnvFile(path.join(platformRoot, "apps/api/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env.local"));

  const battery = args.suiteSlug
    ? await loadEvalCatalogBattery(args.suiteSlug, postgrestGet)
    : normalizeBattery(await readJson(args.batteryPath));
  const agentId = args.agentId ?? battery.agentId;
  const workspaceId = args.workspaceId ?? battery.workspaceId;
  const apiBaseUrl = normalizeUrl(args.apiBaseUrl ?? battery.apiBaseUrl ?? "http://127.0.0.1:3100");
  const selectedCases = selectCases(battery, args);

  requireValue(agentId, "agentId");
  requireValue(workspaceId, "workspaceId");
  const expectedToolSlugs = expectedToolSlugsForCases(selectedCases);
  const runtimePreflightMode = args.suiteSlug === "local-tool-calling" ? "local_tool_calling" : "manager";

  if (!args.run) {
    const tools = await loadResolvedTools({ agentId, workspaceId, postgrestGet });
    const runtimePreflight = await loadManagerRuntimePreflight({
      agentId,
      workspaceId,
      expectedToolSlugs,
      mode: runtimePreflightMode,
      postgrestGet,
    });
    printResult(
      {
        mode: "dry-run",
        agentId,
        workspaceId,
        apiBaseUrl,
        runtimePreflight,
        resolvedTools: tools.map((tool) => ({
          slug: tool.slug,
          name: tool.name,
          executionKind: tool.execution_kind,
          runnerKind: tool.runner_kind,
        })),
        selectedCases: selectedCases.map((testCase) => ({
          id: testCase.id,
          enabled: testCase.enabled !== false,
          expectedToolSlugs: testCase.expectedToolSlugs,
          prohibitedToolSlugs: testCase.prohibitedToolSlugs,
          assertions: testCase.assertions.map((assertion) => ({
            type: assertion.type,
            toolSlug: assertion.toolSlug,
            minCalls: assertion.minCalls,
            maxCalls: assertion.maxCalls,
          })),
        })),
        note: "Pass --run to send prompts. Disabled cases require --include-disabled or --case <id>.",
      },
      args,
    );
    return;
  }

  const token = await resolveAccessToken(args);
  const artifactDir = path.join(
    platformRoot,
    ".run-artifacts",
    "manager-tool-call-battery",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(artifactDir, { recursive: true });
  const runtimePreflight = await loadManagerRuntimePreflight({
    agentId,
    workspaceId,
    expectedToolSlugs,
    mode: runtimePreflightMode,
    postgrestGet,
  });
  await writeJson(path.join(artifactDir, "runtime-preflight.json"), runtimePreflight);
  if (runtimePreflight.status !== "passed") {
    throw new Error(
      `Manager runtime preflight failed: ${runtimePreflight.failures.join("; ")}`,
    );
  }
  const evalRun = battery.databaseSuiteId
    ? await createEvalRun({
        suiteId: battery.databaseSuiteId,
        workspaceId,
        agentId,
        selectedCaseIds: selectedCases.map((testCase) => testCase.databaseId).filter(Boolean),
        sideEffectLimit: args.includeDisabled ? "safe_write" : "read_only",
        artifactsPath: artifactDir,
        postgrestInsert,
      })
    : null;

  const results = [];
  for (const testCase of selectedCases) {
    results.push(
      await runCase({
        testCase,
        agentId,
        workspaceId,
        apiBaseUrl,
        token,
        artifactDir,
        defaultWaitMs: battery.defaultWaitMs ?? 30_000,
        defaultTimeoutMs: battery.defaultTimeoutMs ?? 90_000,
        evalRunId: evalRun?.id ?? null,
      }),
    );
  }

  const passed = results.every((result) => result.status === "passed");
  const output = {
    status: passed ? "passed" : "failed",
    agentId,
    workspaceId,
    apiBaseUrl,
    artifactDir,
    runtimePreflight,
    results,
  };
  await writeJson(path.join(artifactDir, "result.json"), output);
  if (evalRun) {
    const passedCases = results.filter((result) => result.status === "passed").length;
    const failedCases = results.filter((result) => result.status === "failed").length;
    await updateEvalRun(
      evalRun.id,
      {
        status: passed ? "passed" : "failed",
        score: passed ? 1 : 0,
        total_cases: results.length,
        passed_cases: passedCases,
        failed_cases: failedCases,
        skipped_cases: 0,
        error_cases: 0,
        summary_text: `Local tool-calling eval ${passed ? "passed" : "failed"}: ${passedCases}/${results.length} cases passed.`,
        completed_at: new Date().toISOString(),
      },
      postgrestPatch,
    );
  }
  printResult(output, args);
  process.exitCode = passed ? 0 : 1;
}

async function runCase(input) {
  const startedAt = new Date();
  const sessionKey = `agent:${input.agentId}:tool-battery:${input.testCase.id}:${randomUUID()}`;
  const message = renderTemplate(input.testCase.prompt, {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    timestamp: startedAt.toISOString().replace(/[:.]/g, "-"),
    futureIso: new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
    scheduledTaskId: process.env.SCHEDULED_TASK_ID ?? "{{scheduledTaskId}}",
    workItemId: process.env.WORK_ITEM_ID ?? "{{workItemId}}",
  });

  const caseDir = path.join(input.artifactDir, input.testCase.id);
  await mkdir(caseDir, { recursive: true });
  await writeJson(path.join(caseDir, "input.json"), {
    id: input.testCase.id,
    prompt: message,
    expectedToolSlugs: input.testCase.expectedToolSlugs,
    sessionKey,
    startedAt: startedAt.toISOString(),
  });

  const gateway = await sendBrowserGatewayMessage({
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    sessionKey,
    message,
    timeoutMs: input.testCase.waitMs ?? input.defaultWaitMs,
  });
  await writeJson(path.join(caseDir, "gateway-response.json"), gateway);

  const runtimeFailure =
    gateway.status === "failed"
      ? {
          errorCode: gateway.errorCode ?? null,
          errorMessage: gateway.errorMessage ?? null,
        }
      : null;
  const dbEvidence =
    runtimeFailure == null
      ? await waitForToolEvidence({
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          startedAt,
          expectedToolSlugs: input.testCase.expectedToolSlugs,
          timeoutMs: input.testCase.timeoutMs ?? input.defaultTimeoutMs,
          postgrestGet,
        })
      : await loadToolEvidence(
          {
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            startedAt,
          },
          postgrestGet,
        );
  const evidence = mergeToolEvidence(dbEvidence, toolEvidenceFromGatewayEvents(gateway.events));
  await writeJson(path.join(caseDir, "evidence.json"), evidence);

  const assertionResults = evaluateAssertions(input.testCase.assertions, evidence);
  const missing = assertionResults
    .filter((result) => result.status === "failed" && result.type !== "no_tool_call")
    .flatMap((result) => (result.toolSlug ? [result.toolSlug] : []));
  const unexpected = assertionResults
    .filter((result) => result.status === "failed" && result.type === "no_tool_call")
    .flatMap((result) => result.observedToolSlugs);
  const passed = assertionResults.every((result) => result.status === "passed");
  const result = {
    id: input.testCase.id,
    status: passed && runtimeFailure == null ? "passed" : "failed",
    expectedToolSlugs: input.testCase.expectedToolSlugs,
    prohibitedToolSlugs: input.testCase.prohibitedToolSlugs,
    observedToolSlugs: evidence.observedToolSlugs,
    missingToolSlugs: missing,
    unexpectedToolSlugs: Array.from(new Set(unexpected)).sort(),
    assertions: assertionResults,
    messageId: null,
    runId: gateway.runId ?? null,
    requestId: gateway.requestId ?? null,
    runtimeFailure,
    artifactDir: caseDir,
  };
  if (input.evalRunId && input.testCase.databaseId) {
    result.evalRunCaseId = await persistEvalRunCase({
      runId: input.evalRunId,
      caseId: input.testCase.databaseId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      status: result.status,
      prompt: message,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      observedToolCallCount: evidence.toolCalls.length,
      assertionResults,
      toolCalls: evidence.toolCalls,
      postgrestInsert,
    });
  }
  return result;
}

function expectedToolSlugsForCases(cases) {
  return Array.from(
    new Set(
      cases.flatMap((testCase) => [
        ...testCase.expectedToolSlugs,
        ...testCase.assertions
          .map((assertion) => assertion.toolSlug)
          .filter(Boolean),
      ]),
    ),
  ).sort();
}
