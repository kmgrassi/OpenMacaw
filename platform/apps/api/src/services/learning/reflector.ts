import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { deriveProviderFromModel, extractPrimaryModel } from "../../../../../contracts/agent-helpers.js";
import { ModelSettingsSchema } from "../../../../../contracts/agents.js";
import type { MemoryItem, MemoryWriteRequest } from "../../../../../contracts/memory-items.js";
import { MemoryWriteRequestSchema } from "../../../../../contracts/memory-items.js";
import { firstGatewayRunner } from "../execution-profile-resolver.js";
import { ApiRouteError } from "../../http.js";
import { errorMessage, logEvent } from "../../logger.js";
import { insertMemoryItem, listMemoryItemsForWorkspace } from "../../repositories/memory-items.js";
import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";

const MAX_GENERAL_MEMORIES_PER_RUN = 5;
const MAX_OPERABILITY_MEMORIES_PER_RUN = 2;
const MAX_MEMORIES_PER_RUN = MAX_GENERAL_MEMORIES_PER_RUN + MAX_OPERABILITY_MEMORIES_PER_RUN;
const MAX_MEMORY_CONTENT_LENGTH = 1024;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const TOOL_FAILURE_STATUSES = new Set(["error", "failed", "denied"]);
const TOOL_FAILURE_APPROVAL_STATES = new Set(["denied", "rejected", "expired"]);

const ReflectionCandidateSchema = z.object({
  content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
  importance: z.number().int().min(1).max(10),
  tags: z.record(z.string(), z.unknown()).default({}),
});

const ReflectionResponseSchema = z.object({
  memories: z.array(ReflectionCandidateSchema).max(MAX_MEMORIES_PER_RUN),
});

type ReflectionCandidate = z.infer<typeof ReflectionCandidateSchema>;

type BrokerRunRow = {
  run_id: string;
  agent_id: string;
  workspace_id: string | null;
  input: unknown;
  output: unknown;
  metadata: unknown;
  completed_at: string | null;
  updated_at: string;
};

type AgentRow = {
  id: string;
  workspace_id: string;
  model_settings: unknown;
};

type GatewayConfigRow = {
  config_json: unknown;
};

type MessageRow = {
  id: string;
  role: string;
  content: string | null;
  payload: unknown;
  created_at: string;
};

type ToolCallEventRow = {
  tool_slug: string;
  status: string;
  arguments: unknown;
  result: unknown;
  output_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  approval_state: string | null;
  started_at: string | null;
};

type CredentialRow = {
  key_value: unknown;
  kind: string;
};

type LearningReflectorClients = {
  generateReflection: (input: {
    model: string;
    provider: string;
    apiKey: string;
    endpoint: string | null;
    systemPrompt: string;
    transcript: string;
  }) => Promise<unknown>;
  createEmbedding: (input: {
    provider: string;
    apiKey: string;
    endpoint: string | null;
    model: string;
    input: string;
  }) => Promise<string | null>;
  insertMemory: (input: MemoryWriteRequest) => Promise<MemoryItem>;
};

export type ReflectRunResult = {
  sourceRunId: string;
  workspaceId: string;
  agentId: string;
  candidatesGenerated: number;
  memoriesWritten: number;
  memoryIds: string[];
};

function serviceSupabase() {
  return getServiceRoleSupabase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeModelName(model: string) {
  return model.includes("/") ? (model.split("/").pop() ?? model) : model;
}

function vectorLiteral(values: unknown): string | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length !== values.length) return null;
  return `[${numbers.join(",")}]`;
}

function extractContent(row: MessageRow) {
  if (row.content?.trim()) return row.content.trim();
  const payload = asRecord(row.payload);
  const payloadContent = payload.content;
  if (typeof payloadContent === "string" && payloadContent.trim()) return payloadContent.trim();
  return JSON.stringify(payload);
}

function formatTranscript(rows: MessageRow[]) {
  return rows
    .map((row) => {
      const role = row.role || "unknown";
      return `${role.toUpperCase()} [${row.created_at}]\n${extractContent(row)}`;
    })
    .join("\n\n---\n\n");
}

function shapeOnly(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "[nested]";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [shapeOnly(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, shapeOnly(nested, depth + 1)]),
    );
  }
  return typeof value;
}

