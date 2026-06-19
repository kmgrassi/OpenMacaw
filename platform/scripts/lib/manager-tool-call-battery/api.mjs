import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  waitForGatewayEvent as waitForGatewayEventFrame,
  waitForGatewayHello as waitForGatewayHelloFrame,
  waitForGatewayResponse as waitForGatewayResponseFrame,
  waitForSocketOpen as waitForSocketReady,
} from "../gateway-ws.mjs";
import {
  isUuid,
  normalizeUrl,
  parseResponse,
  requireValue,
  safeJson,
  sanitizeForArtifact,
  sleep,
} from "./utils.mjs";

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

export async function resolveAccessToken(args) {
  if (args.token) return args.token;

  const supabaseUrl = requireValue(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_DEV_URL,
    "SUPABASE_URL",
  );
  const envName = (process.env.VITE_SUPABASE_ENV || "dev").trim();
  const anonKey =
    envName === "prod"
      ? process.env.VITE_SUPABASE_PROD_ANON_KEY ||
        process.env.VITE_SUPABASE_DEV_ANON_KEY
      : process.env.VITE_SUPABASE_DEV_ANON_KEY ||
        process.env.VITE_SUPABASE_PROD_ANON_KEY;
  const email =
    process.env.OPENMACAW_TEST_EMAIL ||
    (envName === "prod"
      ? process.env.VITE_PROD_LOGIN_EMAIL
      : process.env.VITE_DEV_LOGIN_EMAIL);
  const password =
    process.env.OPENMACAW_TEST_PASSWORD ||
    (envName === "prod"
      ? process.env.VITE_PROD_LOGIN_PASSWORD
      : process.env.VITE_DEV_LOGIN_PASSWORD);

  requireValue(anonKey, "VITE_SUPABASE_DEV_ANON_KEY or --api-token");
  requireValue(
    email,
    "VITE_DEV_LOGIN_EMAIL/OPENMACAW_TEST_EMAIL or --api-token",
  );
  requireValue(
    password,
    "VITE_DEV_LOGIN_PASSWORD/OPENMACAW_TEST_PASSWORD or --api-token",
  );

  const response = await fetch(
    `${normalizeUrl(supabaseUrl)}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await parseResponse(response);
  if (!response.ok || !body.access_token) {
    throw new Error(`Supabase sign-in failed (${response.status})`);
  }
  return body.access_token;
}

export async function sendBrowserGatewayMessage(input) {
  const startedAt = new Date().toISOString();
  const preparation = sanitizeForArtifact(await prepareRuntime(input));
  const requestId = `battery-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const events = [];

  const ws = await openBrowserGatewaySocket(input, events);
  try {
    const responsePromise = waitForGatewayResponse(
      ws,
      requestId,
      input.timeoutMs,
      events,
    );
    const eventPromise = waitForGatewayEvent(ws, input.timeoutMs, events);

    ws.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method: "chat.send",
        params: {
          agent_id: input.agentId,
          workspace_id: input.workspaceId,
          sessionKey: input.sessionKey,
          message: input.message,
          deliver: false,
          idempotencyKey,
        },
      }),
    );

    const response = await responsePromise;
    const runId = response?.runId ?? idempotencyKey;
    const observedEvent = await eventPromise;
    return {
      status: observedEvent?.status ?? "message_accepted",
      requestId,
      runId,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: observedEvent?.errorCode ?? null,
      errorMessage: observedEvent?.errorMessage ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      requestId,
      runId: idempotencyKey,
      preparation,
      events,
      startedAt,
      completedAt: new Date().toISOString(),
      errorCode: "gateway_message_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    ws.close(1000, "manager tool battery complete");
  }
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

export async function postgrestGet(table, params) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await parseResponse(response);
  if (!response.ok)
    throw new Error(
      `PostgREST ${table} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  return body;
}

export async function postgrestInsert(table, value) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const response = await fetch(
    `${normalizeUrl(supabaseUrl)}/rest/v1/${table}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify(value),
    },
  );
  const body = await parseResponse(response);
  if (!response.ok)
    throw new Error(
      `PostGREST ${table} insert failed (${response.status}): ${JSON.stringify(body)}`,
    );
  return Array.isArray(body) ? body : [];
}

