#!/usr/bin/env tsx
import { createServer } from "node:http";

import express from "express";

import { registerLocalObserverRoutingRoutes } from "../src/routes/local-observer-routing.js";

const model = process.env.OLLAMA_MODEL ?? "qwen3-coder:30b";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const toolMode = process.env.LOCAL_OBSERVER_TOOL_MODE ?? "prompt";

type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "requested";
};

function asOpenAiTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    type: "function",
    function: tool,
  }));
}

function promptBasedToolInstructions(tools: ToolSpec[]) {
  return [
    "Available tools:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`),
    "",
    "To call a tool, return only JSON in this exact shape:",
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    "Do not include prose, markdown, or extra keys.",
  ].join("\n");
}

async function chat(body: Record<string, unknown>) {
  const response = await fetch(`${ollamaBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${text}`);
  }
  return JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: unknown;
      };
    }>;
  };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { malformedArguments: value };
    }
  }
  return {};
}

function extractToolCalls(response: Awaited<ReturnType<typeof chat>>): ToolCall[] {
  const rawCalls = response.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(rawCalls)) return [];

  return rawCalls.flatMap((rawCall, index) => {
    if (!rawCall || typeof rawCall !== "object") return [];
    const call = rawCall as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    if (!name) return [];

    return [
      {
        id: typeof call.id === "string" ? call.id : `local-call-${index + 1}`,
        name,
        arguments: parseArguments(call.function?.arguments),
        status: "requested" as const,
      },
    ];
  });
}

function jsonCandidates(content: string) {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(content)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  candidates.push(content.trim());
  return candidates;
}

function extractPromptBasedToolCalls(response: Awaited<ReturnType<typeof chat>>): ToolCall[] {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") return [];

  for (const candidate of jsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const root = parsed as { tool_call?: unknown; toolCall?: unknown };
      const rawToolCall = root.tool_call ?? root.toolCall;
      if (!rawToolCall || typeof rawToolCall !== "object" || Array.isArray(rawToolCall)) continue;
      const toolCall = rawToolCall as { name?: unknown; arguments?: unknown };
      if (typeof toolCall.name !== "string" || !toolCall.name.trim()) continue;
      return [
        {
          id: `prompt-tool-call-${Date.now()}`,
          name: toolCall.name.trim(),
          arguments: parseArguments(toolCall.arguments),
          status: "requested",
        },
      ];
    } catch {
      continue;
    }
  }

  return [];
}

async function toolChat(input: { system: string; prompt: string; tools: ToolSpec[] }) {
  if (toolMode === "native") {
    const response = await chat({
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      tools: asOpenAiTools(input.tools),
      tool_choice: "auto",
      temperature: 0,
    });
    return {
      response,
      toolCalls: extractToolCalls(response),
    };
  }

  const response = await chat({
    model,
    messages: [
      { role: "system", content: input.system },
      {
        role: "user",
        content: [input.prompt, "", promptBasedToolInstructions(input.tools)].join("\n"),
      },
    ],
    temperature: 0,
  });
  return {
    response,
    toolCalls: extractPromptBasedToolCalls(response),
  };
}