function hasToolFailure(row: ToolCallEventRow) {
  const status = row.status.toLowerCase();
  const approvalState = row.approval_state?.toLowerCase() ?? "";
  return (
    TOOL_FAILURE_STATUSES.has(status) ||
    TOOL_FAILURE_APPROVAL_STATES.has(approvalState) ||
    Boolean(row.error_code) ||
    Boolean(row.error_message)
  );
}

function formatToolCallSummary(rows: ToolCallEventRow[]) {
  if (rows.length === 0) return "No structured tool-call events were recorded for this run.";
  return rows
    .map((row, index) => {
      const fields = [
        `tool_slug: ${row.tool_slug}`,
        `status: ${row.status}`,
        row.approval_state ? `approval_state: ${row.approval_state}` : null,
        row.error_code ? `error_code: ${row.error_code}` : null,
        row.error_message ? `error_message: ${row.error_message}` : null,
        row.output_summary ? `output_summary: ${row.output_summary}` : null,
        `argument_shape: ${JSON.stringify(shapeOnly(row.arguments))}`,
        `result_shape: ${JSON.stringify(shapeOnly(row.result))}`,
      ].filter((field): field is string => Boolean(field));
      return `TOOL CALL ${index + 1} [${row.started_at ?? "time_unknown"}]\n${fields.join("\n")}`;
    })
    .join("\n\n---\n\n");
}

function formatReflectionInput(input: { messages: MessageRow[]; toolCallEvents: ToolCallEventRow[] }) {
  const transcript =
    input.messages.length > 0 ? formatTranscript(input.messages) : "No chat transcript messages were recorded.";
  return `CHAT TRANSCRIPT\n${transcript}\n\n===\n\nSTRUCTURED TOOL-CALL EVENTS\n${formatToolCallSummary(input.toolCallEvents)}`;
}

function extractJsonObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new ApiRouteError(502, "reflection_response_invalid", "Reflection model did not return JSON");
  }
}