export async function postgrestPatch(table, params, value) {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, paramValue] of Object.entries(params)) {
    url.searchParams.set(key, paramValue);
  }
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
  const body = await parseResponse(response);
  if (!response.ok)
    throw new Error(
      `PostGREST ${table} patch failed (${response.status}): ${JSON.stringify(body)}`,
    );
  return body;
}

async function prepareRuntime(input) {
  const response = await fetch(
    `${input.apiBaseUrl}/api/agents/${encodeURIComponent(input.agentId)}/start`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: input.workspaceId }),
    },
  );
  const parsed = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `Runtime prepare failed (${response.status}): ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

async function openBrowserGatewaySocket(input, events) {
  const url = new URL("/ws", input.apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agent_id", input.agentId);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("session_key", input.sessionKey);

  const ws = new WebSocket(url, ["platform.v1", `bearer.${input.token}`]);
  await waitForSocketOpen(ws, input.timeoutMs);
  await sendBrowserGatewayConnect(ws, input, events);
  return ws;
}

function waitForSocketOpen(ws, timeoutMs) {
  return waitForSocketReady(ws, { timeoutMs });
}

async function sendBrowserGatewayConnect(ws, input, events) {
  const connectId = `battery-connect-${randomUUID()}`;
  const responsePromise = waitForGatewayHello(
    ws,
    connectId,
    input.timeoutMs,
    events,
  );
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-control-ui",
          version: "app-0.1",
          platform: "node",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
        caps: [],
        auth: { token: input.token },
        userAgent: `node/${process.version}`,
        locale: "en-US",
      },
    }),
  );
  await responsePromise;
}

function waitForGatewayHello(ws, requestId, timeoutMs, events) {
  return waitForGatewayHelloFrame({
    ws,
    requestId,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
  });
}

function waitForGatewayResponse(ws, requestId, timeoutMs, events) {
  return waitForGatewayResponseFrame({
    ws,
    requestId,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
  });
}

function waitForGatewayEvent(ws, timeoutMs, events) {
  return waitForGatewayEventFrame({
    ws,
    timeoutMs,
    parseFrame: safeJson,
    onFrame: (frame) => rememberGatewayFrame(events, frame),
    fallbackResult: () => ({
      status: "message_accepted",
      errorCode: null,
      errorMessage: null,
    }),
    onFrameResult: (frame) => {
      if (frame?.type !== "event") return undefined;
      const payload =
        frame.payload && typeof frame.payload === "object" ? frame.payload : {};
      const errorCode =
        typeof payload.errorCode === "string" ? payload.errorCode : null;
      const errorMessage =
        typeof payload.errorMessage === "string" ? payload.errorMessage : null;
      const eventName = typeof frame.event === "string" ? frame.event : null;
      if (
        !errorCode &&
        !errorMessage &&
        eventName !== "chat.completed" &&
        eventName !== "run.completed"
      ) {
        return undefined;
      }
      return {
        status: errorCode || errorMessage ? "failed" : "completed",
        errorCode,
        errorMessage,
      };
    },
  });
}

function rememberGatewayFrame(events, frame) {
  if (!frame || typeof frame !== "object") return;
  events.push({
    type: typeof frame.type === "string" ? frame.type : null,
    id: typeof frame.id === "string" ? frame.id : null,
    event: typeof frame.event === "string" ? frame.event : null,
    ok: typeof frame.ok === "boolean" ? frame.ok : null,
    payloadKeys:
      frame.payload &&
      typeof frame.payload === "object" &&
      !Array.isArray(frame.payload)
        ? Object.keys(frame.payload).sort()
        : [],
    payload:
      frame.payload &&
      typeof frame.payload === "object" &&
      !Array.isArray(frame.payload)
        ? sanitizeForArtifact(frame.payload)
        : null,
    error: frame.error ?? null,
  });
}

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