async function postJson<T>(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function startLocalApi() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerLocalObserverRoutingRoutes(app);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve local API smoke address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const availableTools: ToolSpec[] = [
  {
    name: "dispatch_runner",
    description: "Dispatch a runner for follow-up implementation work when a PR still has actionable unresolved work.",
    parameters: {
      type: "object",
      properties: {
        runner_kind: {
          type: "string",
          description: "Runner to dispatch, such as codex or claude_code.",
        },
        intent: { type: "string", description: "What the runner should do." },
        reason: { type: "string", description: "Why a runner is needed." },
      },
      required: ["runner_kind", "intent", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_done",
    description: "Mark the PR observation done when no further runner should be started.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why no further action is needed." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate when the decision requires human policy or product judgment.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

const resolvedPrSnapshot = {
  kind: "pull_request",
  provider: "github",
  locator: { repository: "kmgrassi/OpenMacaw", number: 359 },
  version: "local-smoke",
  title: "Add local observer remediation proposals",
  summary: "The PR adds a remediation proposal endpoint for observer judgments.",
  state: {
    status: "open",
    checks: [{ name: "api", status: "passed" }],
    unresolved_review_comments: 0,
  },
  signals: ["review feedback addressed", "tests passed", "no unresolved comments"],
};

function actingPrompt() {
  return [
    "You are a local routing agent. Use the available tools normally.",
    "Choose the best tool for this PR state.",
    "If no follow-up run is needed, call mark_done.",
    "If implementation or review work is still needed, call dispatch_runner.",
    "Do not write prose when a tool call is appropriate.",
    "",
    "PR snapshot:",
    JSON.stringify(resolvedPrSnapshot, null, 2),
  ].join("\n");
}

async function runLiveAgentTrace(baseUrl: string) {
  const acting = await toolChat({
    system: "You are a local model being tested for tool selection quality.",
    prompt: actingPrompt(),
    tools: availableTools,
  });
  const actingToolCalls = acting.toolCalls;
  if (actingToolCalls.length === 0) {
    throw new Error("Local acting agent did not call a tool");
  }

  const trace = {
    traceId: `local-agent-smoke-${Date.now()}`,
    actingAgent: { role: "routing", provider: "ollama", model },
    task: "Decide whether a PR with no unresolved comments needs another runner.",
    artifactSnapshot: resolvedPrSnapshot,
    workspacePolicy: { preferCheapObservation: true, avoidUnnecessaryCloudRuns: true },
    availableTools,
    promptSummary: "Local agent saw a PR whose review feedback was addressed and checks passed.",
    modelResponse: acting.response.choices?.[0]?.message?.content ?? "",
    toolCalls: actingToolCalls,
    outcome: {
      smokeOnly: true,
      expectedHighLevelBehavior: "mark_done unless the trace identifies unresolved work",
    },
  };

  const rendered = await postJson<{
    prompt: string;
    evaluationTool: ToolSpec;
  }>(baseUrl, "/api/evals/local-observer-routing/render-evaluation-prompt", {
    trace,
    evaluator: { role: "observer", provider: "ollama", model },
    rubric: [
      "Judge whether the local routing agent selected the right manager tool.",
      "For this fixture, review feedback is addressed and checks passed, so unnecessary runner dispatch is likely wrong.",
      "Accept defensible edge-case reasoning if the trace supports it.",
    ],
  });

  const evaluator = await toolChat({
    system: "You are an evaluator agent. You must call the provided observer tool with your judgment.",
    prompt: rendered.prompt,
    tools: [rendered.evaluationTool],
  });
  const evaluatorToolCalls = evaluator.toolCalls;
  const judgment = evaluatorToolCalls.find((call) => call.name === "observer_record_evaluation")?.arguments;
  if (!judgment) {
    throw new Error("Local evaluator did not call observer_record_evaluation");
  }

  const review = await postJson<{
    accepted: boolean;
    judgment: null | { verdict: string };
  }>(baseUrl, "/api/evals/local-observer-routing/review-evaluation", {
    trace,
    judgment,
  });

  return {
    actingToolCalls,
    evaluatorToolCalls,
    review,
  };
}

async function runNegativeControl(baseUrl: string) {
  const badTrace = {
    traceId: `local-remediation-negative-${Date.now()}`,
    actingAgent: { role: "routing", provider: "ollama", model: "weaker-local-model" },
    task: "Decide whether a PR with no unresolved comments needs another runner.",
    artifactSnapshot: resolvedPrSnapshot,
    workspacePolicy: { avoidUnnecessaryCloudRuns: true },
    availableTools,
    promptSummary: "Negative control: no unresolved work remains.",
    toolCalls: [
      {
        name: "dispatch_runner",
        arguments: { runner_kind: "codex", intent: "address_review" },
        status: "completed",
      },
    ],
    outcome: { smokeOnly: true, cloudRunStarted: true },
  };

  const rendered = await postJson<{
    prompt: string;
    evaluationTool: ToolSpec;
  }>(baseUrl, "/api/evals/local-observer-routing/render-evaluation-prompt", {
    trace: badTrace,
    evaluator: { role: "observer", provider: "ollama", model },
    rubric: [
      "For this fixture no unresolved work remains.",
      "A dispatch_runner call is likely wasteful unless the trace gives a compelling reason.",
      "Judge based on the trace, not a fixed target enum.",
    ],
  });

  const evaluator = await toolChat({
    system: "You are an evaluator agent. You must call the observer tool with your judgment.",
    prompt: rendered.prompt,
    tools: [rendered.evaluationTool],
  });
  const evaluatorToolCalls = evaluator.toolCalls;
  const judgment = evaluatorToolCalls.find((call) => call.name === "observer_record_evaluation")?.arguments;
  if (!judgment) {
    throw new Error("Negative-control evaluator did not call observer_record_evaluation");
  }

  const review = await postJson<{
    accepted: boolean;
    judgment: null | {
      verdict: string;
      failureModes: string[];
    };
  }>(baseUrl, "/api/evals/local-observer-routing/review-evaluation", {
    trace: badTrace,
    judgment,
  });
  if (review.judgment?.verdict !== "incorrect") {
    throw new Error(`Expected negative-control verdict incorrect, got ${review.judgment?.verdict}`);
  }

  const remediation = await postJson<{
    proposal: { shouldCreateWorkItem: boolean; remediationKind: string };
    workItemDraft: null | { title: string };
  }>(baseUrl, "/api/evals/local-observer-routing/propose-remediation", {
    workspaceId: "workspace-smoke",
    trace: badTrace,
    judgment: review.judgment,
  });
  if (!remediation.proposal.shouldCreateWorkItem || !remediation.workItemDraft) {
    throw new Error("Expected negative-control remediation work-item draft");
  }

  return {
    evaluatorToolCalls,
    review,
    remediation,
  };
}

async function main() {
  const localApi = await startLocalApi();
  try {
    const live = await runLiveAgentTrace(localApi.baseUrl);
    const negative = await runNegativeControl(localApi.baseUrl);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "passed",
          model,
          toolMode,
          apiBase: localApi.baseUrl,
          live: {
            actingToolCalls: live.actingToolCalls,
            evaluatorVerdict: live.review.judgment?.verdict ?? null,
            evaluatorAccepted: live.review.accepted,
          },
          negativeControl: {
            evaluatorVerdict: negative.review.judgment?.verdict ?? null,
            failureModes: negative.review.judgment?.failureModes ?? [],
            remediationKind: negative.remediation.proposal.remediationKind,
            workItemTitle: negative.remediation.workItemDraft?.title ?? null,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await localApi.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`local observer remediation smoke failed: ${message}\n`);
  process.exit(1);
});
