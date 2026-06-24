import { isUuid, safeJson, sleep } from "./utils.mjs";

function toolSlugFromCall(toolCall) {
  const input = safeJson(toolCall.input);
  const output = safeJson(toolCall.output);
  return (
    input?.tool_name ||
    input?.tool_slug ||
    input?.input?.name ||
    output?.output?.tool_name ||
    output?.output?.tool_slug ||
    null
  );
}

export async function createEvalRun(input) {
  const rows = await input.postgrestInsert("agent_eval_run", {
    suite_id: input.suiteId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    status: "running",
    trigger_source: "manual",
    selected_case_ids: input.selectedCaseIds,
    side_effect_limit: input.sideEffectLimit,
    artifacts_path: input.artifactsPath,
    started_at: new Date().toISOString(),
  });
  return rows[0] ?? null;
}

export async function updateEvalRun(runId, patch, postgrestPatch) {
  await postgrestPatch("agent_eval_run", { id: `eq.${runId}` }, patch);
}

export async function persistEvalRunCase(input) {
  const passedAssertions = input.assertionResults.filter(
    (assertion) => assertion.status === "passed",
  ).length;
  const failedAssertions = input.assertionResults.filter(
    (assertion) => assertion.status === "failed",
  ).length;
  const runCaseRows = await input.postgrestInsert("agent_eval_run_case", {
    run_id: input.runId,
    case_id: input.caseId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    status: input.status,
    prompt: input.prompt,
    score: input.status === "passed" ? 1 : 0,
    passed_assertions: passedAssertions,
    failed_assertions: failedAssertions,
    skipped_assertions: 0,
    observed_tool_call_count: input.observedToolCallCount,
    first_tool_call_id: input.toolCalls[0]?.id ?? null,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    duration_ms: Math.max(
      0,
      Date.parse(input.completedAt) - Date.parse(input.startedAt),
    ),
  });
  const runCase = runCaseRows[0];
  if (!runCase?.id) return null;

  if (input.assertionResults.length > 0) {
    await input.postgrestInsert(
      "agent_eval_assertion_result",
      input.assertionResults.map((assertion) => ({
        run_id: input.runId,
        run_case_id: runCase.id,
        assertion_id: isUuid(assertion.id) ? assertion.id : null,
        workspace_id: input.workspaceId,
        assertion_type: assertion.type,
        status: assertion.status,
        score: assertion.status === "passed" ? 1 : 0,
        weight: 1,
        hard_fail: true,
        explanation:
          assertion.status === "passed"
            ? "Expected tool-call assertion was satisfied."
            : "Expected tool-call assertion was not satisfied.",
        expected_text: assertion.toolSlug,
        expected_number: assertion.minCalls ?? assertion.maxCalls,
        actual_number: assertion.observedCallCount,
        expected_json: {
          toolSlug: assertion.toolSlug,
          minCalls: assertion.minCalls,
          maxCalls: assertion.maxCalls,
          argumentHints: assertion.argumentHints,
        },
        actual_json: {
          observedToolSlugs: assertion.observedToolSlugs,
          observedCallCount: assertion.observedCallCount,
        },
      })),
    );
  }

  if (input.toolCalls.length > 0) {
    await input.postgrestInsert(
      "agent_eval_observation",
      input.toolCalls.map((toolCall, index) => ({
        run_id: input.runId,
        run_case_id: runCase.id,
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        observation_type: "tool_call_observed",
        evidence_kind: "tool_call",
        evidence_table: "tool_call",
        evidence_id: isUuid(toolCall.id) ? toolCall.id : null,
        call_id: toolCall.id ?? null,
        tool_slug: toolCall.toolSlug,
        sequence: index,
        arguments: toolCall.input,
        result: toolCall.output,
        passed: true,
        message_id: isUuid(toolCall.messageId) ? toolCall.messageId : null,
        tool_call_id: isUuid(toolCall.id) ? toolCall.id : null,
      })),
    );
  }

  return runCase.id;
}

export async function waitForToolEvidence(input) {
  if (input.expectedToolSlugs.length === 0) {
    await sleep(Math.min(input.timeoutMs, 5_000));
    return loadToolEvidence(input, input.postgrestGet);
  }

  const deadline = Date.now() + input.timeoutMs;
  let latest = { messages: [], observedToolSlugs: [] };

  while (Date.now() < deadline) {
    latest = await loadToolEvidence(input, input.postgrestGet);
    if (
      input.expectedToolSlugs.every((slug) =>
        latest.observedToolSlugs.includes(slug),
      )
    ) {
      return latest;
    }
    await sleep(2_000);
  }

  return latest;
}

export async function loadToolEvidence(
  { agentId, workspaceId, startedAt },
  postgrestGet,
) {
  const messages = await postgrestGet("message", {
    select: "id,role,created_at,run_id,content",
    agent_id: `eq.${agentId}`,
    workspace_id: `eq.${workspaceId}`,
    deleted_at: "is.null",
    created_at: `gte.${startedAt.toISOString()}`,
    order: "created_at.desc",
    limit: "30",
  });
  const messageIds = messages.map((message) => message.id).filter(Boolean);
  const toolCallRows =
    messageIds.length === 0
      ? []
      : await postgrestGet("tool_call", {
          select: "id,message_id,tool_id,input,output,created_at",
          message_id: `in.(${messageIds.join(",")})`,
          order: "created_at.desc",
          limit: "100",
        });
  const messageById = new Map(messages.map((message) => [message.id, message]));

  const toolCalls = toolCallRows.map((toolCall) => {
    const message = messageById.get(toolCall.message_id) ?? {};
    return {
      id: toolCall.id,
      messageId: toolCall.message_id,
      runId: message.run_id,
      createdAt: toolCall.created_at,
      toolSlug: toolSlugFromCall(toolCall),
      input: safeJson(toolCall.input),
      output: safeJson(toolCall.output),
    };
  });
  const observedToolSlugs = Array.from(
    new Set(toolCalls.map((call) => call.toolSlug).filter(Boolean)),
  ).sort();

  return {
    observedToolSlugs,
    toolCalls,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      createdAt: message.created_at,
      runId: message.run_id,
      contentPreview:
        typeof message.content === "string"
          ? message.content.slice(0, 500)
          : "",
    })),
  };
}