function credentialSecret(row: CredentialRow | null) {
  const keyValue = asRecord(row?.key_value);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "api_key", "access_token"]) {
    const value = keyValue[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function credentialEndpoint(row: CredentialRow | null) {
  const endpoint = asRecord(row?.key_value).endpoint;
  return typeof endpoint === "string" && endpoint.trim() ? endpoint.trim().replace(/\/+$/, "") : null;
}

async function readReflectionPrompt() {
  const here = dirname(fileURLToPath(import.meta.url));
  return await readFile(join(here, "reflection-prompt.md"), "utf8");
}

async function loadBrokerRun(sourceRunId: string) {
  const rows = await executeSupabaseRows<BrokerRunRow>(
    "learning reflection broker_run lookup",
    serviceSupabase()
      .from("broker_run")
      .select("run_id,agent_id,workspace_id,input,output,metadata,completed_at,updated_at")
      .eq("run_id", sourceRunId)
      .limit(1),
  );
  const run = rows[0];
  if (!run) throw new ApiRouteError(404, "broker_run_not_found", "Run was not found");
  if (!run.workspace_id) {
    throw new ApiRouteError(409, "broker_run_workspace_missing", "Run is not assigned to a workspace");
  }
  return run;
}

async function loadAgent(agentId: string, workspaceId: string) {
  const rows = await executeSupabaseRows<AgentRow>(
    "learning reflection agent lookup",
    serviceSupabase()
      .from("agent")
      .select("id,workspace_id,model_settings")
      .eq("id", agentId)
      .eq("workspace_id", workspaceId)
      .limit(1),
  );
  const agent = rows[0];
  if (!agent) throw new ApiRouteError(404, "agent_not_found", "Run agent was not found");
  return agent;
}

async function loadGatewayConfig(agentId: string) {
  const rows = await executeSupabaseRows<GatewayConfigRow>(
    "learning reflection gateway_config lookup",
    serviceSupabase()
      .from("gateway_config")
      .select("config_json")
      .eq("scope_type", "agent")
      .eq("scope_id", agentId)
      .order("version", { ascending: false })
      .limit(1),
  );
  return rows[0] ?? null;
}

async function loadRunMessages(sourceRunId: string, workspaceId: string) {
  return await executeSupabaseRows<MessageRow>(
    "learning reflection message query",
    serviceSupabase()
      .from("message")
      .select("id,role,content,payload,created_at")
      .eq("workspace_id", workspaceId)
      .eq("run_id", sourceRunId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: true }),
  );
}

async function loadRunToolCallEvents(sourceRunId: string, workspaceId: string) {
  return await executeSupabaseRows<ToolCallEventRow>(
    "learning reflection tool-call event query",
    serviceSupabase()
      .from("agent_tool_call_event" as never)
      .select("tool_slug,status,arguments,result,output_summary,error_code,error_message,approval_state,started_at")
      .eq("workspace_id", workspaceId)
      .eq("run_id", sourceRunId)
      .order("started_at", { ascending: true }),
  );
}

async function loadProviderCredential(workspaceId: string, provider: string) {
  const rows = await executeSupabaseRows<CredentialRow>(
    "learning reflection credential lookup",
    serviceSupabase()
      .from("credential")
      .select("key_value,kind")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(50),
  );
  return (
    rows.find((row) => {
      const recordProvider = asRecord(row.key_value).provider;
      return recordProvider === provider || row.kind === provider;
    }) ?? null
  );
}

async function defaultGenerateReflection(input: Parameters<LearningReflectorClients["generateReflection"]>[0]) {
  if (input.provider !== "openai" && input.provider !== "openai_compatible") {
    throw new ApiRouteError(
      501,
      "reflection_provider_unsupported",
      "Learning reflection currently supports OpenAI-compatible chat models",
    );
  }
  const baseUrl = input.endpoint ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: normalizeModelName(input.model),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.transcript },
      ],
    }),
  });
  if (!response.ok) {
    throw new ApiRouteError(
      502,
      "reflection_model_failed",
      `Reflection model request failed with status ${response.status}`,
    );
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

async function defaultCreateEmbedding(input: Parameters<LearningReflectorClients["createEmbedding"]>[0]) {
  if (input.provider !== "openai" && input.provider !== "openai_compatible") return null;
  const baseUrl = input.endpoint ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: input.input,
    }),
  });
  if (!response.ok) {
    throw new ApiRouteError(502, "embedding_model_failed", `Embedding request failed with status ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  return vectorLiteral(body.data?.[0]?.embedding);
}

function defaultClients(): LearningReflectorClients {
  return {
    generateReflection: defaultGenerateReflection,
    createEmbedding: defaultCreateEmbedding,
    insertMemory: insertMemoryItem,
  };
}

async function resolveModelConfig(agent: AgentRow) {
  const gatewayConfig = await loadGatewayConfig(agent.id);
  const runner = firstGatewayRunner(gatewayConfig?.config_json);
  const model =
    process.env.LEARNING_REFLECTION_MODEL?.trim() ||
    (typeof runner?.model === "string" && runner.model.trim()) ||
    extractPrimaryModel(ModelSettingsSchema.parse(agent.model_settings));
  if (!model) {
    throw new ApiRouteError(422, "reflection_model_missing", "No reflection model is configured for the run agent");
  }
  const provider =
    (typeof runner?.provider === "string" && runner.provider.trim()) || deriveProviderFromModel(model) || "openai";
  return { model, provider };
}

function isOperabilityCandidate(candidate: ReflectionCandidate) {
  return candidate.tags.kind === "operability" || candidate.tags.failure === "tool_call";
}

function parseReflectionCandidates(response: unknown, hasOperabilitySignal: boolean) {
  const parsed = ReflectionResponseSchema.parse(extractJsonObject(response));
  if (!hasOperabilitySignal) return parsed.memories.slice(0, MAX_GENERAL_MEMORIES_PER_RUN);

  const operability = parsed.memories.filter(isOperabilityCandidate).slice(0, MAX_OPERABILITY_MEMORIES_PER_RUN);
  const general = parsed.memories
    .filter((candidate) => !isOperabilityCandidate(candidate))
    .slice(0, MAX_GENERAL_MEMORIES_PER_RUN);
  return [...operability, ...general];
}

function memoryRequest(input: {
  run: BrokerRunRow;
  candidate: ReflectionCandidate;
  embedding: string | null;
  sourceTaskId: string | null;
}): MemoryWriteRequest {
  return MemoryWriteRequestSchema.parse({
    workspaceId: input.run.workspace_id,
    agentId: input.run.agent_id,
    scope: "run_summary",
    content: input.candidate.content.slice(0, MAX_MEMORY_CONTENT_LENGTH),
    importance: input.candidate.importance,
    eventTime: input.run.completed_at ?? input.run.updated_at,
    sourceRunId: input.run.run_id,
    sourceTaskId: input.sourceTaskId,
    tags: {
      ...input.candidate.tags,
      source: "learning_reflection",
    },
    embedding: input.embedding,
  });
}

export async function reflectRunToMemories(input: {
  sourceRunId: string;
  sourceTaskId?: string | null;
  clients?: Partial<LearningReflectorClients>;
}): Promise<ReflectRunResult> {
  const clients = { ...defaultClients(), ...input.clients };
  const run = await loadBrokerRun(input.sourceRunId);
  const workspaceId = run.workspace_id;
  if (!workspaceId) {
    throw new ApiRouteError(409, "broker_run_workspace_missing", "Run is not assigned to a workspace");
  }

  const [agent, messages, toolCallEvents, systemPrompt] = await Promise.all([
    loadAgent(run.agent_id, workspaceId),
    loadRunMessages(run.run_id, workspaceId),
    loadRunToolCallEvents(run.run_id, workspaceId),
    readReflectionPrompt(),
  ]);
  if (messages.length === 0 && toolCallEvents.length === 0) {
    logEvent({
      event: "learning_reflection_skipped",
      level: "warn",
      source_run_id: run.run_id,
      reason: "empty_transcript",
    });
    return {
      sourceRunId: run.run_id,
      workspaceId,
      agentId: run.agent_id,
      candidatesGenerated: 0,
      memoriesWritten: 0,
      memoryIds: [],
    };
  }

  const { memoryItems: existingMemories } = await listMemoryItemsForWorkspace(workspaceId, {
    sourceRunId: run.run_id,
    limit: 200,
  });
  const existingRunSummaryMemories = existingMemories.filter((memory) => memory.scope === "run_summary");
  if (existingRunSummaryMemories.length > 0) {
    const memoryIds = existingRunSummaryMemories.map((memory) => memory.id);
    logEvent({
      event: "learning_reflection_reused_existing_memories",
      source_run_id: run.run_id,
      workspace_id: workspaceId,
      agent_id: run.agent_id,
      memories_reused: memoryIds.length,
    });
    return {
      sourceRunId: run.run_id,
      workspaceId,
      agentId: run.agent_id,
      candidatesGenerated: existingRunSummaryMemories.length,
      memoriesWritten: existingRunSummaryMemories.length,
      memoryIds,
    };
  }

  const { model, provider } = await resolveModelConfig(agent);
  const credential = await loadProviderCredential(workspaceId, provider);
  const apiKey = credentialSecret(credential);
  if (!apiKey) {
    throw new ApiRouteError(
      422,
      "reflection_credential_missing",
      "No credential is available for the reflection model provider",
    );
  }
  const endpoint = credentialEndpoint(credential);
  const candidates = parseReflectionCandidates(
    await clients.generateReflection({
      model,
      provider,
      apiKey,
      endpoint,
      systemPrompt,
      transcript: formatReflectionInput({ messages, toolCallEvents }),
    }),
    toolCallEvents.some(hasToolFailure),
  );

  const embeddingModel = process.env.LEARNING_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const memoryIds: string[] = [];
  for (const candidate of candidates) {
    try {
      const embedding = await clients.createEmbedding({
        provider,
        apiKey,
        endpoint,
        model: embeddingModel,
        input: candidate.content,
      });
      const memory = await clients.insertMemory(
        memoryRequest({
          run,
          candidate,
          embedding,
          sourceTaskId: input.sourceTaskId ?? null,
        }),
      );
      memoryIds.push(memory.id);
    } catch (error) {
      logEvent({
        event: "learning_reflection_memory_write_failed",
        level: "warn",
        source_run_id: run.run_id,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  logEvent({
    event: "learning_reflection_completed",
    source_run_id: run.run_id,
    workspace_id: workspaceId,
    agent_id: run.agent_id,
    candidates_generated: candidates.length,
    memories_written: memoryIds.length,
  });

  return {
    sourceRunId: run.run_id,
    workspaceId,
    agentId: run.agent_id,
    candidatesGenerated: candidates.length,
    memoriesWritten: memoryIds.length,
    memoryIds,
  };
}
